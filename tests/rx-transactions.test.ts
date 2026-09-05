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
    assert.equal(r.reasons["a page-break fragment"], 1);
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

  test("a rejected row and the cash plan are set aside with reasons", () => {
    assert.ok(plan.skipped.some((s) => s.txn.rxNumber === "336856" && /rejected/.test(s.why)));
    assert.ok(plan.skipped.some((s) => s.txn.rxNumber === "324333" && /cash plan/.test(s.why)));
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
