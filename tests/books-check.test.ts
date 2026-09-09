import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { monthlyPL, type PLInputs } from "../src/lib/profit-and-loss";
import { parsePeriod, combineMonths } from "../src/lib/ledger";
import { countedTwice, countedTwiceOver, feedsInTheBooks, booksBalance, basisDifference } from "../src/lib/books-check";

/*
 * The owner's three requirements of his books, each one turned into something that can fail.
 *
 *   "The money tab needs to have sound logic, needs to not forget about expenses or revenue it
 *    knows, needs to not double count things. This is how I will track financials of pharmacy. It
 *    should be able to operate on a cash and accrual basis."
 *
 * Round figures throughout, so every total below can be checked in the head against the fixture
 * above it. That is the whole point of a books test: a number nobody can add up by hand is a
 * number nobody will ever trust.
 */

/** One fill: $500 of plan money, $10 from the patient, a bottle that cost $420. */
const REMIT = 500_00;
const COPAY = 10_00;
const COST = 420_00;

function accrualMonth(m: string, over: Partial<PLInputs> = {}): PLInputs {
  return {
    month: m,
    basis: "accrual",
    sales: null,
    receipts: [],
    laterMoneyCents: 0,
    claimsRevenueCents: null,
    claimsCount: 0,
    dispensedCostCents: null,
    purchasesCents: null,
    billedPurchasesCents: null,
    rebatesCents: null,
    expenses: [],
    ...over,
  };
}

const cashMonth = (m: string, over: Partial<PLInputs> = {}): PLInputs => accrualMonth(m, { basis: "cash", ...over });

describe("the same money, reachable two ways", () => {
  /*
   * The fixture the brief asks for: a month where the prescriptions are on file twice — once in
   * the till report and once in the claims — and the rebate is on file twice as well, once as the
   * ladder's estimate and once as the wholesaler's own statement. Both pairs are true. Adding
   * either pair is the fault.
   */
  const both = accrualMonth("2026-09", {
    sales: { retailCents: 0, rxPatientCents: COPAY, rxRemitCents: REMIT, totalCents: REMIT + COPAY },
    claimsRevenueCents: REMIT + COPAY,
    claimsCount: 1,
    dispensedCostCents: COST,
    rebatesCents: 40_00,
    expenses: [
      { categoryId: "reb", categoryName: "Wholesaler rebates", kind: "cost_of_goods", amountCents: -45_00 },
      { categoryId: "dp", categoryName: "Drug purchases", kind: "cost_of_goods", amountCents: 4_000_00 },
    ],
  });
  const pl = monthlyPL(both);

  test("the prescriptions are counted once, from the till report, not once from each", () => {
    // $510 is on file twice. A books page that adds both prints $1,020 and a 100% margin.
    assert.equal(pl.revenueCents, REMIT + COPAY);
    assert.equal(pl.revenue.filter((l) => l.amountCents > 0).length, 2, "the remittance and the patient's money, and nothing from the claims");
  });

  test("the wholesaler's statement replaces the ladder's estimate rather than joining it", () => {
    const rebateLines = pl.costOfGoods.filter((l) => l.label === "Wholesaler rebates" || l.label === "Wholesaler rebates earned");
    assert.equal(rebateLines.length, 1);
    assert.equal(rebateLines[0].amountCents, -45_00, "the statement, not the $40 estimate and not both");
  });

  test("a wholesaler bill filed on Spending is left out of cost of goods and named", () => {
    assert.equal(pl.costOfGoods.some((l) => l.label === "Drug purchases"), false);
    assert.equal(pl.missing.some((s) => s.includes("Drug purchases")), true);
  });

  test("cost of goods is the bottle, less the rebate, and nothing else", () => {
    assert.equal(pl.costOfGoodsCents, COST - 45_00);
  });

  test("the register says which route won and what it kept out", () => {
    const reg = countedTwice(both, pl);
    const rx = reg.find((r) => r.what === "What the prescriptions took")!;
    assert.equal(rx.bothPresent, true);
    assert.equal(rx.keptOutCents, REMIT + COPAY, "the claims' figure is the money that was kept out");

    const rebate = reg.find((r) => r.what === "The wholesaler rebate")!;
    assert.equal(rebate.bothPresent, true);
    assert.equal(rebate.keptOutCents, 40_00, "the ladder's estimate is the money that was kept out");

    const bought = reg.find((r) => r.what === "What was bought from the wholesalers")!;
    assert.equal(bought.keptOutCents, 4_000_00);
  });

  test("with only one route on file the register says so and keeps nothing out", () => {
    const claimsOnly = accrualMonth("2026-09", { claimsRevenueCents: REMIT + COPAY, claimsCount: 1, dispensedCostCents: COST });
    const reg = countedTwice(claimsOnly, monthlyPL(claimsOnly));
    const rx = reg.find((r) => r.what === "What the prescriptions took")!;
    assert.equal(rx.bothPresent, false);
    assert.equal(rx.keptOutCents, null);
    assert.match(rx.says, /No summary is loaded/);
  });

  test("on the cash account the rebate receipt wins and the bill saying the same thing is dropped", () => {
    const i = cashMonth("2026-09", {
      receipts: [{ kind: "third_party", amountCents: REMIT }, { kind: "rebate", amountCents: 45_00 }],
      billedPurchasesCents: 4_000_00,
      rebatesCents: 40_00,
      expenses: [{ categoryId: "reb", categoryName: "Wholesaler rebates", kind: "cost_of_goods", amountCents: -45_00 }],
    });
    const cash = monthlyPL(i);
    assert.equal(cash.costOfGoodsCents, 4_000_00 - 45_00, "the receipt once, not the receipt and the bill");
    const reg = countedTwice(i, cash);
    assert.equal(reg.find((r) => r.what === "The wholesaler rebate")!.keptOutCents, -45_00);
  });

  test("every pair in the register names two routes and the rule that decides between them", () => {
    for (const r of countedTwice(both, pl)) {
      assert.equal(r.routes.length, 2, r.what);
      assert.ok(r.rule.length > 40, `${r.what} states no rule`);
      assert.ok(r.says.length > 0, `${r.what} says nothing about this month`);
    }
  });
});

describe("adjudicated in one month, remitted in the next, deposited in the one after", () => {
  /*
   * The fixture the brief names, and the whole cash-versus-accrual argument in one fill.
   *
   *   July:      the bottle goes out. The patient pays $10 at the register. The plan adjudicates
   *              $500 and owes it.
   *   August:    the remittance advice arrives. The plan has decided to pay. No money has moved.
   *   September: the deposit lands: $500 in the bank.
   *
   * Accrual books the whole $510 in July, because July is when the pharmacy earned it. Cash books
   * $10 in July and $500 in September, because that is when the money arrived. Both are true, and
   * on July alone they differ by exactly the remit.
   */
  const july = {
    accrual: monthlyPL(accrualMonth("2026-07", { claimsRevenueCents: REMIT + COPAY, claimsCount: 1, dispensedCostCents: COST })),
    // The copay is cash in July: it was taken at the register on the day.
    cash: monthlyPL(cashMonth("2026-07", { receipts: [{ kind: "patient", amountCents: COPAY }], billedPurchasesCents: COST })),
  };
  const august = {
    accrual: monthlyPL(accrualMonth("2026-08")),
    // The 835 says the plan will pay. Nothing reached the bank, so the cash account has no revenue.
    cash: monthlyPL(cashMonth("2026-08", { billedPurchasesCents: null })),
  };
  const september = {
    accrual: monthlyPL(accrualMonth("2026-09")),
    cash: monthlyPL(cashMonth("2026-09", { receipts: [{ kind: "third_party", amountCents: REMIT }] })),
  };

  test("July earned the whole fill and banked only the copay", () => {
    assert.equal(july.accrual.revenueCents, REMIT + COPAY);
    assert.equal(july.cash.revenueCents, COPAY);
  });

  test("the month the remittance advice arrives is not the month anything is banked", () => {
    assert.equal(august.cash.revenueCents, 0);
    assert.equal(august.accrual.revenueCents, 0);
    // And a cash month with nothing banked says so rather than reporting nought as a fact.
    assert.equal(august.cash.missing.some((s) => s.includes("reached the bank")), true);
  });

  test("the deposit is September's cash and nobody's accrual", () => {
    assert.equal(september.cash.revenueCents, REMIT);
    assert.equal(september.accrual.revenueCents, 0);
  });

  test("on July alone the two views disagree by exactly the remit", () => {
    const q = parsePeriod("2026-07")!;
    const a = combineMonths(q, [july.accrual]);
    const c = combineMonths(q, [july.cash]);
    assert.equal(a.revenueCents - c.revenueCents, REMIT);
  });

  test("across the quarter the money is counted once on each basis, never twice on either", () => {
    const q = parsePeriod("2026-Q3")!;
    const a = combineMonths(q, [july.accrual, august.accrual, september.accrual]);
    const c = combineMonths(q, [july.cash, august.cash, september.cash]);
    assert.equal(a.revenueCents, REMIT + COPAY);
    assert.equal(c.revenueCents, REMIT + COPAY);
  });

  test("the difference between the two bottom lines is explained in parts that add to it exactly", () => {
    const q = parsePeriod("2026-07")!;
    const a = combineMonths(q, [july.accrual]);
    const c = combineMonths(q, [july.cash]);
    const d = basisDifference(a, c);
    assert.equal(d.adds, true, d.says);
    assert.equal(d.differenceCents, a.netProfitCents - c.netProfitCents);
    assert.equal(d.parts.reduce((n, p) => n + p.cents, 0), d.differenceCents);
    // July: earned $500 more than banked, and paid for the bottle it had not yet been paid for.
    assert.equal(d.parts.find((p) => p.what === "Revenue earned and not yet banked")!.cents, REMIT);
    assert.equal(d.parts.find((p) => p.what === "Goods dispensed and not yet paid for")!.cents, 0);
  });

  test("a decomposition that does not add up refuses to explain the gap", () => {
    const q = parsePeriod("2026-07")!;
    const a = combineMonths(q, [july.accrual]);
    const c = combineMonths(q, [july.cash]);
    // A bottom line that does not follow from its own lines — the one fault this exists to catch.
    const broken = { ...a, netProfitCents: a.netProfitCents + 1_00 };
    const d = basisDifference(broken, c);
    assert.equal(d.adds, false);
    assert.match(d.says, /must be the same figure/);
  });
});

describe("the books add up from the rows they were built from", () => {
  const months = ["2026-07", "2026-08", "2026-09"].map((m) =>
    monthlyPL(
      accrualMonth(m, {
        sales: { retailCents: 100_00, rxPatientCents: 900_00, rxRemitCents: 5_000_00, totalCents: 6_000_00 },
        dispensedCostCents: 4_500_00,
        purchasesCents: 4_700_00,
        rebatesCents: 100_00,
        expenses: [
          { categoryId: "w", categoryName: "Wages and salaries", kind: "operating", amountCents: 800_00 },
          { categoryId: "r", categoryName: "Rent and occupancy", kind: "operating", amountCents: 200_00 },
          { categoryId: "c", categoryName: "Card processing and bank fees", kind: "operating", amountCents: 50_00 },
          { categoryId: "d", categoryName: "DIR fees and price concessions", kind: "revenue_offset", amountCents: 150_00 },
        ],
      }),
    ),
  );

  test("a month balances", () => {
    const b = booksBalance(months[0]);
    assert.equal(b.ok, true, b.checks.filter((c) => !c.ok).map((c) => c.says).join("; "));
    assert.equal(b.offByCents, 0);
  });

  test("a quarter balances, which its months balancing does not by itself prove", () => {
    /*
     * The period's totals are added from the months; its lines are merged by label. Two different
     * pieces of arithmetic over the same rows, so this only passes if both are right — which is
     * exactly the check a fold of two reporting modules needs.
     */
    const q = combineMonths(parsePeriod("2026-Q3")!, months);
    const b = booksBalance(q);
    assert.equal(b.ok, true, b.checks.filter((c) => !c.ok).map((c) => c.says).join("; "));
    assert.equal(q.revenueCents, 3 * 6_000_00);
    assert.equal(q.netRevenueCents, 3 * (6_000_00 - 150_00));
    assert.equal(q.costOfGoodsCents, 3 * (4_500_00 - 100_00));
    assert.equal(q.operatingCents, 3 * 1_050_00);
  });

  test("a line added to the list and not to the total is caught", () => {
    const wrong = { ...months[0], operating: [...months[0].operating, { label: "Something nobody added up", amountCents: 500_00 }] };
    const b = booksBalance(wrong);
    assert.equal(b.ok, false);
    assert.equal(b.offByCents, 500_00);
    assert.equal(b.checks.find((c) => !c.ok)!.says, "Operating costs are the sum of their lines");
  });

  test("an accrual account states no cash change, and nought would be a claim it cannot make", () => {
    assert.equal(months[0].cashChangeCents, null);
    assert.equal(booksBalance({ ...months[0], cashChangeCents: 0 }).ok, false);
  });

  test("a cash account's change is the bottom line less the money out that is not a cost", () => {
    const cash = monthlyPL(
      cashMonth("2026-09", {
        receipts: [{ kind: "third_party", amountCents: 6_000_00 }],
        billedPurchasesCents: 4_500_00,
        expenses: [
          { categoryId: "w", categoryName: "Wages and salaries", kind: "operating", amountCents: 800_00 },
          { categoryId: "l", categoryName: "Loan principal", kind: "balance_sheet", amountCents: 300_00 },
        ],
      }),
    );
    assert.equal(cash.otherCashOutCents, 300_00);
    assert.equal(cash.cashChangeCents, cash.netProfitCents - 300_00);
    assert.equal(booksBalance(cash).ok, true);
  });
});

describe("which feeds are in the books, said out loud", () => {
  const feeds = feedsInTheBooks();

  test("every feed says what it carries, which basis it reaches and how", () => {
    assert.ok(feeds.length >= 12);
    for (const f of feeds) {
      assert.ok(f.carries.length > 0, f.name);
      assert.ok(f.how.length > 0, f.name);
      assert.ok(["accrual", "cash", "both", "none"].includes(f.reaches), f.name);
      assert.ok(f.href.startsWith("/"), f.name);
    }
  });

  test("a feed that reaches neither account says what is not in the books because of it", () => {
    // The point of the list. "Not wired up" and "deliberately outside the account" look identical
    // on a page that only shows the account, and only one of the two is a problem.
    for (const f of feeds.filter((x) => x.reaches === "none")) {
      assert.ok(f.gap && f.gap.length > 40, `${f.name} reaches neither account and does not say why`);
    }
  });

  test("the two feeds that would finish the cash side are named as missing", () => {
    const bank = feeds.find((f) => f.name === "Bank lines")!;
    const era = feeds.find((f) => f.name === "Remittance advice (835)")!;
    assert.equal(bank.reaches, "none");
    assert.equal(era.reaches, "none");
    assert.match(bank.gap!, /truth on the cash side/);
    assert.match(era.gap!, /receivable/);
  });

  test("no feed is listed twice, which would be its own kind of double count", () => {
    assert.equal(new Set(feeds.map((f) => f.name)).size, feeds.length);
  });
});

describe("the fold: one period, named in one place", () => {
  test("a quarter names the months nothing was recorded for, rather than adding them as noughts", () => {
    /*
     * The books and the reports disagreed about this and the disagreement was invisible: the
     * reports left an unrecorded month out and named it, the books ran it through the account and
     * produced a column of noughts and a page of "this is missing". On a year that was eleven of
     * them, burying the months that really were short of a line.
     */
    const july = monthlyPL(accrualMonth("2026-07", { claimsRevenueCents: 1_000_00, claimsCount: 2, dispensedCostCents: 800_00 }));
    const q = combineMonths(parsePeriod("2026-Q3")!, [july]);
    assert.deepEqual(q.emptyMonths, ["2026-08", "2026-09"]);
    assert.equal(q.revenueCents, 1_000_00, "the quarter is the one month it has, not three");
    assert.equal(q.months.length, 1);
  });

  test("a period with every month on file names none as empty", () => {
    const months = ["2026-07", "2026-08", "2026-09"].map((m) => monthlyPL(accrualMonth(m, { claimsRevenueCents: 100_00, claimsCount: 1, dispensedCostCents: 80_00 })));
    assert.deepEqual(combineMonths(parsePeriod("2026-Q3")!, months).emptyMonths, []);
  });

  test("a period's double-count register is one register, not one per month", () => {
    const withBoth = accrualMonth("2026-07", {
      sales: { retailCents: 0, rxPatientCents: COPAY, rxRemitCents: REMIT, totalCents: REMIT + COPAY },
      claimsRevenueCents: REMIT + COPAY,
      claimsCount: 1,
      dispensedCostCents: COST,
    });
    const claimsOnly = accrualMonth("2026-08", { claimsRevenueCents: 200_00, claimsCount: 1, dispensedCostCents: 150_00 });
    const over = countedTwiceOver([
      { inputs: withBoth, pl: monthlyPL(withBoth) },
      { inputs: claimsOnly, pl: monthlyPL(claimsOnly) },
    ]);
    assert.equal(over.length, countedTwice(withBoth, monthlyPL(withBoth)).length, "the same pairs, folded — not two lists concatenated");
    const rx = over.find((r) => r.what === "What the prescriptions took")!;
    assert.equal(rx.bothPresent, true, "one of the two months had both records");
    assert.equal(rx.keptOutCents, REMIT + COPAY, "and only that month kept anything out");
    assert.match(rx.says, /1 of the 2 months/);
  });

  test("a period where no pair ever fired says so rather than showing nothing", () => {
    const a = accrualMonth("2026-07", { claimsRevenueCents: 100_00, claimsCount: 1, dispensedCostCents: 80_00 });
    const b = accrualMonth("2026-08", { claimsRevenueCents: 200_00, claimsCount: 1, dispensedCostCents: 150_00 });
    const over = countedTwiceOver([{ inputs: a, pl: monthlyPL(a) }, { inputs: b, pl: monthlyPL(b) }]);
    const rx = over.find((r) => r.what === "What the prescriptions took")!;
    assert.equal(rx.bothPresent, false);
    assert.match(rx.says, /nothing had to be kept out/);
  });
});
