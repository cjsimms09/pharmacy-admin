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
    /* Named as wages now the owner has confirmed it; still a transfer, and still books nothing. */
    assert.equal(m.kind, "wages_funding");
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
    assert.match(readBankDescriptor("ACCESS HEALTH/ACCESS HEA L722734 West Wichita Family Ph", 4_008_414).counterparty, /PSAO/);
    assert.match(readBankDescriptor("ProviderPay/EDI PYM NTS 489121084100001 West Wichita Family Ph", 464_254).counterparty, /PSAO/);
    assert.equal(readBankDescriptor("MTF PM NGS/MTF PMT West Wichita Fam", 9_689).kind, "facilitator");
    assert.equal(readBankDescriptor("Prescription/TRA N S FER ST.J2HsP3LOMlL8", 337_322).kind, "transfer_in");
  });

  test("the same payer taking money back is not a cost", () => {
    const m = readBankDescriptor("PROVIDERPAY/AUTO SHA ACH ACHO72O4662 WEST WICHITA FAMILY PH", -63_558);
    assert.equal(m.kind, "psao_recoupment");
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

/**
 * What the owner told us about the three lines nothing could name.
 *
 * "acess help i believe is our remits from our psao, provider pay is our PSAO" and "the transfer is
 * drugs we sell to the doctor office at cost".
 */
describe("the PSAO, and the drugs sold to the practice", () => {
  test("both PSAO names are one relationship, and the money is prescription revenue", () => {
    const access = readBankDescriptor("ACCESS HEALTH/ACCESS HEA L722734 West Wichita Family Ph", 4_008_414);
    const pp = readBankDescriptor("ProviderPay/EDI PYM NTS 489121084100001 West Wichita Family Ph", 464_254);
    assert.equal(access.kind, "psao_remittance");
    assert.equal(pp.kind, "psao_remittance");
    assert.equal(access.category, "third_party");
    assert.equal(pp.category, "third_party");
  });

  test("a PSAO remittance points at the payment report, which names it exactly", () => {
    const m = readBankDescriptor("ACCESS HEALTH/ACCESS HEA L722734 West Wichita Family Ph", 4_008_414);
    /*
     * August's ProviderPay report matches this deposit to exactly one payment: Health Mart Atlas
     * EFT-31312459 for $40,084.14. So it is the report, not the 835, that places these.
     */
    assert.match(m.matchTo?.feed ?? "", /ProviderPay payment report/);
    /* And two routes to one dollar, so the deposit carries the caution and the report carries the money. */
    assert.match(m.mayAlreadyBeCounted ?? "", /third-party revenue/);
  });

  test("the PSAO taking money back reduces revenue rather than adding a cost", () => {
    const m = readBankDescriptor("PROVIDERPAY/AUTO SHA ACH ACHO72O4662 WEST WICHITA FAMILY PH", -63_558);
    assert.equal(m.kind, "psao_recoupment");
    assert.equal(m.lands, "revenue");
  });

  test("drugs sold to the practice are not mistaken for a transfer between our own accounts", () => {
    /* The two lines are the same shape. Only the word "Medications" separates them. */
    const meds = readBankDescriptor("Ref AMIDQSP To *6728 Medications Aug 202", -1_591_281);
    const own = readBankDescriptor("Ref AMEILHA To X6728 PSA", -4_500_000);
    assert.equal(meds.kind, "practice_medications");
    assert.equal(own.kind, "wages_funding");
    /* Their cost is real and already in the books, so this is never "neither a cost nor revenue". */
    assert.equal(meds.lands, "cost_of_goods");
    assert.equal(own.lands, "transfer");
  });
});

/**
 * The one line on a statement that arrives with no payee.
 *
 * The bank prints "Check 2451" and an amount. Nothing else — no name, no reference. August's six
 * cheques would every one of them have landed unplaced, and one of them was the rent.
 */
describe("naming a cheque by what it is for", () => {
  const standing = [
    { name: "Rent", amountCents: 262_544, paidDay: 18 },
    { name: "Payroll", amountCents: 4_500_000, paidDay: 30 },
    { name: "Accounting", amountCents: 140_340, paidDay: 30 },
  ];
  const ctx = { payers: [], suppliers: [], vendors: [], unpaidBills: [], unpaidInvoices: [], standing };
  const cheque = (cents: number, no = "2451") => ({ on: "2026-09-18", description: `Check ${no}`, amountCents: -cents, key: `k${no}` });

  test("an exact match names the cost and books nothing", () => {
    const p = placeLine(cheque(262_544), ctx);
    assert.equal(p.kind, "confirms_standing");
    if (p.kind !== "confirms_standing") return;
    assert.equal(p.name, "Rent");
    assert.equal(p.exact, true);
    assert.match(p.why, /nothing is booked from this line/);
  });

  test("the delivery round is a candidate in its own month and the one after", () => {
    /*
     * The driver is paid for the trips he drove, so his cheque is a different figure every month and
     * the exact amount is the only handle the bank gives.
     *
     * This test used to assert the round was a candidate *only* in its own month — written to stop
     * one month's cheque confirming another month's round. Then the owner said how he actually pays:
     * "at end of month print that invoice and give driver a check", and on the timing, "It won't
     * clear on exact day, it will clear early in the next month for same amount as delivery."
     *
     * So the case this test enforced — September's round unmatched by an October cheque — was the
     * *normal* case, and it sent him to place the line by hand every month. The window is now the
     * line's month and the one before it. Two rounds late is still refused, below.
     */
    const withRound = [...standing, { name: "The delivery round for September 2026", amountCents: 48_600, paidDay: null, month: "2026-09" }];
    const p = placeLine(cheque(48_600), { ...ctx, standing: withRound });
    assert.equal(p.kind, "confirms_standing");
    if (p.kind !== "confirms_standing") return;
    assert.match(p.name, /delivery round/);

    /* Early in October, paying September's round: the ordinary case, and it must be placed. */
    const october = placeLine({ ...cheque(48_600), on: "2026-10-06" }, { ...ctx, standing: withRound });
    assert.equal(october.kind, "confirms_standing");
    if (october.kind !== "confirms_standing") return;
    assert.match(october.name, /September/);

    /* November is two rounds late and must not confirm September. */
    const november = placeLine({ ...cheque(48_600), on: "2026-11-04" }, { ...ctx, standing: withRound });
    assert.equal(november.kind, "unplaced");
  });

  test("a figure near a standing cost is NOT taken for it", () => {
    /*
     * Cheque 2449 for $1,449.00 sits 3.2% from the accountant's $1,403.40 and is not the accountant
     * at all — it is drugs sold to the practice at cost. A tolerance wide enough to catch a rent
     * rise is wide enough to swallow this, and the wrong answer would have had somebody change a
     * standing cost that was correct.
     */
    const p = placeLine(cheque(144_900, "2449"), ctx);
    assert.equal(p.kind, "unplaced");
    assert.match(p.why, /yours to categorise/);
  });



  test("two costs at the same figure is refused rather than guessed", () => {
    const twins = [...standing, { name: "Something else", amountCents: 262_544, paidDay: 1 }];
    const p = placeLine(cheque(262_544), { ...ctx, standing: twins });
    assert.equal(p.kind, "unplaced");
    assert.match(p.why, /cannot be told from the amount alone/);
  });

  test("a line that is not a cheque is left to the ordinary rules", () => {
    const p = placeLine({ on: "2026-09-18", description: "MCKESSON DRUG/AUTO ACH ACH07227740", amountCents: -262_544, key: "x" }, ctx);
    assert.notEqual(p.kind, "confirms_standing");
  });
});

/**
 * The largest single line leaving the account each month.
 *
 * The owner: "did you see 45k transfer that is for wages?" It is exactly the payroll standing cost,
 * and it is a transfer rather than a payment — the money moves to the account payroll is run from.
 */
describe("wages, funded by transfer", () => {
  test("it is named as wages rather than as an anonymous transfer", () => {
    const m = readBankDescriptor("Ref AMEILHA To X6728 PSA", -4_500_000);
    assert.equal(m.kind, "wages_funding");
    assert.equal(m.counterparty, "the payroll account");
  });

  test("it books nothing, because the payroll standing cost already carries it", () => {
    assert.equal(wouldDoubleCount("Ref AMEILHA To X6728 PSA", -4_500_000), true);
    assert.match(readBankDescriptor("Ref AMEILHA To X6728 PSA", -4_500_000).alreadyCounted ?? "", /Wages and salaries/);
  });

  test("a transfer that is not the payroll one stays an ordinary transfer", () => {
    assert.equal(readBankDescriptor("Ref AMZZZZZZ To X6728 SAVINGS", -100_000).kind, "internal_transfer");
    /* And the medications one is still its own thing. */
    assert.equal(readBankDescriptor("Ref AMIDQSP To *6728 Medications Aug 202", -1_591_281).kind, "practice_medications");
  });
});

/**
 * The costs the site already carries, which a bank line must not add a second time.
 *
 * The owner: "alert 360 and wages shouldnt duplicate (already set in the site)". Wages were
 * guarded and the alarm was not — it is a standing cost accruing by the day, so booking the card
 * purchase on top of it would have been the alarm contract twice, every month, quietly.
 */
describe("a standing cost paid by card is not a second cost", () => {
  test("Alert 360 is already counted, so the card purchase adds nothing", () => {
    const m = readBankDescriptor("Purch ALERT 360 TULSA OK", -21_469);
    assert.equal(m.category, "Software and systems");
    assert.equal(wouldDoubleCount("Purch ALERT 360 TULSA OK", -21_469), true);
    assert.match(m.alreadyCounted ?? "", /standing cost already carries/);
  });

  test("PioneerRx is a caution, because their invoice has not arrived yet", () => {
    /* "pioneer should match invoice we willr eceive from them for previous month" — so the two are
       one charge, and whichever is on file first is the one counted. */
    const m = readBankDescriptor("PIONEERRX/EPAY N510-230 WEST WICHITA FAMILY PH", -223_312);
    assert.equal(wouldDoubleCount("PIONEERRX/EPAY N510-230 WEST WICHITA FAMILY PH", -223_312), false);
    assert.match(m.mayAlreadyBeCounted ?? "", /monthly invoice/);
  });
});

/**
 * Two wholesalers whose names both begin "Independent Pharmacy".
 *
 * The owner: "are we able to see difference between IPD and IPC on bank statement?" Only by the
 * customer number — every one of August's eleven debits carries 10689648, which is this pharmacy's
 * number with IPC and is printed on IPC's own credit memo.
 */
describe("telling IPC from IPD", () => {
  test("a debit carrying IPC's own customer number is IPC", () => {
    assert.equal(readBankDescriptor("Independent Phar/WAREHOUSE 10689648 WEST WICHITA FAMILY PH", -157_18).counterparty, "IPC");
    /* The scan renders the same line several ways; all of them carry the number. */
    assert.equal(readBankDescriptor("Independent P ha r/WAREHOU S[ 10689648 WEST WICHITA FAMILY PH", -314_093).counterparty, "IPC");
  });

  test("a similarly named wholesaler with a different number is not claimed as IPC", () => {
    /*
     * The collision that would put IPD's money against IPC's invoices. The account would still
     * balance and every supplier total would be wrong, which is the kind of error nobody finds.
     */
    const other = readBankDescriptor("Independent Phar/WAREHOUSE 99887766 WEST WICHITA FAMILY PH", -300_000);
    assert.notEqual(other.counterparty, "IPC");
  });
});
