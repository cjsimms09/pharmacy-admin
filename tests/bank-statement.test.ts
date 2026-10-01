import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseBankStatement, bankDate, bankCents, placeLines, lineKey } from "../src/lib/bank-statement";

const ctx = {
  payers: ["CVS Caremark", "Express Scripts", "OptumRx"],
  suppliers: [{ id: "mck", name: "McKesson" }, { id: "ipc", name: "IPC" }],
  vendors: [{ id: "v-elec", name: "Evergy" }, { id: "v-rent", name: "Main Street Properties LLC" }],
  unpaidBills: [
    { id: "b1", vendorId: "v-elec", vendorName: "Evergy", amountCents: 24_650, invoiceDate: "2026-09-03" },
    { id: "b2", vendorId: "v-rent", vendorName: "Main Street Properties LLC", amountCents: 400_000, invoiceDate: "2026-09-01" },
    { id: "b3", vendorId: "v-rent", vendorName: "Main Street Properties LLC", amountCents: 400_000, invoiceDate: "2026-08-01" },
  ],
  unpaidInvoices: [{ id: "i1", supplierId: "mck", supplier: "McKesson", totalCents: 1_875_000, invoiceDate: "2026-09-02" }],
};

describe("reading the bank's export", () => {
  test("dates and money in the ways banks write them", () => {
    assert.equal(bankDate("9/5/2026"), "2026-09-05");
    assert.equal(bankDate("09/05/26"), "2026-09-05");
    assert.equal(bankDate("2026-09-05T00:00:00"), "2026-09-05");
    assert.equal(bankDate("yesterday"), null);
    assert.equal(bankCents("$1,234.56"), 123_456);
    assert.equal(bankCents("(1,234.56)"), -123_456);
    assert.equal(bankCents("-45.00"), -4_500);
    assert.equal(bankCents("45.00 DR"), -4_500);
    assert.equal(bankCents("n/a"), null);
  });
  test("one amount column, or debit and credit columns, both read to signed cents", () => {
    const one = parseBankStatement([
      { Date: "9/5/2026", Description: "CVS CAREMARK ACH", Amount: "1,500.00" },
      { Date: "9/6/2026", Description: "EVERGY BILL PAY", Amount: "-246.50" },
    ]);
    assert.deepEqual(one.lines.map((l) => l.amountCents), [150_000, -24_650]);
    const two = parseBankStatement([
      { "Posting Date": "09/05/2026", Memo: "SQUARE INC DEPOSIT", Debit: "", Credit: "812.10" },
      { "Posting Date": "09/06/2026", Memo: "MCKESSON DRUG ACH", Debit: "18,750.00", Credit: "" },
      { "Posting Date": "bad", Memo: "x", Debit: "1.00", Credit: "" },
    ]);
    assert.deepEqual(two.lines.map((l) => l.amountCents), [81_210, -1_875_000]);
    assert.equal(two.skipped.length, 1);
    assert.equal(parseBankStatement([{ Foo: "1", Bar: "2" }]).columns, null);
  });
  test("the same line is the same key however the description is spaced", () => {
    assert.equal(lineKey("2026-09-05", 150_000, "CVS  CAREMARK ACH"), lineKey("2026-09-05", 150_000, "cvs caremark ach "));
    assert.notEqual(lineKey("2026-09-05", 150_000, "CVS"), lineKey("2026-09-06", 150_000, "CVS"));
  });
});

describe("placing each line", () => {
  const lines = parseBankStatement([
    { Date: "9/5/2026", Description: "CVS CAREMARK ACH PMT", Amount: "1,500.00" },
    { Date: "9/5/2026", Description: "MCKESSON CORP REBATE", Amount: "900.00" },
    { Date: "9/5/2026", Description: "SQUARE INC 0905", Amount: "812.10" },
    { Date: "9/5/2026", Description: "MEDICARE TRANSACTION FACILITATOR", Amount: "150.25" },
    { Date: "9/5/2026", Description: "ZELLE FROM SOMEBODY", Amount: "50.00" },
    { Date: "9/6/2026", Description: "EVERGY BILL PAY", Amount: "-246.50" },
    { Date: "9/6/2026", Description: "MCKESSON DRUG ACH", Amount: "-18,750.00" },
    { Date: "9/6/2026", Description: "MAIN STREET PROPERTIES", Amount: "-4,000.00" },
    { Date: "9/6/2026", Description: "AMAZON MKTPLACE", Amount: "-31.99" },
  ]).lines;
  const placed = placeLines(lines, ctx);
  const at = (i: number) => placed[i].placement;
  test("deposits: a known payer, a wholesaler paying in, card takings, the facilitator, and a stranger", () => {
    assert.equal(placeLines([lines[3]], { ...ctx, facilitatorPaid: [{ on: lines[3].on, cents: lines[3].amountCents }] })[0].placement.kind, "already_counted");
    /*
     * CHANGED 15 September: a credit that only mentions a plan is no longer banked. Plan money arrives through the PSAO
     * and is banked from its report; banking by a mention banked $78,726.92 as "City of Wichita" on August's scan (G-BANK-1).
     */
    assert.equal(at(0).kind, "unplaced");
    assert.match(at(0).why, /mentions CVS Caremark/);
    assert.equal((at(1) as { receiptKind: string }).receiptKind, "rebate");
    assert.equal((at(2) as { receiptKind: string }).receiptKind, "retail");
    /* Not banked: the MTF remittances count it (G-MTF-1). With none on file for the day it is left for a person. */
    assert.equal(at(3).kind, "facilitator_unmatched");
    assert.match(at(3).why, /no MTF remittance for this day is on file/);
    assert.equal(at(4).kind, "unplaced");
  });
  test("payments: exactly one open item with this amount and this name is marked paid; two is left to a person", () => {
    assert.deepEqual([at(5).kind, (at(5) as { expenseId: string }).expenseId], ["pays_bill", "b1"]);
    assert.deepEqual([at(6).kind, (at(6) as { invoiceId: string }).invoiceId], ["pays_invoice", "i1"]);
    assert.equal(at(7).kind, "unplaced", "two rent bills of $4,000 are open: which one is not for the site to guess");
    assert.equal(at(8).kind, "unplaced");
  });
  test("an open item is settled by one line only", () => {
    const twice = placeLines([lines[5], { ...lines[5], on: "2026-09-07", key: "k2" }], ctx);
    assert.equal(twice[0].placement.kind, "pays_bill");
    assert.equal(twice[1].placement.kind, "unplaced");
  });
});

describe("the pharmacy's own name is not a counterparty (G-BANK-1)", () => {
  const ctx2 = { payers: ["005377 (10000019)- City of Wichita", "Script Care & Tredium Solutions"], suppliers: [], vendors: [], unpaidBills: [], unpaidInvoices: [] };
  test("REGRESSION: a credit naming WEST WICHITA FAMILY PH is not City of Wichita's money", () => {
    const p = placeLines([{ on: "2026-08-12", description: "Deposit ST.V6TOS6L7MOO6 WEST WICHITA FAMILY PH", amountCents: 64_558, key: "a" }], ctx2)[0].placement;
    assert.notEqual(p.kind, "deposit");
    assert.doesNotMatch(p.why, /City of Wichita/);
  });
  test("REGRESSION: 'script' is not found inside 'Prescription'", () => {
    const p = placeLines([{ on: "2026-08-10", description: "PrescriptionTRANSFER ST.V6TOS6L7MOO6", amountCents: 242_474, key: "b" }], ctx2)[0].placement;
    assert.doesNotMatch(p.why, /Script Care/);
  });
  test("REGRESSION: a PSAO deposit is never banked from the statement", () => {
    for (const d of ["ACCESS HEALTH/ACCESS HEA 7000017 West Wichita", "ProviderPay/EDI PYMNTS West Wichita"]) {
      assert.equal(placeLines([{ on: "2026-08-26", description: d, amountCents: 1_233_061, key: d }], ctx2)[0].placement.kind, "psao_deposit");
    }
  });
  test("the Heartland spellings the scan produced are card lines", () => {
    for (const d of ["HRTI3ND PMT SYS/TXNS/FEES", "HRTTJqN D PMT SYSTTXNS/FEES"]) {
      assert.equal(placeLines([{ on: "2026-08-12", description: d, amountCents: 366_277, key: d }], ctx2)[0].placement.kind, "card_deposit", d);
    }
  });
});

describe("the owner's answers about August's unnamed lines (Q-BANK-1)", () => {
  const ctx3 = { payers: [], suppliers: [{ id: "rrc", name: "RrcPharmaSolution" }], vendors: [], unpaidBills: [], unpaidInvoices: [{ id: "inv-rrc", supplierId: "rrc", supplier: "RrcPharmaSolution", totalCents: 738_000, invoiceDate: "2026-08-20" }] };
  test("a prescription transfer is the practice paying for drugs sold at cost: cash only, banked once from the line", () => {
    const p = placeLines([{ on: "2026-08-03", description: "Prescription/TRA N S FER ST.J2HsP3LOMlL8 WTST WICHTTA FAMILY PH", amountCents: 337_322, key: "t" }], ctx3)[0].placement;
    assert.deepEqual([p.kind, p.kind === "deposit" ? p.receiptKind : null, p.kind === "deposit" ? p.payer : null], ["deposit", "other", "WWFP (drugs sold at cost)"]);
  });
  test("DrHouse pays for its scripts straight to the bank: banked as plan money on cash, while its claims count it on accrual", () => {
    const p = placeLines([{ on: "2026-08-24", description: "DRHOUSE PAYMENTS West Wichita", amountCents: 3_835, key: "d" }], ctx3)[0].placement;
    assert.deepEqual([p.kind, p.kind === "deposit" ? p.payer : null], ["deposit", "DrHouse"]);
  });
  test("an RRC Pharma debit-card purchase pays its invoice, or waits for one - it never books cost itself", () => {
    const paid = placeLines([{ on: "2026-08-24", description: "PuTch IN *RRC PHARMA SOLUTIO INGLEWOOD cA", amountCents: -738_000, key: "r1" }], ctx3)[0].placement;
    assert.equal(paid.kind, "pays_invoice");
    const waits = placeLines([{ on: "2026-08-28", description: "Purch IN *RRC PHARMA SOLUTIO INGLEWOOD", amountCents: -936_000, key: "r2" }], ctx3)[0].placement;
    assert.equal(waits.kind, "unplaced");
    assert.match(waits.why, /forward their invoice/);
  });
});

test("REGRESSION: every scanned spelling of Prescription/TRANSFER is the practice's payment (G-BANK-5)", () => {
  const ctx4 = { payers: [], suppliers: [], vendors: [], unpaidBills: [], unpaidInvoices: [] };
  for (const d of ["PrescriptionflRAN S FER", "Prescripticn/FfRANSFER", "PreseriptionTRANSFER", "Prescription/fLLN5FER"]) {
    assert.equal(placeLines([{ on: "2026-08-10", description: d, amountCents: 100_00, key: d }], ctx4)[0].placement.kind, "deposit", d);
  }
});

/*
 * What September 2026's statement taught the matcher: eighty-nine lines sat "unmatched" while the register, the
 * remittances, the rebate receipt and the books' own first day explained fifty-two of them. Invented figures.
 */
describe("the lines September 2026 could not place, and what explains them", () => {
  const base = { payers: [], suppliers: [{ id: "ipc", name: "IPC", accountNumber: "10689648" }], vendors: [], unpaidBills: [], unpaidInvoices: [], booksStartOn: "2026-09-01" };
  const remits = [
    { id: "r1", payer: "SS&C HEALTH", remitOn: "2026-09-29", amountCents: 5_817_764, paymentNumber: "999000000000001", remitNumber: "7000000001" },
    { id: "r2", payer: "SS&C HEALTH", remitOn: "2026-09-29", amountCents: 402_755, paymentNumber: "999000000000002", remitNumber: "7000000002" },
    { id: "r3", payer: "EXPRESS SCRIPTS INC", remitOn: "2026-09-29", amountCents: 615_764, paymentNumber: "999000000000003", remitNumber: "7000000003" },
    { id: "r4", payer: "SS&C HEALTH", remitOn: "2026-09-19", amountCents: 180_800, paymentNumber: null, remitNumber: "7000000004" },
    { id: "r5", payer: "Health Mart Atlas", remitOn: "2026-09-29", amountCents: 2_006_882, paymentNumber: "99900001", remitNumber: "7000000005" },
    { id: "r6", payer: "MYMATRIXX", remitOn: "2026-09-21", amountCents: 1_448, paymentNumber: null, remitNumber: "7000000006" },
  ];

  test("a ProviderPay deposit is the other payers' remittances of the day before — including one held back for eleven days", () => {
    const [{ placement }] = placeLines([{ on: "2026-09-30", description: "ProviderPay/EDI PYMNTS 489121084100001 West Wichita Family Ph", amountCents: 7_017_083, key: "pp" }], { ...base, remits });
    assert.equal(placement.kind, "banks_remits");
    assert.deepEqual(placement.kind === "banks_remits" ? placement.remits.map((r) => r.id).sort() : [], ["r1", "r2", "r3", "r4"]);
  });

  test("an Access Health deposit takes only Health Mart Atlas's remittances, and a remittance stands behind one deposit", () => {
    const out = placeLines(
      [
        { on: "2026-09-30", description: "ACCESS HEALTH/ACCESS HEA 1722734 West Wichita Family Ph", amountCents: 2_006_882, key: "ah" },
        { on: "2026-09-30", description: "ACCESS HEALTH/ACCESS HEA 1722734 West Wichita Family Ph", amountCents: 2_006_882, key: "ah2" },
      ],
      { ...base, remits },
    );
    assert.equal(out[0].placement.kind, "banks_remits");
    assert.deepEqual(out[0].placement.kind === "banks_remits" ? out[0].placement.remits.map((r) => r.id) : [], ["r5"]);
    assert.equal(out[1].placement.kind, "psao_deposit");
  });

  test("two sets of remittances that both add up leave the deposit for a person", () => {
    const twice = [...remits, { id: "r7", payer: "LucyRx", remitOn: "2026-09-29", amountCents: 180_800, paymentNumber: null, remitNumber: "7000000007" }];
    const [{ placement }] = placeLines([{ on: "2026-09-30", description: "ProviderPay/EDI PYMNTS 489121084100001 West Wichita Family Ph", amountCents: 7_017_083, key: "pp" }], { ...base, remits: twice });
    assert.equal(placement.kind, "psao_deposit");
    assert.match(placement.why, /More than one set/);
  });

  test("a bare counter deposit equal to a cheque-paying payer's remittance is that cheque", () => {
    const [{ placement }] = placeLines([{ on: "2026-09-30", description: "Deposit", amountCents: 1_448, key: "dep" }], { ...base, remits });
    assert.equal(placement.kind, "banks_remits");
    assert.match(placement.why, /MYMATRIXX.*cheque/);
  });

  test("a bare deposit nothing equals is still nobody's", () => {
    const [{ placement }] = placeLines([{ on: "2026-09-30", description: "Deposit", amountCents: 73_517, key: "dep" }], { ...base, remits });
    assert.equal(placement.kind, "unplaced");
  });

  test("a wholesaler's draw in the books' first fortnight, with nothing to tie it to, is before the books — not unmatched", () => {
    const early = placeLines([{ on: "2026-09-03", description: "Independent Phar/WAREHOUSE 10689648 WEST WICHITA FAMILY PH", amountCents: -118_566, key: "ipc1" }], base)[0].placement;
    assert.equal(early.kind, "before_books");
    const later = placeLines([{ on: "2026-09-24", description: "Independent Phar/WAREHOUSE 10689648 WEST WICHITA FAMILY PH", amountCents: -94_642, key: "ipc2" }], base)[0].placement;
    assert.equal(later.kind, "unplaced");
  });

  test("a postage top-up from before the first confirmation on file books itself; one after it waits for its email", () => {
    const ctx = { ...base, postageBills: [{ amountCents: 10_000, on: "2026-09-08" }], firstPostageBillOn: "2026-09-08" };
    const before = placeLines([{ on: "2026-09-01", description: "Purch STAMPS.COM WASHINGTON DC *HkAE5821 08/31 08:25", amountCents: -10_000, key: "s1" }], ctx)[0].placement;
    assert.equal(before.kind, "books_bill");
    const after = placeLines([{ on: "2026-09-21", description: "Purch STAMPS.COM WASHINGTON DC *HkAE5821 09/20 08:25", amountCents: -10_000, key: "s2" }], ctx)[0].placement;
    assert.equal(after.kind, "unplaced");
  });

  test("the day's rebate credits together confirm the rebate receipt; apart they stay pieces", () => {
    const lines = [
      { on: "2026-09-17", description: "HEW LLC/GENERIC 237.WWICHITA WEST WICHITA", amountCents: 898_431, key: "g" },
      { on: "2026-09-17", description: "HEW LLC/BRAND 237.WWICHITA WEST WICHITA", amountCents: 136_293, key: "b" },
      { on: "2026-09-17", description: "HEW LLC/FEES MISC 237.WWICHITA WEST WICHITA", amountCents: 35_000, key: "f" },
    ];
    const whole = placeLines(lines, { ...base, rebateReceipts: [{ id: "reb", amountCents: 1_069_724, receivedOn: "2026-09-17" }] });
    assert.deepEqual(whole.map((o) => o.placement.kind), ["confirms_rebate", "confirms_rebate", "confirms_rebate"]);
    const short = placeLines(lines.slice(0, 2), { ...base, rebateReceipts: [{ id: "reb", amountCents: 1_069_724, receivedOn: "2026-09-17" }] });
    assert.deepEqual(short.map((o) => o.placement.kind), ["rebate_part", "rebate_part"]);
  });
});
