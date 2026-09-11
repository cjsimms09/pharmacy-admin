import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readBankDescriptor, wouldDoubleCount } from "../src/lib/bank-descriptors";
import { placeLine } from "../src/lib/bank-statement";

/**
 * Every string below is copied from this pharmacy's August 2026 statement exactly as the scan
 * produced it, optical-recognition damage and all. That is deliberate: the statement arrives as an
 * image, so "HEARTLAND" reads as "HRTI-AND" and "FAMILY" as "TAMILY", and a matcher tested only on
 * clean text would pass here and fail on the real thing.
 */
describe("what each line on the bank statement is", () => {
  test("a McKesson ACH names the payment its accounts-payable report calls a check number", () => {
    const m = readBankDescriptor("MCKESSON DRUG/AUTO ACH ACH07172717 WEST WICHITA FAM PHCY", -12_142_915);
    assert.equal(m.kind, "wholesaler_ach");
    assert.equal(m.counterparty, "Mckesson");
    assert.equal(m.lands, "cost_of_goods");
    /* The bank says ACH07172717; the report says CKACH07172717. That is the tie. */
    assert.equal(m.matchTo?.reference, "CKACH07172717");
  });

  test("the scan turning O into 0 and l into 1 does not lose the reference", () => {
    /* "ACHO71886O5" is how the scan rendered ACH07188605. */
    const m = readBankDescriptor("MCKESSON DRUG/AUTO ACH ACHO71886O5 WEST WICHITA TAM PHCY", -12_964_533);
    assert.equal(m.matchTo?.reference, "CKACH07188605");
  });

  test("a McKesson debit is a caution, not a certainty — it depends on their report having arrived", () => {
    /* Certain only where the accounts-payable report exists. The ACH match below says so; this does not. */
    assert.equal(wouldDoubleCount("MCKESSON DRUG/AUTO ACH ACH07208859 WEST WICHITA TAM PHCY", -12_786_129), false);
    assert.match(readBankDescriptor("MCKESSON DRUG/AUTO ACH ACH07208859 WEST WICHITA TAM PHCY", -12_786_129).mayAlreadyBeCounted ?? "", /cash cost of goods/);
  });

  test("Heartland on the way out is the card fees the account keeps reporting missing", () => {
    const m = readBankDescriptor("HRT|-AN D PMT SYSTTXNS/FEES 650000010964875 WEST WICHITA FAI-IILY PH", -518_371);
    assert.equal(m.kind, "card_fees");
    assert.equal(m.lands, "operating");
    assert.equal(m.category, "Card processing and bank fees");
  });

  test("Heartland on the way in is the card takings, and only the direction separates them", () => {
    const m = readBankDescriptor("HRTLAN D PMT SYSTTXNSITEES 650000010964875 WEST WICilTTA FAMILY PH", 191_502);
    assert.equal(m.kind, "card_settlement");
    assert.equal(m.lands, "revenue");
    assert.equal(m.category, "patient");
  });

  test("every spelling the scan produced for Heartland is recognised", () => {
    for (const d of ["HRTLAND PMT SYST", "HRTI-AND PMT SYS/TXNS/FEES", "HRTTAN D PMT SYSTTXNS/FEES", "HRTI.AN D PMT SYS/TXNS/FEES"]) {
      assert.equal(readBankDescriptor(d, -1000).kind, "card_fees", `${d} should read as card fees`);
    }
  });

  test("postage is already on the books from Endicia's own email", () => {
    const m = readBankDescriptor("PurCh STAMPS.COM WASHINGTON DC", -10_000);
    assert.equal(m.kind, "postage");
    assert.equal(m.category, "Postage and shipping");
    assert.equal(wouldDoubleCount("PurCh STAMPS.COM WASHINGTON DC", -10_000), true);
  });

  test("a transfer to the pharmacy's own account is neither a cost nor revenue", () => {
    const m = readBankDescriptor("Ref AMEILHA To X6728 PSA", -4_500_000);
    assert.equal(m.kind, "internal_transfer");
    assert.equal(m.lands, "transfer");
    /* $45,000.00 is exactly the monthly payroll. Counting it here AND as payroll would be it twice. */
    assert.equal(wouldDoubleCount("Ref AMEILHA To X6728 PSA", -4_500_000), true);
  });

  test("a loan payment is below the line, not a cost", () => {
    const m = readBankDescriptor("Ln 8319 Pmt from DD 8855", -794_932);
    assert.equal(m.kind, "loan_payment");
    assert.equal(m.lands, "balance_sheet");
  });

  test("the wholesalers are told apart from each other", () => {
    assert.equal(readBankDescriptor("Independent Phar/WAREHOU SE 10689648 WEST WICHITA FAMILY PH", -157_18).counterparty, "IPC");
    assert.equal(readBankDescriptor("ParMed/)OOOOOOOOC( 2A571.67t99 222A Scott Kardatzke", -287_127).counterparty, "Parmed");
    assert.equal(readBankDescriptor("ANDA INC/BILL PMT KLXGSGNRgU 101100579", -820_502).counterparty, "Anda");
    assert.equal(readBankDescriptor("PuTch IN PHARMA SOLUTIO INGLEWOOD CA", -738_000).counterparty, "IN Pharma Solutions");
  });

  test("the running costs land in the categories the account already has", () => {
    assert.equal(readBankDescriptor("PIONEERRX/EPAY N51O-230 WEST WICHITA FAMILY PH", -223_312).category, "Software and systems");
    assert.equal(readBankDescriptor("CPESN LLC/CPESN USA Augu 20261548737182", -212_500).category, "Professional fees");
    assert.equal(readBankDescriptor("Purch ALERT 360 TULSA OK", -21_469).category, "Software and systems");
  });

  test("the money coming in is told apart by who sent it", () => {
    assert.equal(readBankDescriptor("ACCESS HEALTH/ACCESS HEA L722734 West Wichita Family Ph", 4_008_414).counterparty, "Access Health");
    assert.equal(readBankDescriptor("ProviderPay/EDI PYM NTS 489121084100001 West Wichita Family Ph", 464_254).counterparty, "ProviderPay");
    assert.equal(readBankDescriptor("MTF PM NGS/MTF PMT West Wichita Fam", 9_689).kind, "facilitator");
    assert.equal(readBankDescriptor("Prescription/TRA N S FER ST.J2HsP3LOMlL8", 337_322).kind, "transfer_in");
  });

  test("the same payer taking money back is not a cost", () => {
    const m = readBankDescriptor("PROVIDERPAY/AUTO SHA ACH ACHO72O4662 WEST WICHITA FAMILY PH", -63_558);
    assert.equal(m.kind, "payer_recoupment");
    assert.equal(m.lands, "revenue");
  });

  test("a line nobody recognises says so rather than being placed anyway", () => {
    const m = readBankDescriptor("SOME COMPANY NOBODY KNOWS", -12_345);
    assert.equal(m.kind, "unknown");
    assert.equal(m.lands, "unknown");
    assert.equal(wouldDoubleCount("SOME COMPANY NOBODY KNOWS", -12_345), false);
  });

  test("the facilitator and the copay cards carry a caution, and are still banked", () => {
    /*
     * Their remittances are read where they arrive and are not where they do not, so this is a
     * warning beside the line rather than a refusal to book it. Treating it as certain would drop
     * real deposits in silence, which is the worse of the two mistakes.
     */
    assert.equal(wouldDoubleCount("MTF PM NGS/MTF PMT West Wichita Fam", 9_689), false);
    assert.match(readBankDescriptor("MTF PM NGS/MTF PMT West Wichita Fam", 9_689).mayAlreadyBeCounted ?? "", /facilitator revenue/);
    assert.match(readBankDescriptor("REDSAIL CLAIMS COPAY", 50_000).mayAlreadyBeCounted ?? "", /third-party revenue/);
  });
});

/**
 * The line the whole reconciliation turns on.
 *
 * A McKesson ACH is a fortnight of invoices taken together. The generic rule looks for one open
 * invoice of exactly that amount, and there is no such invoice and never will be — so before this,
 * the single largest debit on the statement each month was the one line nothing could place.
 */
describe("placing a wholesaler ACH against the invoices inside it", () => {
  const settled = [
    { supplier: "Mckesson", invoiceNumber: "7656141694", checkNumber: "CKACH07227740", netCents: 6_388 },
    { supplier: "Mckesson", invoiceNumber: "7656141698", checkNumber: "CKACH07227740", netCents: 1_390_246 },
    { supplier: "Mckesson", invoiceNumber: "7657345034", checkNumber: null, netCents: 2_211_856 },
  ];
  const ctx = { payers: [], suppliers: [{ id: "s1", name: "Mckesson" }], vendors: [], unpaidBills: [], unpaidInvoices: [], settled };
  const line = (cents: number) => ({ on: "2026-09-07", description: "MCKESSON DRUG/AUTO ACH ACH07227740 WEST WICHITA FAM PHCY", amountCents: cents, key: "k" });

  test("the debit names every invoice it covers", () => {
    const p = placeLine(line(-1_396_634), ctx);
    assert.equal(p.kind, "settles_ach");
    if (p.kind !== "settles_ach") return;
    assert.equal(p.reference, "CKACH07227740");
    assert.deepEqual(p.invoices, ["7656141694", "7656141698"]);
    /* The invoice not yet taken is not in it. */
    assert.ok(!p.invoices.includes("7657345034"));
    assert.match(p.why, /comes to exactly this debit/);
  });

  test("a debit that does not come to what the ledger says is flagged, not silently accepted", () => {
    const p = placeLine(line(-1_400_000), ctx);
    assert.equal(p.kind, "settles_ach");
    if (p.kind !== "settles_ach") return;
    assert.match(p.why, /worth a look/);
  });

  test("without the wholesaler's ledger it is honestly unplaceable, not guessed", () => {
    const p = placeLine(line(-1_396_634), { ...ctx, settled: undefined });
    assert.notEqual(p.kind, "settles_ach");
  });
});
