import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { owedByPayer, type Receivable, type Received } from "../src/lib/payer-owed";

/*
 * The Aytu / IPD top-off, which arrives weeks after the claim on a credit memo.
 *
 * The RxRescue claim adjudicates for the copay assistance alone, and nothing on it says how much top-off is coming — the
 * fill can say one is due, never how much. So the memo pays the claim's own share and then more, and that more was never
 * billed to anybody. Counting it as an overpayment would put every one of these fills on a list of payers to query with
 * nothing to query, which is how a list stops being read. Figures invented, in the shape of one real memo line.
 */
const BIN = "024284";
const DAY = "2026-10-10";
const ASSISTANCE = 109_691;
const TOP_OFF = 10_309;

const share: Receivable = { bin: BIN, name: "Aytu / IPD (RxRescue)", dateFilled: "2026-09-20", cents: ASSISTANCE, cashPlan: false, claimId: "c1", portion: "plan" };
const memo = (over: Partial<Received> = {}): Received => ({
  bin: BIN,
  payer: "Aytu / IPD (RxRescue)",
  cents: ASSISTANCE + TOP_OFF,
  receivedOn: DAY,
  matched: true,
  claimId: "c1",
  portion: "plan",
  notBilled: true,
  ...over,
});

describe("a credit memo that pays the claim and a top-off nobody billed", () => {
  test("the claim is settled, and the part beyond it is not counted as received against the balance", () => {
    const s = owedByPayer([share], [memo()], "2026-10-20");
    const line = s.lines[0];
    assert.equal(line.outstandingCents, 0);
    assert.equal(line.receivedCents, ASSISTANCE);
    assert.equal(line.state, "settled");
  });

  test("it is never an overpayment: nothing to query, so nothing on a query list", () => {
    const s = owedByPayer([share], [memo()], "2026-10-20");
    assert.equal(s.lines[0].overpaidCents, 0);
    assert.notEqual(s.lines[0].state, "overpaid");
  });

  test("it is its own figure, on the line and in the summary, so the money is visible", () => {
    const s = owedByPayer([share], [memo()], "2026-10-20");
    assert.equal(s.lines[0].topOffCents, TOP_OFF);
    assert.deepEqual(s.topOff, { count: 1, cents: TOP_OFF });
    assert.match(s.lines[0].says, /nobody billed it for — the top-off this programme pays after the claim — which is revenue and not an overpayment/);
  });

  test("the same money from a payer that was billed for it IS an overpayment, and still reads that way", () => {
    const s = owedByPayer([share], [memo({ notBilled: false })], "2026-10-20");
    assert.equal(s.lines[0].overpaidCents, TOP_OFF);
    assert.equal(s.lines[0].state, "overpaid");
    assert.equal(s.topOff.cents, 0);
  });

  test("where the claim is only part settled, the memo settles it first and only the rest is the top-off", () => {
    const bigger: Receivable = { ...share, cents: ASSISTANCE + 5_000 };
    const s = owedByPayer([bigger], [memo()], "2026-10-20");
    assert.equal(s.lines[0].receivedCents, ASSISTANCE + 5_000);
    assert.equal(s.lines[0].outstandingCents, 0);
    assert.equal(s.topOff.cents, TOP_OFF - 5_000);
  });

  test("a memo matched to no claim of this payer's period is money outside it, as before", () => {
    const s = owedByPayer([share], [memo({ claimId: "other" })], "2026-10-20");
    assert.equal(s.outside.cents, ASSISTANCE + TOP_OFF);
    assert.equal(s.lines[0].outstandingCents, ASSISTANCE);
  });

  test("with no claim id at all it still settles what the payer was billed before counting a top-off", () => {
    const loose: Receivable = { bin: BIN, name: "Aytu / IPD (RxRescue)", dateFilled: "2026-09-20", cents: ASSISTANCE, cashPlan: false };
    const s = owedByPayer([loose], [memo({ claimId: null, portion: undefined })], "2026-10-20");
    assert.equal(s.lines[0].receivedCents, ASSISTANCE);
    assert.equal(s.lines[0].overpaidCents, 0);
    assert.equal(s.topOff.cents, TOP_OFF);
  });
});
