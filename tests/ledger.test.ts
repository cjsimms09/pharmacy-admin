import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parsePeriod, periodOf, periodsBack, combineMonths, pace, scriptCounts, basisGap, statementRows, toCsv, neighbours, daysInMonth } from "../src/lib/ledger";
import { monthlyPL, type PLInputs } from "../src/lib/profit-and-loss";

/** A month with round figures, so the sums can be checked in the head. */
function month(m: string, over: Partial<PLInputs> = {}): PLInputs {
  return {
    month: m,
    basis: "accrual",
    sales: { retailCents: 100_000, rxPatientCents: 900_000, rxRemitCents: 5_000_000, totalCents: 6_000_000 },
    receipts: [],
    laterMoneyCents: 0,
    dispensedCostCents: 4_500_000,
    billedPurchasesCents: null,
    purchasesCents: 4_700_000,
    rebatesCents: 100_000,
    expenses: [
      { categoryId: "w", categoryName: "Wages and salaries", kind: "operating", amountCents: 800_000 },
      { categoryId: "r", categoryName: "Rent and occupancy", kind: "operating", amountCents: 200_000 },
      { categoryId: "c", categoryName: "Card processing and bank fees", kind: "operating", amountCents: 50_000 },
      { categoryId: "d", categoryName: "DIR fees and price concessions", kind: "revenue_offset", amountCents: 150_000 },
    ],
    ...over,
  };
}

describe("periods", () => {
  test("a key names a month, a quarter or a year, and nothing else", () => {
    assert.deepEqual(parsePeriod("2026-09")?.months, ["2026-09"]);
    assert.deepEqual(parsePeriod("2026-Q3")?.months, ["2026-07", "2026-08", "2026-09"]);
    assert.equal(parsePeriod("2026")?.months.length, 12);
    assert.equal(parsePeriod("2026-13"), null);
    assert.equal(parsePeriod("2026-Q5"), null);
    assert.equal(parsePeriod("last month"), null);
    assert.equal(parsePeriod("2026-02")?.to, "2026-02-28");
    assert.equal(daysInMonth("2028-02"), 29);
  });

  test("the quarter and year containing a month, and the ones before it", () => {
    assert.equal(periodOf("quarter", "2026-01").key, "2026-Q1");
    assert.equal(periodOf("year", "2026-12").key, "2026");
    assert.deepEqual(periodsBack("month", "2026-02", 3).map((p) => p.key), ["2025-12", "2026-01", "2026-02"]);
    assert.deepEqual(periodsBack("quarter", "2026-09", 2).map((p) => p.key), ["2026-Q2", "2026-Q3"]);
    const n = neighbours(periodOf("quarter", "2026-01"));
    assert.equal(n.before.key, "2025-Q4");
    assert.equal(n.after.key, "2026-Q2");
  });
});

describe("a quarter is its months added line by line", () => {
  const q = parsePeriod("2026-Q3")!;
  const months = ["2026-07", "2026-08", "2026-09"].map((m) => monthlyPL(month(m)));

  test("totals are sums and the margin is recomputed on them, not averaged", () => {
    const pl = combineMonths(q, months);
    assert.equal(pl.revenueCents, 18_000_000);
    assert.equal(pl.netRevenueCents, 18_000_000 - 450_000);
    assert.equal(pl.costOfGoodsCents, 3 * (4_500_000 - 100_000));
    assert.equal(pl.grossProfitCents, 17_550_000 - 13_200_000);
    assert.equal(pl.operatingCents, 3 * 1_050_000);
    assert.equal(pl.netProfitCents, 4_350_000 - 3_150_000);
    assert.equal(pl.grossMarginPercent, Math.round((4_350_000 / 17_550_000) * 1000) / 10);
    assert.equal(pl.stockMovementCents, 600_000);
    assert.equal(pl.usable, true);
  });

  test("a line keeps one label across months, so wages are one row, not three", () => {
    const pl = combineMonths(q, months);
    assert.equal(pl.operating.filter((l) => l.label === "Wages and salaries").length, 1);
    assert.equal(pl.operating.find((l) => l.label === "Wages and salaries")?.amountCents, 2_400_000);
  });

  test("what a month is missing is named with the month, and the period is unusable until it is in", () => {
    const short = [months[0], months[1], monthlyPL(month("2026-09", { expenses: [] }))];
    const pl = combineMonths(q, short);
    assert.equal(pl.usable, false);
    assert.ok(pl.missing.some((m) => m.startsWith("September 2026: Wages")), pl.missing.join(" | "));
    assert.equal(pl.stockMovementCents, 600_000, "stock movement is unaffected by the bills");
  });

  test("mixing bases is refused", () => {
    assert.throws(() => combineMonths(q, [months[0], monthlyPL(month("2026-08", { basis: "cash", receipts: [{ kind: "third_party", amountCents: 1 }] }))]));
  });
});

describe("month to date, at this pace", () => {
  test("dispensing is scaled to the month; the bills are not", () => {
    // Ten days in: $60,000 net so far becomes $180,000 for a thirty-day month.
    const p = pace({ month: "2026-09", netRevenueCents: 6_000_000, grossProfitCents: 1_500_000, operatingCents: 1_000_000 }, 10);
    assert.equal(p.daysInMonth, 30);
    assert.equal(p.netRevenueCents, 18_000_000);
    assert.equal(p.grossProfitCents, 4_500_000);
    assert.equal(p.netAfterBillsSoFarCents, 4_500_000 - 1_000_000, "the bills already in, not tripled");
    assert.match(p.says, /10 of 30 days/);
  });

  test("under three days is not a pace", () => {
    const p = pace({ month: "2026-09", netRevenueCents: 500_000, grossProfitCents: 100_000, operatingCents: 0 }, 2);
    assert.equal(p.netRevenueCents, null);
  });

  test("more days than the month has is the month", () => {
    const p = pace({ month: "2026-02", netRevenueCents: 2_800_000, grossProfitCents: 700_000, operatingCents: 0 }, 40);
    assert.equal(p.daysElapsed, 28);
    assert.equal(p.netRevenueCents, 2_800_000);
  });
});

describe("scripts are bottles, not transmissions", () => {
  const fills = [
    { dateFilled: "2026-09-01", cashPlan: false, revenueCents: 5_000 },
    { dateFilled: "2026-09-01", cashPlan: true, revenueCents: 1_200 },
    { dateFilled: "2026-09-02", cashPlan: false, revenueCents: 8_000 },
    { dateFilled: "2026-08-31", cashPlan: false, revenueCents: 9_999 },
    { dateFilled: "2026-10-01", cashPlan: false, revenueCents: 9_999 },
  ];
  test("counted within the period, cash apart, per day over days with fills", () => {
    const c = scriptCounts(fills, parsePeriod("2026-09")!);
    assert.equal(c.scripts, 3);
    assert.equal(c.thirdParty, 2);
    assert.equal(c.cash, 1);
    assert.equal(c.daysWithFills, 2);
    assert.equal(c.perDay, 1.5);
    assert.equal(c.averageRevenueCents, Math.round(14_200 / 3));
    assert.deepEqual(c.byMonth, [{ month: "2026-09", scripts: 3, revenueCents: 14_200 }]);
  });
  test("a quarter has one entry per month, including the empty ones", () => {
    const c = scriptCounts(fills, parsePeriod("2026-Q3")!);
    assert.equal(c.scripts, 4);
    assert.deepEqual(c.byMonth.map((m) => m.scripts), [0, 1, 3]);
  });
});

describe("the two bases side by side", () => {
  test("earned less banked is the receivable; dispensed less paid is the payable", () => {
    const accrual = combineMonths(parsePeriod("2026-08")!, [monthlyPL(month("2026-08"))]);
    const cash = combineMonths(
      parsePeriod("2026-08")!,
      [monthlyPL(month("2026-08", { basis: "cash", receipts: [{ kind: "third_party", amountCents: 4_000_000 }, { kind: "patient", amountCents: 900_000 }, { kind: "rebate", amountCents: 80_000 }], billedPurchasesCents: 4_000_000 }))],
    );
    const g = basisGap(accrual, cash);
    assert.equal(g.receivableCents, 6_000_000 - 4_900_000);
    assert.equal(g.payableCents, (4_500_000 - 100_000) - (4_000_000 - 80_000));
    assert.match(g.says, /\$11,000\.00 earned and not yet banked/);
  });
  test("a gap against nothing is not a receivable", () => {
    const accrual = combineMonths(parsePeriod("2026-08")!, [monthlyPL(month("2026-08"))]);
    const cash = combineMonths(parsePeriod("2026-08")!, [monthlyPL(month("2026-08", { basis: "cash" }))]);
    assert.equal(basisGap(accrual, cash).receivableCents, null);
  });
});

describe("the statement as a file", () => {
  test("one row per line, the totals between the groups, quotes doubled", () => {
    const pl = combineMonths(parsePeriod("2026-08")!, [monthlyPL(month("2026-08"))]);
    const rows = statementRows(pl);
    assert.equal(rows.find((r) => r.group === "Net revenue")?.cents, 5_850_000);
    assert.equal(rows.find((r) => r.group === "Gross profit")?.note, `${pl.grossMarginPercent}% of net revenue`);
    assert.equal(rows[rows.length - 1].label, "Net profit");
    const csv = toCsv([{ a: 'say "hi"', b: 1 }]);
    assert.equal(csv, '"a","b"\r\n"say ""hi""","1"\r\n');
  });
});
