import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ProofKey, RemitMonth } from "../src/lib/engine/proofs";
import type { UntiedCause } from "../src/lib/untied-payments";

/*
 * The nightly proof that money received is applied to the claim it paid or explained. It failed every month because it asked for a
 * payment of one source to be tied to a claim and gave no reason for the ones that are not, and it sent him to a page the site retired.
 * It now judges every payment received in the month by the Payments page's own reasons, and sends him to that page; only the cash for earlier fills that
 * the site holds no claim for is counted apart.
 * Every value is invented.
 */
let judgeRemitToClaim: typeof import("../src/lib/engine/proofs").judgeRemitToClaim;
let remitToClaim: typeof import("../src/lib/engine/proofs").remitToClaim;
let writeProofs: typeof import("../src/lib/engine/proofs").writeProofs;
let proofHref: typeof import("../src/lib/engine/needs-you").proofHref;
let proofFailures: typeof import("../src/lib/engine/needs-you").proofFailures;
let untiedPayments: typeof import("../src/lib/untied-payments-store").untiedPayments;
let CAUSES: typeof import("../src/lib/untied-payments").CAUSES;
let causeInfo: typeof import("../src/lib/untied-payments").causeInfo;
let isRetired: typeof import("../src/lib/retired").isRetired;
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let newId: typeof import("../src/lib/crypto").newId;
let importId: string;
let cleanup: () => void;

const NDC = "00093000022";

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ judgeRemitToClaim, remitToClaim, writeProofs } = await import("../src/lib/engine/proofs"));
  ({ proofHref, proofFailures } = await import("../src/lib/engine/needs-you"));
  ({ untiedPayments } = await import("../src/lib/untied-payments-store"));
  ({ CAUSES, causeInfo } = await import("../src/lib/untied-payments"));
  ({ isRetired } = await import("../src/lib/retired"));
  ({ db, schema } = await import("../src/db"));
  ({ newId } = await import("../src/lib/crypto"));
  importId = newId();
  await db.insert(schema.claimImports).values({ id: importId, fileName: "the test", createdBy: "the test", periodFrom: "2026-09-01" });
});
after(() => cleanup());

const claim = (rx: string, fill: number, date: string, o: Partial<typeof import("../src/db").schema.claims.$inferInsert> = {}) => ({
  id: newId(), importId, rxNumber: rx, fillNumber: fill, dateFilled: date, ndc11: NDC, bin: "610097", pbmName: "OptumRx", status: "paid" as const, remitCents: 5_000, copayCents: 1_000, source: "transaction_report", ...o,
});
const payment = (rx: string, o: Partial<typeof import("../src/db").schema.claimPayments.$inferInsert> = {}) => ({
  id: newId(), rxNumber: rx, fillNumber: 1, dateFilled: "2026-09-05", ndc11: NDC, source: "plan", payer: "A Plan", amountCents: 4_000, receivedOn: "2026-09-20", outOfBooks: false, recordedBy: "the test", ...o,
});

const none: RemitMonth = { tied: { count: 0, cents: 0 }, untied: [], beforeBooks: { count: 0, cents: 0 }, feedFrom: "2026-09-01" };
const each = (cause: UntiedCause, amountCents: number, times = 1) => Array.from({ length: times }, () => ({ cause, amountCents }));

describe("what the proof says of a month, from what it is given", () => {
  test("a month in which every payment is tied to its claim passes, and says how many and how much", () => {
    const r = judgeRemitToClaim("2026-09", { ...none, tied: { count: 7, cents: 31_250 } });
    assert.equal(r.proof, "remit_to_claim");
    assert.equal(r.scope, "2026-09");
    assert.equal(r.passed, true);
    assert.equal(r.says, "2026-09: every payment received that month is tied to a claim. 7 payments (net $312.50) are tied to the claim each paid.");
  });

  test("one payment is a payment, not a net of payments", () => {
    const r = judgeRemitToClaim("2026-09", { ...none, tied: { count: 1, cents: 1_234 } });
    assert.equal(r.says, "2026-09: every payment received that month is tied to a claim. 1 payment ($12.34) is tied to the claim it paid.");
  });

  test("a month nothing was received in passes and says so, instead of saying that every payment is tied", () => {
    const r = judgeRemitToClaim("2026-10", none);
    assert.equal(r.passed, true);
    assert.equal(r.says, "2026-10: no payment was received that month.");
  });

  test("each cause is judged by what it asks of a person: a decision, a look or the wait for the next claims load fails the month, nothing does not", () => {
    const fails: Record<UntiedCause, boolean> = {
      fits_several: true,
      reversed_sold: true,
      no_claim_yet: true,
      other_fills_only: true,
      not_a_fill: true,
      will_attach: true,
      reversed_not_sold: false,
      cancels_out: false,
      before_feed: false,
    };
    assert.deepEqual(Object.keys(fails), [...CAUSES]);
    for (const [cause, fail] of Object.entries(fails)) {
      assert.equal(judgeRemitToClaim("2026-09", { ...none, untied: each(cause as UntiedCause, 1_000) }).passed, !fail, cause);
    }
  });
});

describe("what the proof says when something is still open", () => {
  test("six take-backs that fit two claims fail it in the Payments page's words, with what that page asks", () => {
    const r = judgeRemitToClaim("2026-09", { ...none, tied: { count: 10, cents: 50_000 }, untied: each("fits_several", -5_000, 6) });
    assert.equal(r.passed, false);
    assert.equal(
      r.says,
      "2026-09: 6 payments (net -$300.00) received that month are tied to no claim and still open. " +
        "6 payments (net -$300.00) that fit two or more claims equally. Pick the claim each one paid, on the Payments with no claim page. The site will not guess. " +
        "10 payments (net $500.00) are tied to the claim each paid.",
    );
    assert.deepEqual([r.figures.open, r.figures.openCents, r.figures.untied, r.figures.untiedCents], [6, -30_000, 6, -30_000]);
  });

  test("what needs nothing is stated beside what is open and is not counted in it", () => {
    const r = judgeRemitToClaim("2026-09", { ...none, untied: [...each("fits_several", 4_000), ...each("reversed_not_sold", 1_000), ...each("reversed_not_sold", 2_000)] });
    assert.equal(r.passed, false);
    assert.deepEqual([r.figures.open, r.figures.openCents, r.figures.untied, r.figures.untiedCents], [1, 4_000, 3, 7_000]);
    assert.match(r.says, /^2026-09: 1 payment \(\$40\.00\) received that month is tied to no claim and still open\. /);
    assert.match(r.says, /Tied to no claim and needing nothing: 2 payments \(net \$30\.00\) on claims that were reversed, none carrying a sale date\.$/);
  });

  test("a payment that will attach itself at the next claims load still fails the month: a payment already received is not yet applied", () => {
    const r = judgeRemitToClaim("2026-09", { ...none, untied: each("will_attach", 3_300) });
    assert.equal(r.passed, false);
    assert.match(r.says, /1 payment \(\$33\.00\) whose claim is on file now\. Nothing\. It attaches by itself at the next claims load\./);
  });

  test("the groups that need nothing come in the Payments page's order, each in its words, and the month passes", () => {
    const r = judgeRemitToClaim("2026-09", {
      ...none,
      tied: { count: 3, cents: 9_000 },
      untied: [...each("before_feed", 100), ...each("cancels_out", 700), ...each("cancels_out", -700), ...each("reversed_not_sold", 5_000)],
    });
    assert.equal(r.passed, true);
    assert.equal(
      r.says,
      "2026-09: every payment received that month is tied to a claim or needs nothing. 3 payments (net $90.00) are tied to the claim each paid. " +
        "Tied to no claim and needing nothing: 1 payment ($50.00) on claims that were reversed, none carrying a sale date; " +
        "2 payments (net $0.00) that are cancelled by payments of exactly the opposite amount for the same fill; " +
        "1 payment ($1.00) for a fill from before the claims feed begins on Sep 1, 2026, which the site holds no claim for.",
    );
  });

  test("payments for fills from before the books begin that the site holds no claim for are counted as cash received and are not judged", () => {
    const r = judgeRemitToClaim("2026-09", { ...none, beforeBooks: { count: 4, cents: 8_800 } });
    assert.equal(r.passed, true);
    assert.equal(
      r.says,
      "2026-09: no payment was received that month, apart from the cash for earlier fills counted separately. " +
        "Separately, 4 payments (net $88.00) are for fills from before Sep 1, 2026 that the site holds no claim for: cash received, never receivable, and not judged here.",
    );
    assert.deepEqual([r.figures.beforeBooks, r.figures.beforeBooksCents], [4, 8_800]);
    assert.match(judgeRemitToClaim("2026-09", { ...none, beforeBooks: { count: 1, cents: 100 } }).says, /Separately, 1 payment \(\$1\.00\) is for a fill from before Sep 1, 2026 that the site holds no claim for:/);
  });

  test("beside payments that are tied or need nothing, the cash counted apart is named as an exception to 'every payment', not left to be read as one", () => {
    const r = judgeRemitToClaim("2026-09", { ...none, tied: { count: 2, cents: 600 }, untied: each("cancels_out", 100), beforeBooks: { count: 3, cents: 900 } });
    assert.equal(r.passed, true);
    assert.match(r.says, /^2026-09: every payment received that month is tied to a claim or needs nothing, apart from the cash for earlier fills counted separately\. /);
  });

  test("no sentence calls a payment missing: it is tied, tied to no claim and explained, tied to no claim and open, or never received", () => {
    for (const cause of CAUSES) {
      const r = judgeRemitToClaim("2026-09", { ...none, tied: { count: 2, cents: 100 }, untied: each(cause, 500, 2), beforeBooks: { count: 1, cents: 5 } });
      assert.doesNotMatch(r.says, /missing/i, cause);
    }
  });
});

describe("the proof as the engine runs it, over the payments the site holds", () => {
  beforeEach(async () => {
    await db.delete(schema.claimPayments);
    await db.delete(schema.claims);
  });

  test("every payment tied to a claim is counted, whoever paid it, in the month it was received", async () => {
    const a = claim("920001", 1, "2026-09-05");
    const b = claim("920002", 1, "2026-09-06");
    const c = claim("920003", 1, "2026-09-07");
    await db.insert(schema.claims).values([a, b, c]);
    await db.insert(schema.claimPayments).values([
      payment("920001", { claimId: a.id, amountCents: 4_000 }),
      payment("920002", { claimId: b.id, amountCents: 1_500, source: "copay_card", payer: "A Card" }),
      payment("920003", { claimId: c.id, amountCents: 2_500, source: "mtf", payer: null, receivedOn: "2026-10-02" }),
      payment("920001", { claimId: a.id, amountCents: -500, receivedOn: "2026-09-22" }),
    ]);
    const sept = await remitToClaim("2026-09");
    assert.equal(sept.passed, true);
    assert.deepEqual([sept.figures.tied, sept.figures.tiedCents, sept.figures.untied], [3, 5_000, 0], "payments are counted, so a claim paid and then taken back in part is two");
    const oct = await remitToClaim("2026-10");
    assert.deepEqual([oct.figures.tied, oct.figures.tiedCents, oct.figures.untied], [1, 2_500, 0]);
  });

  test("a payment of any source that is tied to no claim is judged, the facilitator's too, and the failure gives the Payments page's reason", async () => {
    await db.insert(schema.claimPayments).values([payment("920010", { source: "mtf", payer: null, amountCents: 7_325, dateFilled: "2026-09-10", receivedOn: "2026-09-25" })]);
    const r = await remitToClaim("2026-09");
    assert.equal(r.passed, false);
    assert.deepEqual([r.figures.open, r.figures.openCents], [1, 7_325]);
    assert.match(r.says, /1 payment \(\$73\.25\) for a prescription with no claim on file\. Find out why no claim is on file\./);
  });

  test("a payment tied to a claim is tied whatever its fill date, and one for an earlier fill the site holds no claim for is cash received: counted apart and never judged", async () => {
    const early = claim("920020", 1, "2026-08-14");
    await db.insert(schema.claims).values([early]);
    await db.insert(schema.claimPayments).values([
      payment("920020", { claimId: early.id, dateFilled: "2026-08-14", amountCents: 3_000, receivedOn: "2026-09-12" }),
      payment("920021", { dateFilled: "2026-08-20", amountCents: 2_050, receivedOn: "2026-09-13" }),
    ]);
    const r = await remitToClaim("2026-09");
    assert.equal(r.passed, true);
    assert.deepEqual([r.figures.tied, r.figures.tiedCents, r.figures.untied, r.figures.beforeBooks, r.figures.beforeBooksCents], [1, 3_000, 0, 1, 2_050]);
    assert.equal(
      r.says,
      "2026-09: every payment received that month is tied to a claim, apart from the cash for earlier fills counted separately. 1 payment ($30.00) is tied to the claim it paid. " +
        "Separately, 1 payment ($20.50) is for a fill from before Sep 1, 2026 that the site holds no claim for: cash received, never receivable, and not judged here.",
    );
  });

  test("a payment for an earlier fill that a claim on file reads is judged like any other, and is not counted again as cash received", async () => {
    const sold = claim("920022", 1, "2026-08-28", { status: "reversed", soldOn: "2026-09-02" });
    const unsold = claim("920023", 1, "2026-08-27", { status: "reversed" });
    await db.insert(schema.claims).values([sold, unsold]);
    await db.insert(schema.claimPayments).values([
      payment("920022", { dateFilled: "2026-08-28", amountCents: 6_000, receivedOn: "2026-09-14" }),
      payment("920023", { dateFilled: "2026-08-27", amountCents: 1_500, receivedOn: "2026-09-15" }),
      payment("920024", { dateFilled: "2026-08-20", amountCents: 2_050, receivedOn: "2026-09-13" }),
    ]);
    const r = await remitToClaim("2026-09");
    assert.equal(r.passed, false);
    assert.deepEqual([r.figures.open, r.figures.openCents, r.figures.untied, r.figures.untiedCents], [1, 6_000, 2, 7_500]);
    assert.deepEqual([r.figures.beforeBooks, r.figures.beforeBooksCents], [1, 2_050]);
    assert.match(r.says, /1 payment \(\$60\.00\) received that month is tied to no claim and still open\./);
    assert.match(r.says, /Separately, 1 payment \(\$20\.50\) is for a fill from before Sep 1, 2026 that the site holds no claim for/);
  });

  test("what it calls open is what the Payments page asks about, for the same month, whatever the fill date", async () => {
    const a = claim("920040", 1, "2026-08-28", { status: "reversed", soldOn: "2026-09-02" });
    const b = claim("920041", 1, "2026-09-05", { status: "reversed", soldOn: "2026-09-06" });
    const c = claim("920042", 1, "2026-09-07");
    const d = claim("920042", 2, "2026-09-07", { remitCents: 6_000 });
    await db.insert(schema.claims).values([a, b, c, d]);
    await db.insert(schema.claimPayments).values([
      payment("920040", { dateFilled: "2026-08-28", amountCents: 6_000, receivedOn: "2026-09-14" }),
      payment("920041", { dateFilled: "2026-09-05", amountCents: 3_000, receivedOn: "2026-09-16" }),
      payment("920042", { dateFilled: "2026-09-07", fillNumber: 1, amountCents: 5_500, receivedOn: "2026-10-03" }),
      payment("920043", { dateFilled: "2026-08-20", amountCents: 2_050, receivedOn: "2026-09-13" }),
      payment("920044", { dateFilled: null, ndc11: null, fillNumber: null, amountCents: 1_000, receivedOn: "2026-09-18", source: "mtf", payer: null }),
    ]);
    const page = await untiedPayments();
    for (const month of ["2026-09", "2026-10"]) {
      const asked = page.lines.filter((l) => l.receivedOn !== null && l.receivedOn.startsWith(month) && causeInfo(l.cause, page.feedFrom).needs !== "nothing");
      const r = await remitToClaim(month);
      assert.deepEqual([r.figures.open, r.figures.openCents], [asked.length, asked.reduce((n, l) => n + l.amountCents, 0)], month);
    }
    const sept = await remitToClaim("2026-09");
    assert.ok((sept.figures.open as number) >= 2, "the earlier fill's payment and the later one's are both open");
  });

  test("every payment received in the month stands in exactly one place: tied, judged, or counted apart as cash for an earlier fill", async () => {
    const inside = claim("920070", 1, "2026-09-05");
    const early = claim("920071", 1, "2026-08-14");
    const sold = claim("920072", 1, "2026-08-28", { status: "reversed", soldOn: "2026-09-02" });
    await db.insert(schema.claims).values([inside, early, sold]);
    await db.insert(schema.claimPayments).values([
      payment("920070", { claimId: inside.id, amountCents: 4_000, receivedOn: "2026-09-20" }),
      payment("920071", { claimId: early.id, dateFilled: "2026-08-14", amountCents: 3_000, receivedOn: "2026-09-12" }),
      payment("920072", { dateFilled: "2026-08-28", amountCents: 6_000, receivedOn: "2026-09-14" }),
      payment("920073", { dateFilled: "2026-09-10", amountCents: 7_325, source: "mtf", payer: null, receivedOn: "2026-09-25" }),
      payment("920074", { dateFilled: "2026-08-20", amountCents: 2_050, receivedOn: "2026-09-13" }),
      payment("920075", { dateFilled: "2026-09-11", amountCents: 1_000, receivedOn: "2026-09-26" }),
      payment("920075", { dateFilled: "2026-09-11", amountCents: -1_000, receivedOn: "2026-09-27" }),
      payment("920076", { dateFilled: "2026-09-12", amountCents: 900, receivedOn: "2026-10-02" }),
      payment("920077", { dateFilled: "2026-09-12", amountCents: 800, receivedOn: "2026-09-21", outOfBooks: true }),
    ]);
    const received = (await db.query.claimPayments.findMany()).filter((p) => !p.outOfBooks && p.receivedOn !== null && p.receivedOn.startsWith("2026-09"));
    const r = await remitToClaim("2026-09");
    const f = r.figures as Record<"tied" | "tiedCents" | "untied" | "untiedCents" | "beforeBooks" | "beforeBooksCents" | "open" | "openCents", number>;
    assert.deepEqual([f.tied, f.tiedCents, f.untied, f.beforeBooks, f.beforeBooksCents], [2, 7_000, 4, 1, 2_050]);
    assert.deepEqual([f.open, f.openCents], [2, 13_325]);
    assert.deepEqual([f.tied + f.untied + f.beforeBooks, f.tiedCents + f.untiedCents + f.beforeBooksCents], [received.length, received.reduce((n, p) => n + p.amountCents, 0)]);
    const page = await untiedPayments();
    assert.equal(page.each.filter((e) => e.receivedOn !== null && e.receivedOn.startsWith("2026-09")).length, f.untied + f.beforeBooks, "the page lists what the proof judges and counts apart, and nothing else");
  });

  test("a payment marked out of the books is in no count, tied or not", async () => {
    const a = claim("920030", 1, "2026-09-05");
    await db.insert(schema.claims).values([a]);
    await db.insert(schema.claimPayments).values([payment("920030", { claimId: a.id, outOfBooks: true }), payment("920031", { outOfBooks: true, dateFilled: "2026-08-20" }), payment("920032", { outOfBooks: true })]);
    const r = await remitToClaim("2026-09");
    assert.deepEqual([r.figures.tied, r.figures.untied, r.figures.beforeBooks], [0, 0, 0]);
    assert.equal(r.says, "2026-09: no payment was received that month.");
  });

  test("a month is cut by the day received, its first and its last day both inside it", async () => {
    await db.insert(schema.claimPayments).values([
      payment("920050", { receivedOn: "2026-09-30", amountCents: 100 }),
      payment("920051", { receivedOn: "2026-10-01", amountCents: 200 }),
      payment("920052", { receivedOn: "2026-09-01", amountCents: 400 }),
      payment("920053", { receivedOn: "2026-08-31", amountCents: 800 }),
    ]);
    const reading = await untiedPayments();
    const [aug, sept, oct] = await Promise.all(["2026-08", "2026-09", "2026-10"].map((m) => remitToClaim(m, reading)));
    assert.deepEqual([aug.figures.untiedCents, sept.figures.untiedCents, oct.figures.untiedCents], [800, 500, 200]);
  });

  test("a payment and its take-back that come in different months cancel in both, because the reading spans the months", async () => {
    await db.insert(schema.claimPayments).values([payment("920040", { amountCents: 12_345, receivedOn: "2026-09-28" }), payment("920040", { amountCents: -12_345, receivedOn: "2026-10-03" })]);
    const reading = await untiedPayments();
    const [sept, oct] = await Promise.all([remitToClaim("2026-09", reading), remitToClaim("2026-10", reading)]);
    assert.deepEqual([sept.passed, oct.passed], [true, true]);
    assert.match(sept.says, /1 payment \(\$123\.45\) that is cancelled by a payment of exactly the opposite amount for the same fill/);
    assert.match(oct.says, /1 payment \(-\$123\.45\) that is cancelled by a payment of exactly the opposite amount for the same fill/);
  });

  test("the reading is the Payments page's, taken when none is given", async () => {
    await db.insert(schema.claimPayments).values([payment("920060", { amountCents: 6_000 }), payment("920061", { amountCents: 100, fillNumber: null, ndc11: null, dateFilled: "2026-09-18" })]);
    const given = await remitToClaim("2026-09", await untiedPayments());
    assert.deepEqual(await remitToClaim("2026-09"), given);
    assert.equal(given.passed, false);
    assert.deepEqual([given.figures.open, given.figures.openCents], [2, 6_100]);
  });
});

describe("where a failed proof sends him, and whether it reaches him in the month it fails", () => {
  /* A record, so that a proof added later is a type error here until it has been given a place. */
  const KEYS: Record<ProofKey, true> = { bank_to_cent: true, receipts_to_bank: true, claims_eq_pioneer: true, reader_arithmetic: true, remit_to_claim: true, expected_arrived: true, payments_once: true };
  const ran = (proof: ProofKey, scope: string | null, passed: boolean) => ({ proof, scope, passed, figures: {}, says: `${proof} ${scope ?? ""}` });

  beforeEach(async () => {
    await db.delete(schema.proofRun);
  });

  test("no proof sends him to a page the site has retired, which would show him one sentence saying so", () => {
    for (const key of Object.keys(KEYS)) {
      for (const scope of ["2026-09", null]) {
        const href = proofHref(key, scope);
        assert.equal(isRetired(href.split("?")[0]), false, `${key} sends him to ${href}`);
      }
    }
  });

  test("the remittance proofs go to the payments with no claim, the owed page, the claims page and the bank page", () => {
    assert.equal(proofHref("remit_to_claim", "2026-09"), "/claims/no-claim");
    assert.equal(proofHref("payments_once", null), "/payers/owed");
    assert.equal(proofHref("claims_eq_pioneer", "2026-10-04"), "/claims");
    assert.equal(proofHref("bank_to_cent", "2026-09"), "/money/bank-review?month=2026-09");
  });

  test("every address the list's own code links to is a page the site has: the lines it makes for a failed proof, a claim pot or an unclosed month open somewhere he can act", () => {
    const src = fs.readFileSync(path.join("src", "lib", "engine", "needs-you.ts"), "utf8");
    const addresses = new Set([...src.matchAll(/["`](\/[a-z][a-z0-9\-/]*)/g)].map((m) => m[1]));
    assert.ok(addresses.size >= 6, "the addresses were not found, so none was checked");
    for (const a of addresses) {
      assert.equal(isRetired(a), false, `${a} is retired`);
      assert.ok(fs.existsSync(path.join("src", "app", "(app)", a, "page.tsx")), `${a} has no page`);
    }
  });

  test("payments received this month and still open are a line now, and the bank's month is not one until it ends", async () => {
    await writeProofs([ran("remit_to_claim", "2026-10", false), ran("bank_to_cent", "2026-10", false), ran("bank_to_cent", "2026-09", false), ran("remit_to_claim", "2026-09", true)], "2026-10-05T07:00:00.000Z");
    const lines = await proofFailures("2026-10-05");
    assert.deepEqual(
      lines.map((l) => [l.id, l.href]).sort(),
      [["proof|bank_to_cent|2026-09", "/money/bank-review?month=2026-09"], ["proof|remit_to_claim|2026-10", "/claims/no-claim"]],
    );
  });

  test("only the latest run of a proof counts: one that failed last night and passed tonight is no line", async () => {
    await writeProofs([ran("remit_to_claim", "2026-09", false)], "2026-10-04T07:00:00.000Z");
    await writeProofs([ran("remit_to_claim", "2026-09", true)], "2026-10-05T07:00:00.000Z");
    assert.deepEqual(await proofFailures("2026-10-05"), []);
  });
});
