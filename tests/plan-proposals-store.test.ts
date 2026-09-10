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
