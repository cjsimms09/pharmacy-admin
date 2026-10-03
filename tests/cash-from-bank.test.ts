import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyBankLine, gatherCashAccount, nameFromWhy, supplierIn, type BankLineIn, type Context } from "../src/lib/cash-from-bank-rules";

/*
 * The owner, 2 October 2026: "cash accounting should match the bank, this is how cash accounting works.." Every bank
 * line is revenue, an offset, cost of goods, an operating cost, a flow that is neither, or not yet named; the account
 * is their sum and equals the bank to the cent. These pin each rule on invented lines, and the identity.
 */
const ctx: Context = {
  suppliers: [{ name: "Mckesson" }, { name: "IPC", aliases: "Independent Pharmacy Cooperative\nIndependent Pharmacy Cooperative (IPC)" }, { name: "Parmed" }, { name: "RrcPharmaSolution" }, { name: "ANDA" }],
  standing: [{ name: "Rent", categoryName: "Rent and occupancy" }, { name: "Alert360", categoryName: "Software and systems" }, { name: "Payroll", categoryName: "Wages and salaries" }],
  vendors: [{ name: "Stamps.com", categoryName: "Postage and shipping", categoryKind: "operating" }, { name: "Rx Systems", categoryName: "Pharmacy supplies", categoryKind: "operating" }],
  categories: [
    { name: "Drug purchases (OTC)", kind: "cost_of_goods" },
    { name: "Loan principal", kind: "balance_sheet" },
    { name: "Postage and shipping", kind: "operating" },
    { name: "DIR fees and price concessions", kind: "revenue_offset" },
  ],
  receipts: new Map([
    ["r1", { kind: "third_party", payer: "Health Mart Atlas" }],
    ["r2", { kind: "patient", payer: null }],
    ["r3", { kind: "rebate", payer: "Mckesson" }],
  ]),
  invoices: new Map([["i1", { supplier: "IPC" }]]),
  expenses: new Map([
    ["e1", { categoryName: "Loan principal", categoryKind: "balance_sheet" }],
    ["e2", { categoryName: "Software and systems", categoryKind: "operating" }],
    ["e3", { categoryName: "DIR fees and price concessions", categoryKind: "revenue_offset" }],
  ]),
};

const line = (over: Partial<BankLineIn>): BankLineIn => ({ id: "x", on: "2026-09-10", description: "", amountCents: -100, placedAs: "unplaced", why: null, receiptId: null, expenseId: null, invoiceId: null, ...over });

describe("every bank line is one of six things", () => {
  test("a receipt's kind says what money in is; a rebate received reduces cost of goods", () => {
    assert.equal(classifyBankLine(line({ amountCents: 63_298_82, receiptId: "r1", placedAs: "confirms_deposit" }), ctx).label, "Third-party remittances");
    assert.equal(classifyBankLine(line({ amountCents: 5_845_25, receiptId: "r2", placedAs: "deposit" }), ctx).label, "Patient payments");
    const rebate = classifyBankLine(line({ amountCents: 10_697_24, receiptId: "r3", placedAs: "banks_remits" }), ctx);
    assert.equal(rebate.side, "cost_of_goods");
  });

  test("an invoice names its supplier; an expense's category kind decides its side", () => {
    assert.deepEqual([classifyBankLine(line({ invoiceId: "i1", placedAs: "pays_invoices" }), ctx).side, classifyBankLine(line({ invoiceId: "i1", placedAs: "pays_invoices" }), ctx).label], ["cost_of_goods", "IPC"]);
    assert.equal(classifyBankLine(line({ expenseId: "e1", placedAs: "books_bill" }), ctx).side, "flow");
    assert.equal(classifyBankLine(line({ expenseId: "e2", placedAs: "books_bill" }), ctx).side, "operating");
    assert.equal(classifyBankLine(line({ expenseId: "e3", placedAs: "books_bill" }), ctx).side, "offset");
  });

  test("the pharmacy's other account, by what the transfer was for", () => {
    const payroll = classifyBankLine(line({ description: "Ref BTABVG2 To *6728 Sept PSA", amountCents: -45_000_00, placedAs: "already_counted", why: "Out to another account of the pharmacy." }), ctx);
    assert.equal(payroll.side, "operating");
    assert.equal(payroll.label, "Wages and salaries");
    const meds = classifyBankLine(line({ description: "Ref BTBBB5U To *6728 Sept 2026 Med", amountCents: -7_499_26, placedAs: "already_counted", why: "Out to another account of the pharmacy." }), ctx);
    assert.equal(meds.side, "cost_of_goods");
    const sold = classifyBankLine(line({ description: "Prescription/TRANSFER ST-KOD8Y3M7L1H1 WEST WICHITA FAMILY PH", amountCents: 374_28, placedAs: "already_counted", why: "In from WWFP (drugs sold at cost)." }), ctx);
    assert.equal(sold.side, "revenue");
  });

  test("a wholesaler's draw, a purchase before the books, and money the feeds already carry, each by the placement's own words", () => {
    assert.equal(classifyBankLine(line({ description: "MCKESSON DRUG/AUTO ACH ACH9990001", amountCents: -139_973_54, placedAs: "settles_ach", why: "CKACH9990001 covers 39 Mckesson invoices and comes to exactly this debit." }), ctx).label, "Mckesson");
    const ipc = classifyBankLine(line({ description: "Independent Phar/WAREHOUSE 1068964", amountCents: -6_055_66, placedAs: "before_books", why: "IPC, paid within 14 days of the books starting on 2026-09-01, with no invoice set on file." }), ctx);
    assert.deepEqual([ipc.side, ipc.label], ["cost_of_goods", "IPC"]);
    const cards = classifyBankLine(line({ description: "HRTLAND PMT SYS/TXNS/FEES 65000001", amountCents: 3_587_59, placedAs: "before_books", why: "Card takings paid in on 2026-09-02, two business days behind the register." }), ctx);
    assert.deepEqual([cards.side, cards.label], ["revenue", "Patient payments"]);
    const rrc = classifyBankLine(line({ description: "Purch IN *RRC PHARMA SOLUTIO INGLE", amountCents: -8_220_00, placedAs: "already_counted", why: "Out to RrcPharmaSolution. A purchase from RRC Pharma, paid by debit card." }), ctx);
    assert.deepEqual([rrc.side, rrc.label], ["cost_of_goods", "RrcPharmaSolution"]);
    const stamps = classifyBankLine(line({ description: "Purch STAMPS.COM WASHINGTON DC", amountCents: -100_00, placedAs: "already_counted", why: "Out to Stamps.com. Postage bought by card." }), ctx);
    assert.deepEqual([stamps.side, stamps.label], ["operating", "Postage and shipping"]);
    const alarm = classifyBankLine(line({ description: "Purch ALERT 360 TULSA OK", amountCents: -214_69, placedAs: "already_counted", why: "Out to Alert 360. The alarm monitoring contract, which is a standing cost on file." }), ctx);
    assert.deepEqual([alarm.side, alarm.label], ["operating", "Software and systems"]);
    const refiled = classifyBankLine(line({ description: "Independent Phar/WAREHOUSE 10689648", amountCents: -1_171_46, placedAs: "pays_invoices", invoiceId: "gone", why: "IPC: $1,171.46 is exactly these 2 invoices: 11486822 ($1,058.41), 11486823 ($113.05)." }), ctx);
    assert.deepEqual([refiled.side, refiled.label], ["cost_of_goods", "IPC"]);
    const mtf = classifyBankLine(line({ description: "MTF PM NGS/MTF PMT", amountCents: 339_96, placedAs: "already_counted", why: "The Medicare facilitator paying." }), ctx);
    assert.deepEqual([mtf.side, mtf.label], ["revenue", "Facilitator payments"]);
  });

  test("a standing cost by cheque, a noted purchase with a category, and a cheque nobody has named", () => {
    const rent = classifyBankLine(line({ description: "CHECK 2454", amountCents: -2_625_00, placedAs: "confirms_standing", why: "Rent, paid by cheque. The standing cost already carries it." }), ctx);
    assert.deepEqual([rent.side, rent.label], ["operating", "Rent and occupancy"]);
    const otc = classifyBankLine(line({ description: "Purch WHOLESCRIPTS LLC ORLANDO FL", amountCents: -2_219_26, placedAs: "noted", why: "Drug purchases (OTC): Xymogen OTC products bought through WholeScripts by card." }), ctx);
    assert.deepEqual([otc.side, otc.label], ["cost_of_goods", "Drug purchases (OTC)"]);
    const cheque = classifyBankLine(line({ description: "CHECK 2456", amountCents: -5_800_00, placedAs: "unplaced", why: "A cheque." }), ctx);
    assert.deepEqual([cheque.side, cheque.label], ["unnamed", "Not yet named"]);
  });

  test("the account is the sum of its lines and equals the bank to the cent, with the unnamed inside it", () => {
    const lines = [
      line({ id: "a", amountCents: 63_298_82, receiptId: "r1", placedAs: "confirms_deposit" }),
      line({ id: "b", amountCents: 5_845_25, receiptId: "r2", placedAs: "deposit" }),
      line({ id: "c", amountCents: -139_973_54, placedAs: "settles_ach", why: "CKACH1 covers 39 Mckesson invoices." }),
      line({ id: "d", amountCents: -7_949_32, expenseId: "e1", placedAs: "books_bill" }),
      line({ id: "e", amountCents: -2_625_00, placedAs: "confirms_standing", why: "Rent, paid by cheque." }),
      line({ id: "f", amountCents: -5_800_00, placedAs: "unplaced", why: "A cheque." }),
    ].map((l) => classifyBankLine(l, ctx));
    const g = gatherCashAccount(lines);
    const sum = (ls: { amountCents: number }[]) => ls.reduce((n, l) => n + l.amountCents, 0);
    const net = sum(g.revenue) - sum(g.offsets) - sum(g.costOfGoods) - sum(g.operating);
    assert.equal(g.changeCents, 63_298_82 + 5_845_25 - 139_973_54 - 7_949_32 - 2_625_00 - 5_800_00);
    assert.equal(net - sum(g.flows) - sum(g.unnamed), g.changeCents);
    assert.equal(g.unnamed[0].amountCents, 5_800_00);
  });

  test("the helpers: a supplier by alias cut by the bank's column, and the counterparty from the placement's sentence", () => {
    assert.equal(supplierIn("Independent Phar/WAREHOUSE 1068964", ctx.suppliers), "IPC");
    assert.equal(supplierIn("ParMed/XXXXXXXXXX 2057167199", ctx.suppliers), "Parmed");
    assert.equal(supplierIn("Purch STAMPS.COM", ctx.suppliers), null);
    assert.equal(nameFromWhy("Out to Rx Systems. Vials, bags and labels."), "Rx Systems");
    assert.equal(nameFromWhy("ANDA, paid within 14 days of the books starting on 2026-09-01"), "ANDA");
    assert.equal(nameFromWhy("CKACH9990001 covers 39 Mckesson invoices and comes to exactly this debit."), "Mckesson");
  });
});

test("every account row carries the bank lines behind it: date, what the bank printed, the amount, and the rule", () => {
  const g = gatherCashAccount([
    classifyBankLine(line({ id: "a", on: "2026-09-15", description: "Ln 8319 Pmt from DD 8855", amountCents: -794_932, expenseId: "e1", placedAs: "books_bill" }), ctx),
    classifyBankLine(line({ id: "b", on: "2026-09-16", description: "Ln 8319 Pmt", amountCents: -100_00, expenseId: "e1", placedAs: "books_bill" }), ctx),
  ]);
  assert.equal(g.flows.length, 1);
  assert.equal(g.flows[0].amountCents, 804_932);
  assert.deepEqual(
    g.flows[0].sources?.map((x) => [x.on, x.what, x.amountCents]),
    [["2026-09-15", "Ln 8319 Pmt from DD 8855", -794_932], ["2026-09-16", "Ln 8319 Pmt", -100_00]],
  );
  assert.ok(g.flows[0].sources?.every((x) => x.how.length > 0), "each line says which rule placed it");
});
