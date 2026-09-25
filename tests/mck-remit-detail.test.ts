import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readRemitDetail, detailAgreesWithSummary } from "../src/lib/mck-remit-detail";
import { readRemitSummary } from "../src/lib/mck-remit-csv";

/** The detail export's shape, with invented prescription numbers and invented names. */
const DETAIL = [
  '"Location","Remit number","Rx number or ADJ description","Dispense date","Patient name","Remit amt","Remit date","Check/ACH number","Check/ACH date","Match to claim"',
  '"Example Pharmacy","900001","999001","09/01/2026","ALPHA EXAMPLE",41.62,"09/04/2026","999000000000001","09/04/2026","Yes"',
  '"Example Pharmacy","900001","999002","09/02/2026","BETA EXAMPLE",1003.36,"09/04/2026","999000000000001","09/04/2026","Yes"',
  '"Example Pharmacy","900002","Sales tax adjustment","09/03/2026","GAMMA EXAMPLE",-12.40,"09/08/2026","999000000000002","09/08/2026","No"',
].join("\n");

const SUMMARY = [
  '"NCPDP","Remit number","Payer name","Remit date","Posted date","Remit amt","Payment match","Remit type","Claim match","No claim match","Adjust","Exclude effective date"',
  '"7000017","900001","EXAMPLE SCRIPTS","09/04/2026","09/03/2026",1044.98,"999000000000001","ERA",1044.98,0,0,""',
  '"7000017","900002","EXAMPLE SCRIPTS","09/08/2026","09/07/2026",-12.40,"Not matched","ERA",0,0,-12.40,""',
].join("\n");

describe("the remit detail export", () => {
  test("no patient name survives into anything it returns", () => {
    /*
     * The reason this reader is allowed to open a file the ingestion gate refuses. It works the
     * way the 835 parser works — the columns it wants are found by name and read by index, and the
     * patient column's index is never among them — so the result has nowhere to put a name.
     *
     * Measured, not asserted: the whole parsed structure is serialised and searched.
     */
    const r = readRemitDetail(DETAIL);
    const serialised = JSON.stringify(r);
    for (const name of ["ALPHA EXAMPLE", "BETA EXAMPLE", "GAMMA EXAMPLE"]) {
      assert.equal(serialised.includes(name), false, `${name} reached the parsed result`);
    }
    assert.equal(r.lines.length, 3);
  });

  test("an adjustment row is not read as a prescription number", () => {
    // One column does both jobs. A description in the prescription column would be a fill nobody
    // dispensed, and it would go looking for a claim that cannot exist.
    const r = readRemitDetail(DETAIL);
    assert.deepEqual(r.lines.map((l) => l.rxNumber), ["999001", "999002", null]);
    assert.equal(r.lines[2].adjustment, "Sales tax adjustment");
    assert.equal(r.lines[2].amountCents, -1240);
  });

  test("dates are read as dates and money as cents", () => {
    const r = readRemitDetail(DETAIL);
    assert.equal(r.lines[0].dispensedOn, "2026-09-01");
    assert.equal(r.lines[0].remitOn, "2026-09-04");
    assert.equal(r.lines[0].amountCents, 4162);
    assert.equal(r.lines[0].paymentNumber, "999000000000001");
    assert.equal(r.lines[0].matchedToClaim, true);
    assert.equal(r.lines[2].matchedToClaim, false);
  });

  test("it totals by remittance and agrees with the summary export", () => {
    /*
     * The two files come out of the same table minutes apart, so they must agree. Measured on the
     * real pair on 18 September: 9,107 lines across 51 remittances, $539,894.18 by the detail and
     * $539,894.18 by the summary, with no remittance disagreeing.
     */
    const detail = readRemitDetail(DETAIL);
    const summary = readRemitSummary(SUMMARY);
    assert.deepEqual(
      detail.byRemit,
      [
        { remitNumber: "900001", lines: 2, amountCents: 104_498 },
        { remitNumber: "900002", lines: 1, amountCents: -1_240 },
      ],
    );
    assert.deepEqual(detailAgreesWithSummary(detail, summary.rows), []);
  });

  test("a disagreement is reported rather than averaged away", () => {
    const detail = readRemitDetail(DETAIL);
    const off = detailAgreesWithSummary(detail, [{ remitNumber: "900001", amountCents: 104_499 }]);
    assert.equal(off.length, 1);
    assert.deepEqual(off[0], { remitNumber: "900001", detailCents: 104_498, summaryCents: 104_499 });
  });

  test("it stops rather than read a name as money if the export moves its columns", () => {
    const moved = [
      '"Remit number","Rx number or ADJ description","Remit amt"',
      '"900001","999001","ALPHA EXAMPLE"',
    ].join("\n");
    const r = readRemitDetail(moved);
    // No patient column here, so it reads — but the unreadable amount is skipped, never guessed.
    assert.equal(r.lines.length, 0);
    assert.equal(r.skipped.length, 1);
  });

  test("a file that is not this export is refused with its columns named", () => {
    const r = readRemitDetail('"Rx","Qty"\n"1","2"');
    assert.equal(r.lines.length, 0);
    assert.match(r.problems[0], /remit detail/i);
  });
});

describe("the remit summary export", () => {
  test("'Not matched' is a state, not a payment number", () => {
    const s = readRemitSummary(SUMMARY);
    assert.equal(s.rows[0].paymentNumber, "999000000000001");
    assert.equal(s.rows[1].paymentNumber, null, "the string must not survive as a number");
    assert.equal(s.rows[0].payerName, "EXAMPLE SCRIPTS");
    assert.equal(s.rows[0].remitOn, "2026-09-04");
    assert.equal(s.rows[1].amountCents, -1240);
  });
});
