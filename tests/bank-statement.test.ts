import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseBankStatement, bankDate, bankCents, placeLines, lineKey, type MatchContext } from "../src/lib/bank-statement";

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

describe("the fixed monthly debits and the counter's deposits (1 October 2026)", () => {
  const base: MatchContext = { payers: [], suppliers: [], vendors: [], unpaidBills: [], unpaidInvoices: [], booksStartOn: "2026-09-01" };
  const one = (on: string, description: string, amountCents: number, ctx: MatchContext = base) => placeLines([{ on, description, amountCents, key: description + amountCents }], ctx)[0].placement;

  test("each fixed monthly debit books itself under its category, with the payee named", () => {
    const cases: [string, number, string][] = [
      ["KSDEPTOFREVENUE/TAXDRAFTS 999000000000F01 WEST WICHITA FAM", -112_766, "Sales tax remitted"],
      ["Ln 9999 Pmt from DD 9999", -794_932, "Loan principal"],
      ["CPESN USA LLC/CPESN Sep CPESN SEP 2026999 WEST WICHITA", -12_500, "Professional fees"],
      ["PIONEERRX/EPAY N999-999 WEST WICHITA FAMILY PH", -234_729, "Software and systems"],
      ["SHA PROVIDERPAY/AUTO ACH CKACH9990001 WEST WICHITA FAMILY P", -53_599, "Professional fees"],
      ["HRTLAND PMT SYS/TXNS/FEES 650000019999999 WEST WICHITA FAM", -477_873, "Card processing and bank fees"],
    ];
    for (const [d, cents, category] of cases) {
      const p = one("2026-09-15", d, cents, { ...base, cardFeeBills: [] });
      assert.equal(p.kind, "books_bill", d);
      assert.equal(p.kind === "books_bill" ? p.category : "", category, d);
    }
  });

  test("a PioneerRx bill already on file for the amount still wins over the fixed rule", () => {
    const ctx = { ...base, vendors: [{ id: "v", name: "RedSail Technologies (PioneerRx)" }], unpaidBills: [{ id: "b", vendorId: "v", vendorName: "RedSail Technologies (PioneerRx)", amountCents: 234_729, invoiceDate: "2026-09-10" }] };
    const p = one("2026-09-22", "PIONEERRX/EPAY N999-999 WEST WICHITA FAMILY PH", -234_729, ctx);
    assert.equal(p.kind, "pays_bill");
  });

  const register = [
    { id: "d1", amountCents: 36_001, receivedOn: "2026-09-01" },
    { id: "d2", amountCents: 5_350, receivedOn: "2026-09-02" },
    { id: "d3", amountCents: 17_846, receivedOn: "2026-09-03" },
    { id: "d4", amountCents: 8_813, receivedOn: "2026-09-04" },
    { id: "d5", amountCents: 1_058, receivedOn: "2026-09-05" },
    { id: "d6", amountCents: 24_263, receivedOn: "2026-09-08" },
    { id: "d7", amountCents: 21_457, receivedOn: "2026-09-09" },
  ];

  test("three counter deposits on one day are the first week, the second week, and something else — whichever order the bank lists them", () => {
    const out = placeLines(
      [
        { on: "2026-09-16", description: "Deposit", amountCents: 45_720, key: "a" },
        { on: "2026-09-16", description: "Deposit", amountCents: 69_069, key: "b" },
        { on: "2026-09-16", description: "Deposit", amountCents: 23_267, key: "c" },
      ],
      { ...base, registerDeposits: register },
    );
    const [week2, week1, other] = out.map((o) => o.placement);
    assert.equal(week1.kind, "confirms_run");
    assert.deepEqual(week1.kind === "confirms_run" ? [week1.receiptIds, week1.overShortCents] : [], [["d1", "d2", "d3", "d4", "d5"], 1]);
    assert.equal(week2.kind, "confirms_run");
    assert.deepEqual(week2.kind === "confirms_run" ? [week2.receiptIds, week2.overShortCents] : [], [["d6", "d7"], 0]);
    assert.equal(other.kind, "unplaced");
  });

  test("a deposit more than a dollar from any run is not those days", () => {
    const p = one("2026-09-16", "Deposit", 70_000, { ...base, registerDeposits: register });
    assert.equal(p.kind, "unplaced");
  });

  test("a run never reaches past the deposit's own day", () => {
    const p = one("2026-09-03", "Deposit", 41_351, { ...base, registerDeposits: register });
    assert.equal(p.kind, "confirms_run");
    assert.deepEqual(p.kind === "confirms_run" ? p.receiptIds : [], ["d1", "d2"]);
  });
});

describe("his answers of 1 October, the second round", () => {
  const base: MatchContext = { payers: [], suppliers: [{ id: "rrc", name: "RrcPharmaSolution" }, { id: "ipc", name: "IPC", accountNumber: "10689648" }], vendors: [], unpaidBills: [], unpaidInvoices: [], booksStartOn: "2026-09-01" };
  const one = (on: string, description: string, amountCents: number, ctx: MatchContext = base) => placeLines([{ on, description, amountCents, key: description + amountCents }], ctx)[0].placement;

  test("copay-programme money banks under the programme's own payer, whatever else the line says", () => {
    const p = one("2026-09-09", "POC NETWORK TECH/RSCOPAY REDSAIL CLAIMS COPAY 10274407 West Wichita", 21_198, { ...base, payers: ["Hippo Network LLC", "RedSail Claims"] });
    assert.equal(p.kind, "deposit");
    assert.match(p.kind === "deposit" ? p.payer ?? "" : "", /copay/i);
  });

  test("Anthropic is a subscription, booked from the line", () => {
    const p = one("2026-09-25", "Purch ANTHROPIC* CLAUDE SUB SAN FRANCISCO CA", -16_412);
    assert.equal(p.kind, "books_bill");
    assert.equal(p.kind === "books_bill" ? [p.category, p.vendor].join("|") : "", "Software and systems|Anthropic");
  });

  test("a card purchase from a drug supplier is confirmed by PioneerRx's receipt of the same amount — the receipt is the invoice", () => {
    const ctx = { ...base, receipts: [{ id: "r1", number: "7000000001", supplier: "RrcPharmaSolution", totalCents: 822_000, invoiceDate: "2026-09-23" }] };
    const p = one("2026-09-24", "Purch IN *RRC PHARMA SOLUTIO INGLEWOOD CA", -822_000, ctx);
    assert.equal(p.kind, "already_counted");
    assert.match(p.why, /PioneerRx received/);
    const none = one("2026-09-24", "Purch IN *RRC PHARMA SOLUTIO INGLEWOOD CA", -822_001, ctx);
    assert.equal(none.kind, "unplaced");
  });

  test("a wholesaler's draw is the day's receiving its cadence names, even among thirty candidates", () => {
    const receipts = [
      { id: "a", number: "7000000002", supplier: "IPC", totalCents: 10_480, invoiceDate: "2026-09-17" },
      { id: "b", number: "7000000003", supplier: "IPC", totalCents: 84_162, invoiceDate: "2026-09-17" },
      { id: "c", number: "7000000004", supplier: "IPC", totalCents: 94_642, invoiceDate: "2026-09-10" },
    ];
    const cadences = { IPC: { lagDays: 7, spanDays: 1, from: 3, says: "a draw pays the billing of a week before" } };
    const p = one("2026-09-24", "Independent Phar/WAREHOUSE 10689648 WEST WICHITA FAMILY PH", -94_642, { ...base, receipts, cadences });
    assert.equal(p.kind, "pays_invoices");
    assert.deepEqual(p.kind === "pays_invoices" ? p.invoiceIds.sort() : [], ["a", "b"]);
  });

  test("two remittance sets of the same cents: the one remitted nearest the deposit is the deposit's", () => {
    const remits = [
      { id: "old", payer: "SS&C HEALTH", remitOn: "2026-09-15", amountCents: 200_800, paymentNumber: "999000000000011", remitNumber: "7000000011" },
      { id: "new", payer: "SS&C HEALTH", remitOn: "2026-09-23", amountCents: 200_800, paymentNumber: null, remitNumber: "7000000012" },
    ];
    const p = one("2026-09-24", "ProviderPay/EDI PYMNTS 489121084100001 West Wichita Family Ph", 200_800, { ...base, remits });
    assert.equal(p.kind, "banks_remits");
    assert.deepEqual(p.kind === "banks_remits" ? p.remits.map((r) => r.id) : [], ["new"]);
  });

  test("the facilitator paying a remittance late, with interest, is that remittance plus the interest — and only where that day still waits", () => {
    const ctx = { ...base, facilitatorPaid: [{ on: "2026-08-18", cents: 131_521 }, { on: "2026-08-19", cents: 121_618 }], facilitatorConfirmedDays: ["2026-08-19"] };
    const p = one("2026-09-04", "MTF PM NGS/MTF PMT", 131_696, ctx);
    assert.equal(p.kind, "facilitator_late");
    assert.deepEqual(p.kind === "facilitator_late" ? [p.day, p.interestCents] : [], ["2026-08-18", 175]);
    const confirmed = one("2026-09-04", "MTF PM NGS/MTF PMT", 131_696, { ...ctx, facilitatorConfirmedDays: ["2026-08-18", "2026-08-19"] });
    assert.equal(confirmed.kind, "facilitator_unmatched");
  });
});

describe("a wholesaler's ACH in the books' first fortnight", () => {
  test("the invoices the ledger names are settled, and the rest is said to be August's — not 'worth a look'", () => {
    const ctx: MatchContext = { payers: [], suppliers: [{ id: "mck", name: "Mckesson" }], vendors: [], unpaidBills: [], unpaidInvoices: [], booksStartOn: "2026-09-01", settled: [{ supplier: "Mckesson", invoiceNumber: "7000000021", checkNumber: "CKACH00000002", netCents: 10_000_000 }] };
    const early = placeLines([{ on: "2026-09-08", description: "MCKESSON DRUG/AUTO ACH ACH00000002 WEST WICHITA FAM PHCY", amountCents: -11_500_000, key: "m1" }], ctx)[0].placement;
    assert.equal(early.kind, "settles_ach");
    assert.equal(early.kind === "settles_ach" ? early.agrees : false, true);
    assert.match(early.why, /August's invoices/);
    const late = placeLines([{ on: "2026-09-29", description: "MCKESSON DRUG/AUTO ACH ACH00000002 WEST WICHITA FAM PHCY", amountCents: -11_500_000, key: "m2" }], ctx)[0].placement;
    assert.equal(late.kind === "settles_ach" ? late.agrees : true, false);
  });
});
