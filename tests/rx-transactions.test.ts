import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseRxTransactions,
  planTransactions,
  repairNumericId,
  parseSectionLabel,
  mdyToIso,
  looksLikeRxTransactions,
  readTotalsLine,
  type Transaction,
} from "../src/lib/rx-transactions";

/**
 * The daily claims feed: PioneerRx's "Rx Transaction Details By Submission Type" report, a printed
 * report saved as text. Every row is a transaction, and a claim paid, reversed and resubmitted is
 * three of them — so the reader and the pairing are tested apart, on the shapes the real file has.
 */
const HEAD = [
  "Rx Transaction Details By Submission Type (BETA)",
  "West Wichita Family Pharmacy",
  " Uses invoice cost based on cost for profit settings. Includes columns for estimated rebates and estimated dir fees.Based on claims transmitted/processed from ",
  "9/5/2026 12:00:00 AM, to ,9/6/2026 12:00:00 AM",
  "Third Party,Script",
  "Dispensing Fee,Completed Date",
  "Rx Number,Status,Amount,Group,Ntw Reim. Id,Copay,Total,Date Filled,BIN,Tax,QTY,Acq. Inv. Cost,PCN,NDC,GrossProfit",
  "Transmitted",
];
const FOOT = ["9/5/2026 1:51 PM,*Evoucher Paid is a portion of the third party total.,Page 1 of 1"];

const file = (...body: string[]) => [...HEAD, ...body, ...FOOT].join("\r\n");

const SAMPLE = file(
  "Third Party:,003858(A4) - 003858",
  // paid, sold
  "336853-0,P,$13.62,2ELA,CNCKSNPN,$0.00,$10.50,$0.00,9/5/2026 9:23:51 AM,09/05/26,003858,20.0000,$2.53,A4,57237002901,$11.31",
  // paid, not yet sold
  "321666-4,P,$11.36,2CYA,EN45,$0.00,$10.50,$0.00,,09/05/26,003858,30.0000,$0.71,A4,68094090460,$11.15",
  // rejected
  "336856-0,R,$0.00,DAVITRX,,$0.00,$0.00,$0.00,9/5/2026 11:19:08 AM,09/05/26,003858,0.0000,$0.00,A4,11534016003,$0.00",
  "003858(A4) - 003858 Totals:",
  "$44.60,$0.00,$44.60,$3.00,$0.00,$3.00,$0.00,$47.60,$0.00,$0.00,$7.18,($1.92),$0.00,$0.00,$42.34",
  "Third Party:,004336 (ADV) - 004336",
  // paid, reversed, resubmitted with a different NDC — all sold
  "336860-0,P,$8.81,RX1600,CNTRCT1010,$2.20,$10.50,$2.20,9/5/2026 11:32:08 AM,09/05/26,004336,15.0000,$0.39,ADV,10702001101,$11.11",
  "336860-0,A,($8.81),RX1600,,($2.20),$0.00,($2.20),9/5/2026 11:32:08 AM,09/05/26,004336,-15.0000,($0.39),ADV,10702001101,($11.11)",
  "336860-0,P,$8.81,RX1600,CNTRCT1010,$2.20,$10.50,$2.20,9/5/2026 11:32:08 AM,09/05/26,004336,15.0000,$1.22,ADV,16714008210,$10.28",
  // a reversal of a claim paid on an earlier day
  '331488-1,A,"($1,204.25)",RX1606,,$0.00,$0.00,$0.00,9/5/2026 10:52:28 AM,09/04/26,004336,-60.0000,"($1,153.52)",ADV,81968004560,($50.73)',
  "20",
  // Not a value of any kind: still page furniture, and still skipped.
  "~ ~",
  "Third Party:,610455 (BCBSKS) - 610455",
  // group formatted as money by PioneerRx
  '319184-3,P,$12.56,"$714,553,005.00",BIDBRODCBR,$0.00,$10.50,$0.00,9/5/2026 9:00:00 AM,09/05/26,610455,30.0000,$1.91,BCBSKS,42806008805,$12.29',
  "Third Party:,PharmD Loyalty Plan - 028249",
  "324333-3,P,$0.00,,,$7.00,$0.00,$7.00,9/5/2026 10:59:12 AM,09/05/26,028249,30.0000,$3.07,RXLOCAL,16714025802,$5.16",
);

describe("reading the report", () => {
  const r = parseRxTransactions(SAMPLE);

  test("it is recognised by its title, and its period and print date are read", () => {
    assert.ok(looksLikeRxTransactions(SAMPLE));
    assert.ok(!looksLikeRxTransactions("Supplier Catalog Item Search Results\nMcKesson"));
    assert.deepEqual(r.period, { from: "2026-09-05", to: "2026-09-06" });
    assert.equal(r.printedOn, "2026-09-05");
    assert.deepEqual(r.problems, []);
  });

  test("every transaction row is read; totals, footers, section lines and page fragments are not", () => {
    assert.equal(r.rows.length, 9);
    assert.equal(r.reasons["a page-break fragment"], 1, "only what is furniture is discarded");
  });

  test("a bare number standing alone is a wrapped days supply, not furniture", () => {
    // The report is wider than its page, so a cell that will not fit prints on a line of its own.
    // Discarding those is what left days supply at 0 of 1,590 and every contract rate uncomputable.
    const t = r.rows.find((x) => x.rxNumber === "331488");
    assert.equal(t?.daysSupply, 20);
  });

  test("the fields land where they belong", () => {
    const t = r.rows[0];
    assert.equal(t.rxNumber, "336853");
    assert.equal(t.fillNumber, 0);
    assert.equal(t.status, "P");
    assert.equal(t.bin, "003858");
    assert.equal(t.pcn, "A4");
    assert.equal(t.groupNumber, "2ELA");
    assert.equal(t.networkId, "CNCKSNPN");
    assert.equal(t.dateFilled, "2026-09-05");
    assert.equal(t.quantityThousandths, 20_000);
    assert.equal(t.remitCents, 1362);
    assert.equal(t.copayCents, 0);
    assert.equal(t.dispensingFeeCents, 1050);
    assert.equal(t.ndc11, "57237002901");
    assert.equal(t.payerLabel, "003858(A4)");
    assert.ok(t.completedAt);
  });

  test("ingredient cost paid is plan paid plus copay less the dispensing fee", () => {
    const t = r.rows[0];
    assert.equal(t.ingredientPaidCents, 1362 + 0 - 1050);
    const withCopay = r.rows.find((x) => x.rxNumber === "336860" && x.status === "P")!;
    assert.equal(withCopay.ingredientPaidCents, 881 + 220 - 1050);
  });

  test("a reversal carries negated figures and a negative quantity", () => {
    const a = r.rows.find((x) => x.rxNumber === "336860" && x.status === "A")!;
    assert.equal(a.remitCents, -881);
    assert.equal(a.quantityThousandths, -15_000);
  });

  test("a group number PioneerRx formatted as money is put back", () => {
    assert.equal(repairNumericId("$714,553,005.00"), "714553005");
    assert.equal(repairNumericId("$2.00"), "2");
    assert.equal(repairNumericId("2ELA"), "2ELA");
    assert.equal(r.rows.find((x) => x.rxNumber === "319184")!.groupNumber, "714553005");
  });

  test("the section line gives the payer label, its BIN and a PCN hint", () => {
    assert.deepEqual(parseSectionLabel("003858 (MA) - 003858"), { label: "003858 (MA)", bin: "003858", pcnHint: "MA" });
    assert.deepEqual(parseSectionLabel("PharmD Loyalty Plan - 028249"), { label: "PharmD Loyalty Plan", bin: "028249", pcnHint: null });
    assert.deepEqual(parseSectionLabel("005377 (10000019)- City of Wichita - 005377"), { label: "005377 (10000019)- City of Wichita", bin: "005377", pcnHint: "10000019" });
  });

  test("two identical rows on one day are two transactions with distinct keys", () => {
    const twice = file(
      "Third Party:,028250 - 028250",
      "327714-2,P,$0.00,G,,$15.00,$0.00,$15.00,9/5/2026 1:00:00 PM,09/05/26,028250,28.0000,$5.70,X,68462072029,$9.30",
      "327714-2,P,$0.00,G,,$15.00,$0.00,$15.00,9/5/2026 1:00:00 PM,09/05/26,028250,28.0000,$5.70,X,68462072029,$9.30",
    );
    const keys = parseRxTransactions(twice).rows.map((t) => t.transactionKey);
    assert.equal(new Set(keys).size, 2);
  });

  test("dates come as 09/05/26 or 9/5/2026", () => {
    assert.equal(mdyToIso("09/05/26"), "2026-09-05");
    assert.equal(mdyToIso("9/5/2026 9:23:51 AM"), "2026-09-05");
  });

  test("a changed column list refuses the file with the change named, rather than reading by wrong positions", () => {
    const changed = SAMPLE.replace("Rx Number,Status,Amount,Group,Ntw Reim. Id,Copay,Total,Date Filled,BIN,Tax,QTY,Acq. Inv. Cost,PCN,NDC,GrossProfit", "Rx Number,Status,Amount,Group,Ntw Reim. Id,Copay,Total,Date Filled,BIN,Tax,QTY,Acq. Inv. Cost,PCN,GrossProfit");
    const bad = parseRxTransactions(changed);
    assert.equal(bad.rows.length, 0);
    assert.ok(bad.problems.some((p) => /columns have changed: NDC/.test(p)), bad.problems.join(" | "));
  });

  test("a row whose cells do not have the expected shapes is counted, not read wrong", () => {
    const odd = file("Third Party:,003858(A4) - 003858", "336853-0,P,$13.62,2ELA,CNCKSNPN,$0.00,$10.50,$0.00,9/5/2026 9:23:51 AM,09/05/26,NOTABIN,20.0000,$2.53,A4,57237002901,$11.31");
    const r2 = parseRxTransactions(odd);
    assert.equal(r2.rows.length, 0);
    assert.equal(r2.reasons["a row whose BIN cell is not a six-digit BIN"], 1);
  });
});

describe("deciding what each transaction does", () => {
  const rows = parseRxTransactions(SAMPLE).rows;
  const plan = planTransactions(rows, { keys: new Set(), paid: [] }, { ignoreBins: ["028249"] });

  test("a paid, sold row becomes a claim", () => {
    assert.ok(plan.insertPaid.some((t) => t.rxNumber === "336853"));
  });

  test("a paid row with no completed date is stored too, with the sale date blank: the report is drawn by transmission day and it will not come round again", () => {
    const t = plan.insertPaid.find((x) => x.rxNumber === "321666");
    assert.ok(t);
    assert.equal(t.completedAt, null);
    assert.ok(!plan.skipped.some((s) => s.txn.rxNumber === "321666"));
  });

  test("a reversal with no completed date still takes back the claim it names — that is how a return to stock arrives", () => {
    const unsoldThenReturned = file(
      "Third Party:,610455 (KSPDP) - 610455",
      "334136-0,A,$0.00,10198268F,,($0.62),$0.00,($0.62),,09/02/26,610455,-5.0000,($0.68),KSPDP,72603070102,($0.42)",
    );
    const earlier = { id: "c9", rxNumber: "334136", fillNumber: 0, bin: "610455", ndc11: "72603070102", remitCents: 0, copayCents: 62 };
    const p = planTransactions(parseRxTransactions(unsoldThenReturned).rows, { keys: new Set(), paid: [earlier] });
    assert.deepEqual(p.reverseExisting.map((r) => r.claimId), ["c9"]);
  });

  test("a re-sent row that now carries a completed date fills the sale date in, and nothing else changes", () => {
    const unsoldKey = rows.find((x) => x.rxNumber === "321666")!.transactionKey;
    const later = SAMPLE.replace(
      "321666-4,P,$11.36,2CYA,EN45,$0.00,$10.50,$0.00,,09/05/26",
      "321666-4,P,$11.36,2CYA,EN45,$0.00,$10.50,$0.00,9/7/2026 4:10:00 PM,09/05/26",
    );
    const p = planTransactions(parseRxTransactions(later).rows, { keys: new Set([unsoldKey]), paid: [], unsold: new Map([[unsoldKey, "c7"]]) }, { ignoreBins: ["028249"] });
    assert.deepEqual(p.markSold, [{ claimId: "c7", completedAt: "9/7/2026 4:10:00 PM" }]);
    assert.equal(p.duplicates, 1);
    assert.ok(!p.insertPaid.some((t) => t.rxNumber === "321666"));
  });

  test("the PCN is read in one case however the plan was typed", () => {
    const typed = file("Third Party:,610014 (MEDDPRIME) - 610014", "330001-0,P,$5.00,G1,,$0.00,$1.00,$0.00,,09/05/26,610014,30.0000,$1.00,meddprime,00093505698,$3.00");
    assert.equal(parseRxTransactions(typed).rows[0].pcn, "MEDDPRIME");
  });

  test("a rejected row is set aside with a reason", () => {
    assert.ok(plan.skipped.some((s) => s.txn.rxNumber === "336856" && /rejected/.test(s.why)));
  });

  test("the cash plan is kept and marked, not thrown away", () => {
    /*
     * It used to be discarded on import, which silently deleted the margin on the only business
     * the pharmacy prices itself — on one real week that was $4,250.50 of gross profit, better than
     * a quarter of everything the dispensary made, simply absent. It is a fill: it sold a bottle and
     * it made or lost money.
     *
     * Marked rather than merged, because no question about plans applies to it. There is no floor
     * for the state to enforce on a price the pharmacy set, no contract to appeal under, and a
     * number below NADAC is what it charged rather than a shortfall to claim.
     */
    assert.ok(!plan.skipped.some((s) => s.txn.rxNumber === "324333"), "no longer set aside");
    const kept = plan.insertPaid.find((t) => t.rxNumber === "324333");
    assert.ok(kept, "and it is stored");
    assert.equal(kept!.cashPlan, true, "flagged as the pharmacy's own price, not an insurer's");
  });

  test("paid, reversed and resubmitted in one file: the first is stored reversed, the second stands", () => {
    const reversed = plan.insertReversedPaid.filter((x) => x.paid.rxNumber === "336860");
    assert.equal(reversed.length, 1);
    assert.equal(reversed[0].paid.ndc11, "10702001101");
    const standing = plan.insertPaid.filter((t) => t.rxNumber === "336860");
    assert.equal(standing.length, 1);
    assert.equal(standing[0].ndc11, "16714008210");
  });

  test("a reversal of a claim paid on an earlier day marks that claim reversed", () => {
    const earlier = {
      id: "c1", rxNumber: "331488", fillNumber: 1, bin: "004336", ndc11: "81968004560", remitCents: 120_425, copayCents: 0,
    };
    const p2 = planTransactions(rows, { keys: new Set(), paid: [earlier] }, { ignoreBins: ["028249"] });
    assert.deepEqual(p2.reverseExisting.map((r) => r.claimId), ["c1"]);
    assert.equal(p2.insertUnmatchedReversal.length, 0);
  });

  test("a reversal that matches nothing we hold is kept as a reversed row, never dropped", () => {
    assert.equal(plan.insertUnmatchedReversal.length, 1);
    assert.equal(plan.insertUnmatchedReversal[0].rxNumber, "331488");
  });

  test("a reversal never cancels a claim whose figures differ", () => {
    const wrongAmount = { id: "c2", rxNumber: "331488", fillNumber: 1, bin: "004336", ndc11: "81968004560", remitCents: 120_000, copayCents: 0 };
    const p3 = planTransactions(rows, { keys: new Set(), paid: [wrongAmount] }, { ignoreBins: ["028249"] });
    assert.equal(p3.reverseExisting.length, 0);
    assert.equal(p3.insertUnmatchedReversal.length, 1);
  });

  test("the same day's report sent twice changes nothing the second time", () => {
    const keys = new Set<string>([
      ...plan.insertPaid.map((t) => t.transactionKey),
      ...plan.insertReversedPaid.flatMap((x) => [x.paid.transactionKey, x.reversal.transactionKey]),
      ...plan.insertUnmatchedReversal.map((t) => t.transactionKey),
    ]);
    const again = planTransactions(rows, { keys, paid: [] }, { ignoreBins: ["028249"] });
    assert.equal(again.insertPaid.length, 0);
    assert.equal(again.insertReversedPaid.length, 0);
    assert.equal(again.insertUnmatchedReversal.length, 0);
    assert.equal(again.duplicates, keys.size);
  });

  test("with the completed-date rule switched on, unsold rows wait instead", () => {
    const sold = planTransactions(rows, { keys: new Set(), paid: [] }, { ignoreBins: ["028249"], requireCompleted: true });
    assert.ok(!sold.insertPaid.some((t: Transaction) => t.rxNumber === "321666"));
    assert.ok(sold.skipped.some((s) => s.txn.rxNumber === "321666" && /not yet sold/.test(s.why)));
  });
});

describe("the fixture cut from a real day's report", () => {
  const text = fs.readFileSync(new URL("../fixtures/rx-transactions.txt", import.meta.url), "utf8");
  const r = parseRxTransactions(text);

  test("reads with no problems, across a page break, and every row kind lands", () => {
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.period, { from: "2026-09-05", to: "2026-09-06" });
    const by = (rx: string) => r.rows.filter((t) => t.rxNumber === rx);
    assert.equal(by("400001").length, 1); // sold
    assert.equal(by("400002").length, 1); // not picked up
    assert.equal(by("400005").length, 2); // primary and secondary payer for one fill
    assert.equal(by("400009")[0].completedAt, "6/27/2026 3:12:40 PM"); // completed date is the fill's, whatever day the row is from
    assert.equal(by("400006")[0].groupNumber, "714553005");
    assert.ok(r.rows.filter((t) => t.status === "A").length >= 4);
  });

  test("planned against nothing held: money is kept from the day the plan agreed to it", () => {
    const plan = planTransactions(r.rows, { keys: new Set(), paid: [] }, { ignoreBins: ["028249"] });
    assert.ok(plan.insertPaid.some((t) => t.rxNumber === "400002" && t.completedAt === null));
    assert.equal(plan.insertReversedPaid.filter((x) => x.paid.rxNumber === "400004").length, 1);
    assert.ok(plan.skipped.every((s) => /rejected|cash plan/.test(s.why)));
  });
});

/**
 * The report gaining a column, which is the failure this reader most has to survive.
 *
 * A column added anywhere but the end shifts every field after it, and every figure then read is
 * individually plausible and collectively wrong — a dispensing fee taken for a patient total, a tax
 * for a quantity. Nothing downstream can notice: it does not look like an error, it looks like a
 * bad day's trading. So the layout is no longer assumed, it is chosen by evidence, and the strongest
 * evidence is the report's own arithmetic: GrossProfit = Amount + Total − Acq. Inv. Cost.
 */
describe("a column added to the report", () => {
  const HEAD17 = [
    "Rx Transaction Details By Submission Type (BETA)",
    "West Wichita Family Pharmacy",
    "9/5/2026 12:00:00 AM, to ,9/6/2026 12:00:00 AM",
    "Third Party,Script",
    "Dispensing Fee,Completed Date",
    "Rx Number,Status,Amount,Group,Ntw Reim. Id,Copay,Total,Date Filled,BIN,Tax,QTY,Acq. Inv. Cost,PCN,NDC,GrossProfit,Est MTF",
    "Transmitted",
  ];
  const FOOT17 = ["9/5/2026 1:51 PM,Page 1 of 1"];

  /*
   * Rows whose gross profit is the report's own arithmetic, which is what it became once the
   * rebate estimate was taken back out of that column — the flaw that made the report and this
   * site disagree on thirty-two fills.
   */
  const rows17 = [
    "Third Party:,610097(A4) - 610097",
    // $204.57 in on a $328.23 drug: a real loss on the day, with $146.18 of facilitator money promised.
    "332359-1,P,$204.57,KS20B2,IRX9TP,$0.00,$10.50,$0.00,9/5/2026 9:23:51 AM,09/05/26,610097,30.0000,$328.23,A4,00597015230,($123.66),$146.18",
    // An ordinary generic, nothing promised.
    "321666-4,P,$11.36,2CYA,EN45,$0.00,$10.50,$0.00,9/5/2026 9:24:00 AM,09/05/26,610097,30.0000,$0.71,A4,68094090460,$10.65,$0.00",
  ];

  const parsed = parseRxTransactions([...HEAD17, ...rows17, ...FOOT17].join("\r\n"));

  test("the file loads instead of being rejected as a different report", () => {
    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.rows.length, 2);
  });

  test("every other column is still read from where it actually is", () => {
    /*
     * The point of the whole exercise. A layout off by one would give figures that all look
     * reasonable — so these are checked against the row by hand, not against each other.
     */
    const [jardiance] = parsed.rows;
    assert.equal(jardiance.rxNumber, "332359");
    assert.equal(jardiance.fillNumber, 1);
    assert.equal(jardiance.bin, "610097");
    assert.equal(jardiance.ndc11, "00597015230");
    assert.equal(jardiance.remitCents, 20_457);
    assert.equal(jardiance.dispensingFeeCents, 1_050);
    assert.equal(jardiance.acquisitionCents, 32_823);
    assert.equal(jardiance.grossProfitCents, -12_366);
    assert.equal(jardiance.quantityThousandths, 30_000);
  });

  test("the promised facilitator payment is read, and a promise of nothing is not a promise", () => {
    /*
     * $146.18 with a source — the plan's own response — rather than a number this site inferred
     * from a gap it could not explain. That inference was wrong: it turned a $5.56 rounding on a
     * generic Losartan into a facilitator payment that was never coming.
     */
    assert.equal(parsed.rows[0].expectedFacilitatorCents, 14_618);
    assert.equal(parsed.rows[1].expectedFacilitatorCents, 0, "printed as zero, which is a real answer");
  });

  test("the old sixteen-column report still reads exactly as it did", () => {
    // The pharmacy has months of these. A reader that only understands the new shape is a regression.
    const old = parseRxTransactions(SAMPLE);
    assert.deepEqual(old.problems, []);
    assert.ok(old.rows.length > 0);
    assert.equal(old.rows[0].expectedFacilitatorCents, null, "no column, so nothing is claimed");
  });

  test("a report rebuilt beyond recognition loads nothing and says so", () => {
    /*
     * The one thing worse than refusing a file is reading it on a guess. Two columns added at once
     * is a report that has been rebuilt, and the figures it would yield are not worth having.
     */
    const twoMore = [...HEAD17, "Third Party:,610097(A4) - 610097",
      "332359-1,P,$204.57,KS20B2,IRX9TP,$0.00,$10.50,$0.00,9/5/2026 9:23:51 AM,09/05/26,610097,30.0000,$328.23,A4,00597015230,($123.66),$146.18,$1.00",
      ...FOOT17].join("\r\n");
    const bad = parseRxTransactions(twoMore);
    assert.equal(bad.rows.length, 0);
    assert.ok(bad.problems.length > 0, "and it explains itself rather than loading a plausible lie");
  });
});

/**
 * Sending a corrected report to the mailbox, and having it replace what is already held.
 *
 * The report is not immutable. Its gross profit column was quietly carrying an estimated rebate,
 * so every figure drawn from it disagreed with the pharmacy's own arithmetic; when that was fixed
 * at source, the corrected numbers arrived in a file whose rows this site already held. Treating
 * those rows as duplicates and skipping them would have kept the wrong figures for ever — the only
 * way to get the truth in would have been to delete every claim and start again.
 */
describe("re-sending a corrected report", () => {
  const key = (t: Transaction) => t.transactionKey;

  // The same fill, as the old report printed it and as the rebuilt one does.
  const asItWas = parseRxTransactions(
    file(
      "Third Party:,610097(A4) - 610097",
      // Gross profit $22.52: the acquisition arithmetic plus an estimated rebate nobody asked for.
      "332359-1,P,$204.57,KS20B2,IRX9TP,$0.00,$10.50,$0.00,9/5/2026 9:23:51 AM,09/05/26,610097,30.0000,$328.23,A4,00597015290,$22.52",
    ),
  );

  const asItIs = parseRxTransactions(
    [
      "Rx Transaction Details By Submission Type (BETA)",
      "West Wichita Family Pharmacy",
      "9/1/2026 12:00:00 AM, to ,9/6/2026 12:00:00 AM",
      "Third Party,Script",
      "Dispensing Fee,Completed Date",
      "Rx Number,Status,Amount,Group,Ntw Reim. Id,Copay,Total,Date Filled,BIN,Est,QTY,Acq. Inv. Cost,PCN,NDC,GrossProfit",
      "Transmitted",
      "Third Party:,610097(A4) - 610097",
      // The same row, restated: the rebate taken back out, the promised facilitator payment named.
      "332359-1,P,$204.57,KS20B2,IRX9TP,$0.00,$10.50,$0.00,9/5/2026 9:23:51 AM,09/05/26,610097,$146.18,30.0000,$328.23,A4,00597015290,($123.66)",
      // And a day the pharmacy had never sent before.
      "331220-1,P,$0.00,,,$27.47,$10.00,$27.47,9/1/2026 5:04:04 PM,09/01/26,610097,$0.00,30.0000,$1.26,A4,72603066402,$26.21",
      "9/5/2026 1:51 PM,Page 1 of 1",
    ].join("\r\n"),
  );

  test("both files read, and the row that appears in both keeps one identity", () => {
    assert.deepEqual(asItWas.problems, []);
    assert.deepEqual(asItIs.problems, []);
    assert.equal(asItWas.rows[0].grossProfitCents, 2_252, "what the old report claimed");
    assert.equal(asItIs.rows[0].grossProfitCents, -12_366, "what it says now the rebate is out of it");
    assert.equal(key(asItWas.rows[0]), key(asItIs.rows[0]), "the same transaction, so the same key");
  });

  test("the corrected row is restated rather than stored twice or skipped", () => {
    const held = new Map([[key(asItWas.rows[0]), "claim-1"]]);
    const plan = planTransactions(
      asItIs.rows,
      { keys: new Set(held.keys()), paid: [], byKey: held },
      { ignoreBins: ["028249"] },
    );

    assert.equal(plan.duplicates, 1, "counted once, not added again");
    assert.equal(plan.insertPaid.length, 1, "and only the genuinely new day is inserted");
    assert.equal(plan.insertPaid[0].rxNumber, "331220");

    assert.equal(plan.refresh.length, 1, "the row already held is re-read");
    assert.equal(plan.refresh[0].claimId, "claim-1", "against the claim it belongs to");
    assert.equal(plan.refresh[0].txn.grossProfitCents, -12_366, "with the report's corrected figure");
    assert.equal(plan.refresh[0].txn.expectedFacilitatorCents, 14_618, "and the column that did not exist before");
  });

  test("nothing is restated where the site has no such claim to restate", () => {
    // A first load has nothing held, so every row is an insert and none of them is a correction.
    const plan = planTransactions(asItIs.rows, { keys: new Set(), paid: [] }, { ignoreBins: ["028249"] });
    assert.equal(plan.refresh.length, 0);
    assert.equal(plan.duplicates, 0);
    assert.equal(plan.insertPaid.length, 2);
  });
});

/**
 * The report's own grand total — the only figures in the building that nothing here computed.
 *
 * Which makes it the only real check on our arithmetic, and the only authoritative answer to "what
 * did the pharmacy take". Its columns are not labelled and there are fewer of them than the header
 * has names, so nothing about it is guessed at: gross profit is the last cell because GrossProfit
 * is the last column, and sales and acquisition are derived from the identity every row obeys.
 */
describe("the report's own bottom line", () => {
  test("sales and cost are derived from the identity, not read off a guessed position", () => {
    // The live file's last line, to the cent.
    const line = [8_417_997, 0, 8_417_997, 2_479_643, 0, 2_479_643, 0, 10_897_640, 0, 324_979, 9_608_963, 1_288_677];
    const t = readTotalsLine(line);
    assert.equal(t?.grossProfitCents, 1_288_677, "the last cell, because GrossProfit is the last column");
    assert.equal(t?.salesCents, 10_897_640, "$108,976.40 — and $84,179.97 from plans plus $24,796.43 from patients agrees");
    assert.equal(t?.acquisitionCents, 9_608_963);
  });

  test("a zero on either side proves nothing and is never taken as the answer", () => {
    /*
     * Every totals line is full of zeros, and "gross profit minus nothing is gross profit" is true
     * of all of them. Treating that as a match would make the sales figure whatever happened to sit
     * beside a zero — a confident number, reconciled against a bank, and wrong.
     */
    const t = readTotalsLine([0, 0, 0, 5_000, 0, 5_000]);
    assert.equal(t, null);
  });

  test("where more than one pair fits, nothing is claimed", () => {
    // Ambiguity is not resolved by picking first. A total somebody reconciles has to be certain.
    assert.equal(readTotalsLine([300, 100, 500, 300, 200]), null);
  });

  test("too short a line is not a total", () => {
    assert.equal(readTotalsLine([100, 50]), null);
  });
});

/**
 * "AR" is accounts receivable: the drug went out and the money is owed rather than taken.
 *
 * Not a claim status. The reader set these aside as an unknown code for a while, which was the
 * honest thing to do while nobody knew what it meant — and was also exactly why this site's gross
 * profit came to $2,849.76 more than PioneerRx's over the same six days. The report counts them in
 * its grand total, so anything that drops them reports the pharmacy as having made more than it did.
 *
 * Every row below is transcribed from the pharmacy's own 09/01–09/06 file, in the seventeen-column
 * shape that report now has — the extra "Est" column beside the BIN.
 */
describe("account sales", () => {
  const HEAD_EST = [
    "Rx Transaction Details By Submission Type (BETA)",
    "West Wichita Family Pharmacy",
    " Uses invoice cost based on cost for profit settings. Includes columns for estimated rebates and estimated dir fees.Based on claims transmitted/processed from ",
    "9/1/2026 12:00:00 AM, to ,9/6/2026 12:00:00 AM",
    "Third Party,Script",
    "Dispensing Fee,Completed Date",
    "Rx Number,Status,Amount,Group,Ntw Reim. Id,Copay,Total,Date Filled,BIN,Est,QTY,Acq. Inv. Cost,PCN,NDC,GrossProfit",
    "Transmitted",
    "Third Party:,005377(A4) - 005377",
  ];
  // Real neighbours, so the layout is settled by the file rather than by one unusual row.
  const NEIGHBOURS = [
    "327578-2,P,$0.00,ABSR,,$6.73,$0.75,$6.73,9/1/2026 4:03:40 PM,09/01/26,005377,$0.00,30.0000,$4.26,10000019,16714025902,$2.47",
    "330753-1,P,$0.00,ASCSH,,$6.80,$0.75,$6.80,9/1/2026 4:03:40 PM,09/01/26,005377,$0.00,24.0000,$3.13,10000019,00555057202,$3.67",
    "336334-0,P,$0.00,TCG1009,,$6.58,$0.95,$6.58,9/5/2026 9:37:53 AM,09/01/26,005377,$0.00,30.0000,$2.02,10000019,23155050210,$4.56",
  ];
  const ar = (...rows: string[]) => parseRxTransactions([...HEAD_EST, ...NEIGHBOURS, ...rows, ...FOOT].join("\r\n"));
  const EMPTY = { keys: new Set<string>(), paid: [] };

  const OWED =
    '309233-2,AR,$0.00,"$23,869.00",COMMERCIAL,"$1,492.61",$0.00,"$1,492.61",,09/01/26,024368,$0.00,60.0000,"$1,152.94",3207,81968004560,$339.67';
  const NOTHING_BILLED =
    "336264-0,AR,$0.00,KS2336,BIDBRODCBR,$0.00,$0.00,$0.00,9/1/2026 4:25:12 PM,09/01/26,610455,$0.00,60.0000,$984.00,KSPDP,00480331965,($984.00)";

  test("an AR row is read, not set aside as a status nobody knows", () => {
    const p = ar(OWED);
    const r = p.rows.find((x) => x.status === "AR");
    assert.ok(r, `no AR row read; reasons: ${JSON.stringify(p.reasons)}`);
    assert.equal(r.onAccount, true);
    assert.equal(r.remitCents, 0);
    assert.equal(r.patientTotalCents, 149_261);
    assert.equal(r.acquisitionCents, 115_294);
    assert.equal(r.grossProfitCents, 33_967);
  });

  test("the report's own identity holds on it: amount + total − cost = gross profit", () => {
    const r = ar(OWED).rows.find((x) => x.status === "AR")!;
    assert.equal((r.remitCents ?? 0) + (r.patientTotalCents ?? 0) - (r.acquisitionCents ?? 0), r.grossProfitCents);
  });

  test("an account sale with nothing billed carries its whole cost as the loss the report shows", () => {
    const r = ar(NOTHING_BILLED).rows.find((x) => x.status === "AR")!;
    assert.equal(r.remitCents, 0);
    assert.equal(r.patientTotalCents, 0);
    assert.equal(r.acquisitionCents, 98_400);
    assert.equal(r.grossProfitCents, -98_400);
  });

  test("an account sale is planned as a dispensing, never as a reversal or a rejection", () => {
    const plan = planTransactions(ar(OWED).rows, EMPTY);
    const on = plan.insertPaid.filter((t) => t.onAccount === true);
    assert.equal(on.length, 1);
    assert.equal(on[0].rxNumber, "309233");
    assert.equal(plan.skipped.filter((s) => s.txn.status === "AR").length, 0, "it is a sale that happened");
  });

  test("a rejection and an account sale on the same prescription stay apart", () => {
    /*
     * Rx 333932-0 in the live file: billed, rejected by the plan, then put on the account. The
     * rejection is nothing and the account sale is $484.03 of stock out of the door, and reading
     * either as the other loses the money.
     */
    const p = ar(
      "333932-0,R,$0.00,\"$28,558.00\",,$0.00,$0.00,$0.00,9/1/2026 1:36:19 PM,09/01/26,005377,$0.00,0.0000,$0.00,10000019,00002355511,$0.00",
      "333932-0,AR,$0.00,\"$28,558.00\",,$0.00,$0.00,$0.00,9/1/2026 1:36:19 PM,09/01/26,005377,$0.00,2.4000,$484.03,10000019,00002355511,($484.03)",
    );
    const plan = planTransactions(p.rows, EMPTY);
    assert.equal(plan.skipped.filter((s) => s.txn.status === "R").length, 1, "the rejection is nothing");
    const on = plan.insertPaid.filter((t) => t.onAccount === true);
    assert.equal(on.length, 1);
    assert.equal(on[0].acquisitionCents, 48_403);
  });

  test("a status still nobody knows is set aside by name rather than guessed at", () => {
    const p = ar(
      '309233-2,ZZ,$0.00,"$23,869.00",COMMERCIAL,"$1,492.61",$0.00,"$1,492.61",,09/01/26,024368,$0.00,60.0000,"$1,152.94",3207,81968004560,$339.67',
    );
    assert.equal(p.rows.filter((r) => r.rxNumber === "309233").length, 0);
    assert.ok(
      Object.keys(p.reasons ?? {}).some((k) => k.includes("ZZ")),
      `reasons: ${JSON.stringify(p.reasons)}`,
    );
  });
});
