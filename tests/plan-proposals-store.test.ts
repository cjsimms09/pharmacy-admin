import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

/**
 * One fact about one event, computed in one place.
 *
 * `plan_groups` carries four proposal columns — the class, the sentence, the source and the
 * confidence — written by `refreshProposals` when somebody presses "Look again". Nothing renders
 * them. The page recomputes from the evidence as it stands now, and `confirmProposal` recomputes
 * again before it writes a finding.
 *
 * That is not an accident and this test is what keeps it that way. The stored row is only as fresh
 * as the last refresh, while the evidence behind it moves every time the PioneerRx feed runs or a
 * payer sheet is added, so rendering the stored value puts a class on the screen that disagrees
 * with the one the Confirm button is about to record. This codebase has already paid for that once:
 * the page listed proposals computed live, `confirmProposal` read the stale column, and on a
 * register nobody had refreshed every Confirm silently refused and the page threw the refusal away.
 *
 * The same shape — work that succeeded and a record of it that said otherwise — emptied the owner's
 * Inbox onto his needs-you list on the day this was written, from a handler writing its outcome
 * into one field while the list read another. Four faults of one family in a day is enough to pin.
 *
 * So: a deliberately wrong value is written into the stored columns, and the live paths must ignore
 * it completely.
 */
let cleanup: () => void;
let store: typeof import("../src/lib/plan-proposals-store");
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  store = await import("../src/lib/plan-proposals-store");
});

after(() => cleanup?.());

/** A plan whose class the payer sheets settle outright: BIN 019158 PCN CNRX is a copay card. */
const PLAN = { id: "plan-test-1", bin: "019158", pcn: "CNRX", groupNumber: "AC20029003" };

describe("the stored proposal columns are a log, not the answer", () => {
  test("a stale stored class does not change what the page is offered", async () => {
    await db.insert(schema.planGroups).values({ ...PLAN, classification: "unknown" });

    // What the evidence actually says today.
    const fresh = (await store.planCandidates()).find((c) => c.id === PLAN.id);
    assert.ok(fresh, "the plan must be a candidate");
    assert.equal(fresh.proposed, "copay_card");
    assert.equal(fresh.proposedSource, "payer_sheet");
    assert.equal(fresh.proposedConfidence, "stated");

    /*
     * Now poison the stored row with an answer nobody would ever compute — Medicaid, read from a
     * PCN, indicated. If any live path is reading these columns instead of the evidence, the next
     * assertion is where it shows up.
     */
    await db
      .update(schema.planGroups)
      .set({ proposedClassification: "medicaid", proposedFrom: "a stale run said so", proposedSource: "pcn", proposedConfidence: "indicated" })
      .where(eq(schema.planGroups.id, PLAN.id));

    const after = (await store.planCandidates()).find((c) => c.id === PLAN.id);
    assert.equal(after?.proposed, "copay_card", "planCandidates must recompute, never read the stored class");
    assert.equal(after?.proposedSource, "payer_sheet", "and the source shown must be the one that produced the offer");
    assert.equal(after?.proposedConfidence, "stated");
  });

  test("and confirming records the recomputed finding, not the stale one", async () => {
    // The basis is what an appeal stands on a year later, so it must quote the evidence that was
    // actually in front of the decision — not whatever the last refresh happened to leave behind.
    const r = await store.confirmProposal(PLAN.id, { id: "u1", name: "Cory Simms" });
    assert.ok(r.ok, "ok" in r && r.ok ? "" : JSON.stringify(r));
    assert.equal(r.classification, "copay_card");

    const row = await db.query.planGroups.findFirst({ where: eq(schema.planGroups.id, PLAN.id) });
    assert.equal(row?.classification, "copay_card");
    assert.doesNotMatch(row?.basis ?? "", /stale run/, "the stale sentence must never become the basis");
    assert.match(row?.basis ?? "", /SS&C|copay|savings card/i, "the basis must quote the evidence that settled it");

    // The offer is spent, and every column of it is cleared — a half-cleared row is a stale row.
    assert.equal(row?.proposedClassification, null);
    assert.equal(row?.proposedSource, null);
    assert.equal(row?.proposedConfidence, null);
    assert.equal(row?.proposedFrom, null);
  });
});

/**
 * The two things that turned 481 unclassified plans into a job somebody finishes.
 *
 * 481 of the register's 491 plans carry no class, and 1,751 paid claims and $226,094.82 of
 * reimbursement sit behind that — the whole Kansas SB 20 programme blocked on it. Two facts about
 * the shape of the register were doing most of the damage, and both are pinned here.
 *
 * 1. 211 of those rows carry no PCN at all: they predate the PCN being kept, and `planLookup` still
 *    hands them every claim under their BIN and group. Every strong source here — the payer sheets,
 *    PioneerRx's plan file, the PCN patterns — is looked up by BIN *and PCN*, so nothing could
 *    propose a class for the rows holding most of the money, while their claims carried the PCN the
 *    whole time. 197 of the 211 route on exactly one PCN.
 *
 * 2. The register is keyed on the group number as well, and the group number is the employer. So one
 *    document settling one routing shows up as a dozen rows and a dozen buttons.
 */
const FALLBACK = { id: "plan-test-fallback", bin: "019158", pcn: null, groupNumber: "AC20029004" };
const WITHPCN = { id: "plan-test-withpcn", bin: "019158", pcn: "CNRX", groupNumber: "AC20029005" };

describe("a row that predates the PCN is read against the PCN its own claims carry", () => {
  before(async () => {
    await db.insert(schema.claimImports).values({ id: "imp-1", fileName: "test.csv", createdBy: "test" });
    await db.insert(schema.planGroups).values([
      { ...FALLBACK, classification: "unknown" },
      { ...WITHPCN, classification: "unknown" },
    ]);
    // Two claims on the PCN-less row's BIN and group, both routing on CNRX, and one on the row that
    // already has the PCN. Same routing, three register rows, one fact.
    await db.insert(schema.claims).values([
      { id: "c1", importId: "imp-1", rxNumber: "1", dateFilled: "2026-09-01", bin: "019158", pcn: "CNRX", groupNumber: FALLBACK.groupNumber, status: "paid", remitCents: 10_000 },
      { id: "c2", importId: "imp-1", rxNumber: "2", dateFilled: "2026-09-02", bin: "019158", pcn: "CNRX", groupNumber: FALLBACK.groupNumber, status: "paid", remitCents: 20_000 },
      { id: "c3", importId: "imp-1", rxNumber: "3", dateFilled: "2026-09-03", bin: "019158", pcn: "CNRX", groupNumber: WITHPCN.groupNumber, status: "paid", remitCents: 5_000 },
    ]);
  });

  test("the PCN-less row becomes proposable, and says where the PCN came from", async () => {
    const c = (await store.planCandidates()).find((x) => x.id === FALLBACK.id);
    assert.ok(c);
    assert.equal(c.proposed, "copay_card", "the row holds the money and was unproposable before this");
    assert.equal(c.routingPcn, "CNRX");
    assert.match(c.routingNote ?? "", /predates the PCN/);
    assert.match(c.proposedFrom ?? "", /predates the PCN/, "the borrowed routing travels with the sentence, because it is part of how the class was established");
  });

  test("money is counted where the claim will actually inherit its class, not on every row that matches", async () => {
    /*
     * "The same money down two roads" is the fault this site keeps finding, and a total printed on a
     * bulk-confirm button is the worst place for it. A claim on BIN 019158 / PCN CNRX matches both
     * the CNRX row and the PCN-less row for its BIN and group; summing per-row matches over the
     * whole register gives 4,084 claims against the 2,350 that exist. So each claim is attributed to
     * the single row `planLookup` says governs it.
     */
    const cs = await store.planCandidates();
    const total = cs.reduce((n, c) => n + c.claims, 0);
    assert.equal(total, 3, "three claims exist, so the register's rows must account for three");
    assert.equal(cs.reduce((n, c) => n + c.receivedCents, 0), 35_000);
  });

  test("one press confirms every plan the same document settles, each with its own basis", async () => {
    const groups = await store.proposalGroups();
    const g = groups.find((x) => x.bin === "019158" && x.pcn === "CNRX");
    assert.ok(g, "the PCN-less row and the row with the PCN are one routing and must be one group");
    assert.equal(g.plans.length, 2);
    assert.equal(g.claims, 3);
    assert.equal(g.receivedCents, 35_000);

    const r = await store.confirmGroup(g.key, { id: "u1", name: "Cory Simms" });
    assert.equal(r.confirmed, 2);
    assert.deepEqual(r.refused, []);
    assert.equal(r.classification, "copay_card");

    for (const id of [FALLBACK.id, WITHPCN.id]) {
      const row = await db.query.planGroups.findFirst({ where: eq(schema.planGroups.id, id) });
      assert.equal(row?.classification, "copay_card", id);
      // Each plan carries its own recorded reason, so the file reads as it would pressing them one
      // at a time — a bulk press must leave no row whose basis is "somebody pressed a button".
      assert.match(row?.basis ?? "", /019158/, id);
      assert.match(row?.basis ?? "", /Confirmed by Cory Simms/, id);
    }
    // And the one whose PCN was borrowed says so in the record, where it can be checked a year on.
    const fb = await db.query.planGroups.findFirst({ where: eq(schema.planGroups.id, FALLBACK.id) });
    assert.match(fb?.basis ?? "", /predates the PCN/);
  });

  test("a group already confirmed is no longer on offer", async () => {
    const groups = await store.proposalGroups();
    assert.equal(groups.find((x) => x.bin === "019158" && x.pcn === "CNRX"), undefined);
  });
});
