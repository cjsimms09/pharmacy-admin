import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { monthlyPL, type PLInputs } from "../src/lib/profit-and-loss";

/**
 * A month, honestly. The arithmetic is easy; where each figure belongs is the whole job, and putting
 * one on the wrong line produces an account that balances and misleads.
 *
 * Built on the real August: $669,497.38 taken, of which $570,778.94 from plans, $93,259.56 from
 * patients and $5,458.88 over the counter.
 */
const base: PLInputs = {
  month: "2026-08",
  basis: "accrual",
  sales: { retailCents: 545_888, rxPatientCents: 9_325_956, rxRemitCents: 57_077_894, totalCents: 66_949_738 },
  receipts: [],
  laterMoneyCents: 0,
  dispensedCostCents: 55_000_000,
  paidPurchasesCents: null,
  purchasesCents: 58_000_000,
  rebatesCents: 1_200_000,
  expenses: [
    { categoryId: "w", categoryName: "Wages and salaries", kind: "operating", amountCents: 4_500_000 },
    { categoryId: "r", categoryName: "Rent and occupancy", kind: "operating", amountCents: 600_000 },
    { categoryId: "c", categoryName: "Card processing and bank fees", kind: "operating", amountCents: 180_000 },
    { categoryId: "s", categoryName: "Software and systems", kind: "operating", amountCents: 120_000 },
    { categoryId: "d", categoryName: "DIR fees and price concessions", kind: "revenue_offset", amountCents: 900_000 },
  ],
};

describe("what the month made", () => {
  test("revenue is the whole till, retail included", () => {
    const pl = monthlyPL(base);
    assert.equal(pl.revenueCents, 66_949_738);
    assert.equal(pl.revenue.length, 3, "plans, patients and the front of shop, kept apart");
  });

  test("cost of goods is what was dispensed, not what was bought", () => {
    /*
     * The decision the whole account turns on. Purchases are not cost of goods: a month with a big
     * buy-in would look catastrophic and the month that sold the stock wonderful, and neither figure
     * would mean anything. PioneerRx prints the acquisition cost of every fill, so the cost of what
     * actually sold is known per bottle and needs no stocktake.
     */
    const pl = monthlyPL(base);
    assert.equal(pl.costOfGoods[0].amountCents, 55_000_000, "what left the shelf, not the $580,000 bought");
    assert.equal(pl.stockMovementCents, 3_000_000, "and the difference is stock building up, reported as cash rather than profit");
  });

  test("rebates reduce cost and are never revenue", () => {
    /*
     * Booked as income they would overstate sales and cost of goods by the same amount, leave the
     * bottom line right, and make every margin percentage wrong.
     */
    const pl = monthlyPL(base);
    assert.equal(pl.revenueCents, 66_949_738, "not a penny of rebate is in revenue");
    assert.equal(pl.costOfGoodsCents, 55_000_000 - 1_200_000);
    // Gross profit is taken off net revenue, which the month's DIR has already been removed from.
    assert.equal(pl.grossProfitCents, pl.netRevenueCents - (55_000_000 - 1_200_000));
  });

  test("DIR fees come out of revenue, not out of overheads", () => {
    /*
     * They are money a plan said the pharmacy had earned and later took back. Filed as an operating
     * cost they flatter the dispensing margin — the figure used to decide what to stock and who to
     * contract with.
     */
    const withDir = monthlyPL(base);
    const withoutDir = monthlyPL({ ...base, expenses: base.expenses.filter((e) => e.kind !== "revenue_offset") });
    assert.equal(withDir.revenueCents, 66_949_738, "revenue as billed is unchanged");
    assert.equal(withDir.netRevenueCents, 66_949_738 - 900_000, "but net revenue is not");
    assert.equal(withDir.operatingCents, 5_400_000, "and it is not sitting in overheads");
    assert.ok(
      withDir.grossMarginPercent !== null && withDir.grossMarginPercent < withoutDir.grossMarginPercent!,
      "the dispensing margin falls, as it should",
    );
  });

  test("the bottom line", () => {
    const pl = monthlyPL(base);
    assert.equal(pl.operatingCents, 5_400_000);
    assert.equal(pl.netProfitCents, pl.grossProfitCents - 5_400_000);
    assert.equal(pl.usable, true, "every big line is present");
  });

  test("a month with no payroll in it is not reported as profitable", () => {
    /*
     * The failure worth designing against. Wages are commonly more than half of a pharmacy's gross
     * profit, so a month missing them does not look slightly optimistic — it looks profitable when
     * it was not, and nothing about the number says so.
     */
    const pl = monthlyPL({ ...base, expenses: base.expenses.filter((e) => e.categoryName !== "Wages and salaries") });
    assert.equal(pl.usable, false);
    assert.ok(pl.missing.some((m) => /Wages/.test(m)));
    assert.ok(pl.netProfitCents > monthlyPL(base).netProfitCents, "the figure is better precisely because something is absent");
  });

  test("card processing is named even though nobody invoices for it", () => {
    const pl = monthlyPL({ ...base, expenses: base.expenses.filter((e) => !/Card processing/.test(e.categoryName)) });
    assert.ok(pl.missing.some((m) => /Card processing/.test(m)));
  });

  test("on a cash basis the sales summary says nothing, and what was banked says everything", () => {
    /*
     * A September prescription is October's money. The accrual report cannot answer a cash question
     * and must not be quietly reused for one.
     */
    const cash = monthlyPL({
      ...base,
      basis: "cash",
      receipts: [
        { kind: "third_party", amountCents: 51_000_000 },
        { kind: "patient", amountCents: 9_325_956 },
        { kind: "retail", amountCents: 545_888 },
      ],
    });
    assert.equal(cash.revenueCents, 51_000_000 + 9_325_956 + 545_888);
    assert.ok(cash.revenueCents < monthlyPL(base).revenueCents, "cash lags accrual, which is the receivable");
  });

  test("a cash month with nothing banked says so rather than reporting no revenue", () => {
    const cash = monthlyPL({ ...base, basis: "cash", receipts: [] });
    assert.equal(cash.revenueCents, 0);
    assert.ok(cash.missing.some((m) => /reached the bank/.test(m)));
    assert.equal(cash.usable, false);
  });

  test("no claims loaded means no cost of goods, and it is named", () => {
    const pl = monthlyPL({ ...base, dispensedCostCents: null });
    assert.equal(pl.costOfGoodsCents, -1_200_000, "only the rebate, which on its own is not a cost of goods");
    assert.ok(pl.missing.some((m) => /dispensed/.test(m)));
    assert.equal(pl.stockMovementCents, null, "and stock movement cannot be worked out either");
  });

  test("categories nothing was spent on do not appear", () => {
    // An account padded with zeros is one nobody reads.
    const pl = monthlyPL({ ...base, expenses: [...base.expenses, { categoryId: "x", categoryName: "Marketing", kind: "operating", amountCents: 0 }] });
    assert.ok(!pl.operating.some((l) => l.label === "Marketing"));
  });
});

describe("figures that arrive in a different month from the one that earned them", () => {
  test("a rebate goes against the month that earned it, or the month it was banked, never both", () => {
    /*
     * A wholesaler settles a month's rebate a month or two after it closes. Using one figure for
     * both bases would put the same rebate in the wrong month on one of the two accounts, every
     * month, and nothing in either account would look wrong.
     */
    const accrual = monthlyPL(base);
    assert.ok(accrual.costOfGoods.some((l) => l.label === "Wholesaler rebates earned" && l.amountCents === -1_200_000));

    const cash = monthlyPL({
      ...base,
      basis: "cash",
      receipts: [
        { kind: "third_party", amountCents: 51_000_000 },
        { kind: "rebate", amountCents: 950_000 },
      ],
      rebatesCents: 1_200_000,
    });
    assert.ok(cash.costOfGoods.some((l) => l.label === "Wholesaler rebates received" && l.amountCents === -950_000), "what was banked, not what was earned");
    assert.equal(cash.revenueCents, 51_000_000, "and a rebate is never revenue on either basis");
  });

  test("no DIR entered is reported as nobody having entered it", () => {
    /*
     * DIR is typed in by hand, so an empty line almost always means "not done yet" rather than
     * "there were none" — and silence on a figure that only ever reduces profit reads as good news.
     */
    const pl = monthlyPL({ ...base, expenses: base.expenses.filter((e) => e.kind !== "revenue_offset") });
    assert.ok(pl.missing.some((m) => /DIR/.test(m)));
    assert.equal(pl.usable, false);
  });
});

/**
 * The two bases must not agree, and the ways they were made to agree.
 *
 * An accrual account matches cost to the revenue it produced; a cash account records money as it
 * moves. Answering both with the same figure is wrong on at least one of them every month, and it
 * is wrong in the flattering direction in a month of building stock — which is the month a
 * pharmacist is most likely to be looking.
 */
describe("cash and accrual are different accounts", () => {
  test("accrual takes cost from what was dispensed", () => {
    const r = monthlyPL(base);
    const cogs = r.costOfGoods.find((l) => l.label.startsWith("Acquisition cost"));
    assert.equal(cogs?.amountCents, 55_000_000);
    assert.equal(r.costOfGoods.some((l) => l.label === "Paid to the wholesalers"), false);
  });

  test("cash takes cost from what was paid to the wholesalers, not from what was dispensed", () => {
    const r = monthlyPL({
      ...base,
      basis: "cash",
      receipts: [{ kind: "third_party", amountCents: 60_000_000 }],
      paidPurchasesCents: 48_000_000,
    });
    const cogs = r.costOfGoods.find((l) => l.label === "Paid to the wholesalers");
    assert.equal(cogs?.amountCents, 48_000_000);
    assert.equal(r.costOfGoods.some((l) => l.label.startsWith("Acquisition cost")), false, "the accrual figure must not appear on a cash account");
  });

  test("a cash month with nothing marked paid says so rather than borrowing the accrual answer", () => {
    /*
     * The substitution that would make the two accounts agree. Silence here is correct and has to
     * be loud, because a cost of goods of zero reads as an extremely good month.
     */
    const r = monthlyPL({ ...base, basis: "cash", receipts: [{ kind: "third_party", amountCents: 60_000_000 }], paidPurchasesCents: null });
    assert.equal(r.costOfGoods.some((l) => l.label.startsWith("Acquisition cost")), false);
    assert.match(r.missing.join(" "), /No invoice carries a payment date/);
  });

  test("unpaid invoices in the month are named, so the gap is visible rather than quiet", () => {
    const r = monthlyPL({
      ...base, basis: "cash", receipts: [{ kind: "third_party", amountCents: 60_000_000 }],
      paidPurchasesCents: 48_000_000, purchasesUnpaidCount: 3,
    });
    assert.match(r.missing.join(" "), /3 wholesaler invoices have no payment date/);
  });
});

describe("revenue when the till report has not arrived", () => {
  test("the claims stand in for the prescription side", () => {
    const r = monthlyPL({ ...base, sales: null, claimsRevenueCents: 60_000_000, claimsCount: 1199 });
    const line = r.revenue.find((l) => l.label === "Prescriptions, from the claims");
    assert.equal(line?.amountCents, 60_000_000);
    assert.match(line?.note ?? "", /1,199 dispensings/);
  });

  test("and never as well as it, which would count every prescription twice", () => {
    const r = monthlyPL({ ...base, claimsRevenueCents: 60_000_000, claimsCount: 1199 });
    assert.equal(r.revenue.some((l) => l.label === "Prescriptions, from the claims"), false);
    assert.equal(r.revenue.find((l) => l.label === "Third-party remittance")?.amountCents, 57_077_894);
  });

  test("retail is called missing, because understating revenue quietly is still understating it", () => {
    const r = monthlyPL({ ...base, sales: null, claimsRevenueCents: 60_000_000, claimsCount: 1199 });
    assert.match(r.missing.join(" "), /retail and over-the-counter sales are missing entirely/i);
  });

  test("no claims and no summary reports no revenue rather than inventing some", () => {
    const r = monthlyPL({ ...base, sales: null, claimsRevenueCents: null });
    assert.equal(r.revenue.length, 0);
  });
});

describe("the shape of the account", () => {
  test("gross profit is net revenue less cost of goods, and rebates reduce the cost", () => {
    const r = monthlyPL(base);
    // 669,497.38 revenue − 9,000.00 DIR = 660,497.38 net revenue.
    assert.equal(r.netRevenueCents, 66_949_738 - 900_000);
    // 550,000.00 dispensed − 12,000.00 rebates earned.
    assert.equal(r.costOfGoodsCents, 55_000_000 - 1_200_000);
    assert.equal(r.grossProfitCents, r.netRevenueCents - r.costOfGoodsCents);
    assert.equal(r.netProfitCents, r.grossProfitCents - r.operatingCents);
  });

  test("a rebate never appears as revenue", () => {
    const r = monthlyPL(base);
    assert.equal(r.revenue.some((l) => /rebate/i.test(l.label)), false);
    assert.ok(r.costOfGoods.some((l) => /rebate/i.test(l.label) && l.amountCents < 0));
  });

  test("DIR reduces revenue rather than sitting in overhead", () => {
    const r = monthlyPL(base);
    assert.equal(r.operating.some((l) => /DIR/i.test(l.label)), false);
    assert.equal(r.revenueCents - r.netRevenueCents, 900_000);
  });
});
