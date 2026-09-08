import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rankReturns, returnTotals, tierFor, RETURN_TIERS } from "../src/lib/return-soon";

/*
 * The owner's rule in three sentences: send back what the policy is about to stop crediting, send
 * back what nobody dispenses, and the dearer a line is the fewer days it may sit. Each has a case.
 */
describe("return soon", () => {
  test("the dearer the line, the fewer days it may hold", () => {
    assert.equal(tierFor(250_000).keepDays, 7);
    assert.equal(tierFor(30_000).keepDays, 14);
    assert.equal(tierFor(1_000).keepDays, 30);
    assert.equal(RETURN_TIERS[RETURN_TIERS.length - 1].atLeastCents, 0, "the last tier catches everything");
  });

  test("a dear line moving slowly goes back down to its tier's days, a cheap one at the same pace stays", () => {
    const rows = rankReturns({
      shelf: [
        // 100 units, 2 a day: 50 days of stock. Worth $1,500: may hold 7 days, so 86 go back.
        { ndc11: "1", name: "Dear", onHandThousandths: 100_000, perDayThousandths: 2_000, daysOfStock: 50, state: "overstocked", lastOn: "2026-09-01", worthCents: 150_000 },
        // Same pace, worth $10: may hold 30 days, so 40 would go back — but that $4 is under materiality.
        { ndc11: "2", name: "Cheap", onHandThousandths: 100_000, perDayThousandths: 2_000, daysOfStock: 50, state: "overstocked", lastOn: "2026-09-01", worthCents: 1_000 },
      ],
      due: [],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ndc11, "1");
    assert.equal(rows[0].why, "slow");
    assert.equal(rows[0].sendBackThousandths, 86_000);
    assert.equal(rows[0].sendBackWorthCents, 129_000);
    assert.equal(rows[0].urgency, "this week", "worth over $1,000 with no invoice clock is this week's job");
    assert.equal(rows[0].supplier, null);
    assert.match(rows[0].todo, /No invoice/);
  });

  test("what nobody dispenses goes back whole, ranked by the dollars", () => {
    const rows = rankReturns({
      shelf: [
        { ndc11: "a", name: "Idle small", onHandThousandths: 30_000, perDayThousandths: 0, daysOfStock: null, state: "dead", lastOn: null, worthCents: 4_000 },
        { ndc11: "b", name: "Idle big", onHandThousandths: 10_000, perDayThousandths: 0, daysOfStock: null, state: "dead", lastOn: null, worthCents: 60_000 },
        { ndc11: "c", name: "Moving", onHandThousandths: 10_000, perDayThousandths: 5_000, daysOfStock: 2, state: "lean", lastOn: "2026-09-07", worthCents: 60_000 },
      ],
      due: [],
    });
    assert.deepEqual(rows.map((r) => r.ndc11), ["b", "a"]);
    assert.equal(rows[0].why, "idle");
    assert.equal(rows[0].sendBackThousandths, 10_000);
    assert.equal(rows[0].urgency, "this month");
    assert.equal(rows[1].urgency, "later");
  });

  test("a short claims window cannot send a dear line back this week on idleness alone", () => {
    const shelf = [{ ndc11: "d", name: "Dear idle", onHandThousandths: 5_000, perDayThousandths: 0, daysOfStock: null, state: "dead" as const, lastOn: null, worthCents: 500_000 }];
    assert.equal(rankReturns({ shelf, due: [], windowDays: 15 })[0].urgency, "this month");
    assert.match(rankReturns({ shelf, due: [], windowDays: 15 })[0].reasons[0], /15 days of claims/);
    assert.equal(rankReturns({ shelf, due: [], windowDays: 120 })[0].urgency, "this week");
  });

  test("a credit about to drop puts the line at the top, with the supplier and the dollars at stake", () => {
    const rows = rankReturns({
      shelf: [
        { ndc11: "x", name: "On a clock", onHandThousandths: 20_000, perDayThousandths: 0, daysOfStock: null, state: "dead", lastOn: null, worthCents: 20_000 },
        { ndc11: "y", name: "Dear idle", onHandThousandths: 5_000, perDayThousandths: 0, daysOfStock: null, state: "dead", lastOn: null, worthCents: 500_000 },
      ],
      due: [{ ndc11: "x", supplier: "ANDA", invoiceDate: "2026-08-01", quantity: 20, extendedCents: 20_000, creditPercentNow: 80, dropsInDays: 3, dropsToPercent: 50, closesInDays: 300, dispensedSince: 0 }],
    });
    assert.equal(rows[0].ndc11, "x");
    assert.equal(rows[0].why, "credit");
    assert.equal(rows[0].urgency, "this week");
    assert.equal(rows[0].supplier, "ANDA");
    assert.equal(rows[0].atRiskCents, 6_000, "80% to 50% of $200 is $60");
    assert.match(rows[0].todo, /ANDA.*2026-08-01.*\$60\.00/);
    assert.equal(rows[1].ndc11, "y");
  });

  test("a line moving at a fair pace is still flagged when some will be left as the credit changes", () => {
    const rows = rankReturns({
      shelf: [{ ndc11: "m", name: "Moving", onHandThousandths: 30_000, perDayThousandths: 2_000, daysOfStock: 15, state: "overstocked", lastOn: "2026-09-07", worthCents: 30_000 }],
      due: [{ ndc11: "m", supplier: "IPC", invoiceDate: "2026-08-20", quantity: 30, extendedCents: 30_000, creditPercentNow: 100, dropsInDays: 5, dropsToPercent: 80, closesInDays: 100, dispensedSince: 0 }],
    });
    // Worth $300: may hold 14 days, 15 days of stock is over — 2 units over the tier, but 20 left at the credit step.
    assert.equal(rows.length, 1);
    assert.ok(rows[0].reasons.some((r) => /drops from 100% to 80% in 5 days/.test(r)));
    assert.equal(rows[0].deadlineDays, 5);
  });

  test("an invoice line the count never showed still appears when its credit is about to change", () => {
    const rows = rankReturns({
      shelf: [],
      due: [{ ndc11: "z", supplier: "ANDA", invoiceDate: "2026-09-01", quantity: 2, extendedCents: 90_000, creditPercentNow: 80, dropsInDays: null, dropsToPercent: null, closesInDays: 10, dispensedSince: 0 }],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].why, "window");
    assert.equal(rows[0].urgency, "this month");
    const t = returnTotals(rows);
    assert.equal(t.sittingCents, 90_000);
    assert.equal(t.withoutSupplier, 0);
  });
});
