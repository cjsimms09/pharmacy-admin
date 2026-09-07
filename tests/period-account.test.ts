import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parsePeriod,
  quarterOf,
  periodsFor,
  periodTotals,
  trend,
  changeFrom,
  previousPeriod,
} from "../src/lib/period-account";
import type { MonthlyPL } from "../src/lib/profit-and-loss";

/** A month with only the figures a period report reads. */
function pl(month: string, a: Partial<MonthlyPL> = {}): MonthlyPL {
  return {
    month,
    basis: "accrual",
    claimsCount: 0,
    revenue: [],
    revenueCents: 0,
    offsets: [],
    netRevenueCents: 0,
    costOfGoods: [],
    costOfGoodsCents: 0,
    grossProfitCents: 0,
    grossMarginPercent: null,
    operating: [],
    operatingCents: 0,
    netProfitCents: 0,
    otherCashOut: [],
    otherCashOutCents: 0,
    cashChangeCents: null,
    stockMovementCents: null,
    reconciliation: { cogs: { checks: [], impliedCogsCents: null, stockMovementCents: null }, revenue: [] },
    missing: [],
    usable: true,
    ...a,
  };
}

describe("naming a period", () => {
  test("a month, a quarter and a year each give their own months", () => {
    assert.deepEqual(parsePeriod("2026-09")?.months, ["2026-09"]);
    assert.deepEqual(parsePeriod("2026-Q3")?.months, ["2026-07", "2026-08", "2026-09"]);
    assert.equal(parsePeriod("2026")?.months.length, 12);
    assert.deepEqual(parsePeriod("2026")?.months.slice(0, 2), ["2026-01", "2026-02"]);
  });

  test("the label says what the period is without needing the key", () => {
    assert.equal(parsePeriod("2026-09")?.label, "September 2026");
    assert.equal(parsePeriod("2026-Q1")?.label, "Q1 2026 — January to March");
    assert.equal(parsePeriod("2026")?.label, "2026");
  });

  test("nonsense is refused rather than guessed at", () => {
    assert.equal(parsePeriod("2026-13"), null);
    assert.equal(parsePeriod("2026-Q5"), null);
    assert.equal(parsePeriod("last month"), null);
    assert.equal(parsePeriod(""), null);
  });

  test("a month knows its quarter", () => {
    assert.equal(quarterOf("2026-01"), "2026-Q1");
    assert.equal(quarterOf("2026-03"), "2026-Q1");
    assert.equal(quarterOf("2026-04"), "2026-Q2");
    assert.equal(quarterOf("2026-12"), "2026-Q4");
    assert.equal(quarterOf("nope"), null);
  });

  test("only periods with a recorded month are offered, newest first", () => {
    const p = periodsFor(["2026-09", "2026-08", "2025-11", "rubbish"]);
    assert.deepEqual(p.months, ["2026-09", "2026-08", "2025-11"]);
    assert.deepEqual(p.quarters, ["2026-Q3", "2025-Q4"]);
    assert.deepEqual(p.years, ["2026", "2025"]);
  });

  test("the period before is the one a comparison needs, across a year boundary", () => {
    assert.equal(previousPeriod(parsePeriod("2026-01")!)?.key, "2025-12");
    assert.equal(previousPeriod(parsePeriod("2026-Q1")!)?.key, "2025-Q4");
    assert.equal(previousPeriod(parsePeriod("2026")!)?.key, "2025");
  });
});

describe("adding months into a quarter", () => {
  const months = [
    pl("2026-07", { claimsCount: 1_000, netRevenueCents: 20_000_00, grossProfitCents: 4_400_00, costOfGoodsCents: 15_600_00, operatingCents: 3_000_00, netProfitCents: 1_400_00 }),
    pl("2026-08", { claimsCount: 1_200, netRevenueCents: 30_000_00, grossProfitCents: 7_200_00, costOfGoodsCents: 22_800_00, operatingCents: 3_000_00, netProfitCents: 4_200_00 }),
    pl("2026-09", { claimsCount: 800, netRevenueCents: 10_000_00, grossProfitCents: 1_900_00, costOfGoodsCents: 8_100_00, operatingCents: 3_000_00, netProfitCents: -1_100_00 }),
  ];
  const q = periodTotals(parsePeriod("2026-Q3")!, "accrual", months);

  test("the money adds up", () => {
    assert.equal(q.scripts, 3_000);
    assert.equal(q.netRevenueCents, 60_000_00);
    assert.equal(q.grossProfitCents, 13_500_00);
    assert.equal(q.operatingCents, 9_000_00);
    assert.equal(q.netProfitCents, 4_500_00);
  });

  test("the margin is the quarter's own, not the average of the months'", () => {
    // The months are 22%, 24% and 19%; their mean is 21.67% and the quarter is not that.
    assert.equal(q.grossMarginPercent, 22.5);
    assert.equal(q.netMarginPercent, 7.5);
  });

  test("per script divides the period's totals, not the months' averages", () => {
    // $60,000 over 3,000 scripts. The mean of $20.00, $25.00 and $12.50 would be $19.17.
    assert.equal(q.revenuePerScriptCents, 2_000);
    assert.equal(q.grossProfitPerScriptCents, 450);
  });

  test("a month with nothing recorded is named rather than counted as a good month", () => {
    const short = periodTotals(parsePeriod("2026-Q3")!, "accrual", [months[0], months[2]]);
    assert.deepEqual(short.emptyMonths, ["2026-08"]);
    assert.equal(short.scripts, 1_800);
  });

  test("a month known to be short is summed in and listed, because leaving it out is just as wrong", () => {
    const withGap = [months[0], pl("2026-08", { claimsCount: 1_200, netRevenueCents: 30_000_00, usable: false, missing: ["No payroll is recorded."] }), months[2]];
    const r = periodTotals(parsePeriod("2026-Q3")!, "accrual", withGap);
    assert.deepEqual(r.unusableMonths, ["2026-08"]);
    assert.deepEqual(r.missing, ["No payroll is recorded."]);
    assert.equal(r.netRevenueCents, 60_000_00, "still counted — omitting it would understate the quarter");
  });

  test("a month outside the period is not pulled in by being handed over", () => {
    const r = periodTotals(parsePeriod("2026-Q3")!, "accrual", [...months, pl("2026-10", { netRevenueCents: 99_000_00 })]);
    assert.equal(r.netRevenueCents, 60_000_00);
    assert.equal(r.months.length, 3);
  });

  test("an empty period totals nought and says no rate rather than nought percent", () => {
    const r = periodTotals(parsePeriod("2026-Q1")!, "accrual", months);
    assert.equal(r.netRevenueCents, 0);
    assert.equal(r.grossMarginPercent, null);
    assert.equal(r.revenuePerScriptCents, null);
    assert.equal(r.emptyMonths.length, 3);
  });
});

describe("the months as a series", () => {
  const months = [
    pl("2026-09", { claimsCount: 800, netRevenueCents: 10_000_00, grossProfitCents: 1_900_00 }),
    pl("2026-07", { claimsCount: 1_000, netRevenueCents: 20_000_00, grossProfitCents: 4_400_00, usable: false }),
    pl("2026-08", { claimsCount: 1_200, netRevenueCents: 30_000_00, grossProfitCents: 7_200_00 }),
  ];

  test("oldest first, whatever order they arrived in", () => {
    assert.deepEqual(trend(months).map((p) => p.month), ["2026-07", "2026-08", "2026-09"]);
  });

  test("the label fits under a bar", () => {
    assert.deepEqual(trend(months).map((p) => p.label), ["Jul 26", "Aug 26", "Sep 26"]);
  });

  test("per-script figures come with the point, so a chart never divides for itself", () => {
    const [jul] = trend(months);
    assert.equal(jul.netRevenuePerScriptCents, 2_000);
    assert.equal(jul.grossProfitPerScriptCents, 440);
  });

  test("a month short of something carries that with it, so a dip can be read right", () => {
    assert.deepEqual(trend(months).map((p) => p.usable), [false, true, true]);
  });

  test("a month with no scripts asks for no average rather than dividing by nought", () => {
    const [only] = trend([pl("2026-09", { claimsCount: 0, netRevenueCents: 10_00 })]);
    assert.equal(only.netRevenuePerScriptCents, null);
  });
});

describe("the change from the period before", () => {
  test("the money moved, and the share it moved by", () => {
    assert.deepEqual(changeFrom(13_500_00, 12_000_00), { deltaCents: 1_500_00, percent: 12.5 });
    assert.deepEqual(changeFrom(9_000_00, 12_000_00), { deltaCents: -3_000_00, percent: -25 });
  });

  test("a percentage off a loss or off nothing is refused rather than invented", () => {
    assert.equal(changeFrom(20_000, -10_000).percent, null);
    assert.equal(changeFrom(20_000, 0).percent, null);
    assert.equal(changeFrom(20_000, -10_000).deltaCents, 30_000, "the money still moved, and that is a fact");
  });
});
