import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseRxRescueCredit, looksLikeRxRescueCredit, unpadRx } from "../src/lib/rxrescue-credit";

/**
 * The Aytu / IPD credit memo: top-off money for the RxRescue programme (BIN 024284).
 *
 * A claim on this plan adjudicates for whatever the primary will pay, and the rest arrives weeks
 * later as a credit. Until it is applied the fill sits in the loss list for the whole difference —
 * on the real fortnight below, $10,706.20 the site would otherwise have shown as simply gone.
 *
 * Lines are the real memo, to the cent.
 */
const HEAD =
  "Transaction ID,Rx Number,Processing Group Number,NDC,Product Name,Transaction Date,Pharmacy NABP,Pharmacy Name,OCC Code,Qty Dispensed,Primary Payer Reimb,Pt Out of Pocket,RxRescue Top Off Amount/Credit,Final Patient Pay/ OOP,Pt Copay Asst,Dispensing Fee,Total Credit Payment to Pharmacy,Credit Memo ID,Credit Memo Issue Date";

const MEMO = [
  HEAD,
  "17998b24-4b3d-4538-9906-d82751e29dbb,000000333801,99991001,62542002030,Adzenys AG,2026-08-13,1722734,WEST WICHITA FAMILY PHARMACY,08,60.0,926.52,60.0,49.94,0.0,60.0,0.0,109.94,C-00004862C20260815,2026-09-03",
  "d1da64b5-1398-4f5e-9e96-b242a1197011,000000333123,99991001,70165030030,Cotempla,2026-08-10,1722734,WEST WICHITA FAMILY PHARMACY,03,30.0,0.0,538.7,0.0,50.0,511.2,22.5,511.2,C-00004862C20260815,2026-09-03",
  // A reversal, and the rebill of the same prescription on the same day. They net to nothing.
  "03b22a19-0701-426a-b2e0-e71d0bc5b694,000000332022,99991001,62542002030,Adzenys AG,2026-08-10,1722734,WEST WICHITA FAMILY PHARMACY,08,-30.0,-488.51,-10.0,-19.72,-0.0,-10.0,-0.0,-29.72,C-00004862C20260815,2026-09-03",
  "eaa43429-a03c-46ec-912f-6723d0c7b9e5,000000332022,99991001,62542002030,Adzenys AG,2026-08-10,1722734,WEST WICHITA FAMILY PHARMACY,08,30.0,488.51,10.0,19.72,0.0,10.0,0.0,29.72,C-00004862C20260815,2026-09-03",
  // The primary paid nothing and the memo left the column blank, which is not a zero.
  "a6692944-249c-462a-b6b7-7276bdfef7b4,000000322540,99991001,62542002530,Adzenys AG,2026-08-07,1722734,WEST WICHITA FAMILY PHARMACY,00,30.0,,468.23,0.0,50.0,440.73,22.5,440.73,C-00004862C20260815,2026-09-03",
].join("\n");

const memo = parseRxRescueCredit(MEMO);

describe("reading a credit memo", () => {
  test("it is recognised by its columns, not by what it is called", () => {
    assert.equal(looksLikeRxRescueCredit(MEMO), true);
    assert.equal(looksLikeRxRescueCredit("Rx Number,BIN,NDC\n1,2,3"), false);
  });

  test("the memo, the day it was issued, and the fills it covers", () => {
    assert.deepEqual(memo.problems, []);
    assert.equal(memo.rows.length, 5);
    assert.equal(memo.memoId, "C-00004862C20260815");
    assert.equal(memo.issuedOn, "2026-09-03");
    assert.deepEqual(memo.period, { from: "2026-08-07", to: "2026-08-13" });
  });

  test("the prescription number joins to a claim, unpadded", () => {
    /*
     * The memo writes "000000333801"; the pharmacy's claim holds "333801". Without this the whole
     * memo matches nothing at all and the money sits against no claim.
     */
    assert.equal(memo.rows[0].rxNumber, "333801");
    assert.equal(unpadRx("000000333801"), "333801");
    assert.equal(unpadRx("0"), "0", "a number that is all zeros is left as it is, not emptied");
  });

  test("the credit is the top-off plus the assistance, and a line that disagrees is reported", () => {
    /*
     * The memo's own arithmetic, and the only defence against a column being read from the wrong
     * place. A payment applied to a claim is not something anybody re-checks afterwards.
     */
    assert.equal(memo.rows[0].topOffCents, 4_994);
    assert.equal(memo.rows[0].copayAssistCents, 6_000);
    assert.equal(memo.rows[0].totalCreditCents, 10_994);

    const bent = parseRxRescueCredit(
      [HEAD, "x,000000111,1,62542002030,X,2026-08-13,1722734,P,08,30.0,0.0,0.0,10.0,0.0,20.0,0.0,999.0,M,2026-09-03"].join("\n"),
    );
    assert.ok(bent.problems.some((p) => /does not add up/.test(p)));
  });

  test("a reversal and its rebill are both kept, and cancel", () => {
    // Dropping either would move the memo's total by $29.72 in one direction or the other.
    const pair = memo.rows.filter((r) => r.rxNumber === "332022");
    assert.equal(pair.length, 2);
    assert.equal(pair.reduce((n, r) => n + (r.totalCreditCents ?? 0), 0), 0);
  });

  test("a blank column is not a zero", () => {
    // "the primary paid nothing" and "the memo did not say" are different facts.
    const blank = memo.rows.find((r) => r.rxNumber === "322540")!;
    assert.equal(blank.primaryPayerReimbCents, null);
    assert.equal(blank.totalCreditCents, 44_073);
  });

  test("every line carries what it needs to find its fill", () => {
    // Prescription, drug and day dispensed. The memo never says which fill, so the match must not need it.
    for (const r of memo.rows) {
      assert.ok(r.rxNumber, "a prescription number");
      assert.ok(r.ndc11, "an eleven-digit NDC");
      assert.ok(r.transactionDate, "the day it was dispensed");
      assert.ok(r.transactionId, "and an id, so a memo sent twice is not counted twice");
    }
  });

  test("a file that is not a credit memo is refused rather than half-read", () => {
    const wrong = parseRxRescueCredit("Rx Number,NDC\n333801,62542002030");
    assert.equal(wrong.rows.length, 0);
    assert.ok(wrong.problems.length > 0);
  });
});
