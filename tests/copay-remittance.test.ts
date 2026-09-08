import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { looksLikeCopayRemittance } from "../src/lib/copay-remittance";

/**
 * Recognising RedSail's copay voucher remittance (BACKLOG item 24, recogniser side).
 *
 * The real statement is a scan and is not in this repository — a fixture with its identifiers
 * changed has to be made on the pharmacy computer. So the text below is built from session 1's
 * reading of the document's own text layer on 8 September: the heading, the header fields, the row
 * columns and the footer labels, in the order that review names them. What it cannot prove is how
 * that page comes out of `pdfText`, which is why the heading is matched loosely and why a
 * corroborating footer label is required rather than assumed.
 */
const statement = [
  "RedSail Technologies",
  "Remittance Advice - RAS Copay Voucher Reimbursement",
  "Payment Date 09/02/2026   Check/ACH 000148802   Payment Amount 177.25   NPI 1548737182",
  "Rx            Date of Service   NDC           Drug              Qty   Submitted  Patient Paid  Voucher Paid",
  "000000321762  08/14/2026        00093721410   Atorvastatin 20mg  30    180.00      5.69          174.31",
  "000000330204  08/21/2026        00378395193   Losartan 50mg      30      8.94      6.00            2.94",
  "Total Claims 177.25   Total Fee 0.00   Balance Forward 0.00   Total Amount Paid 177.25",
].join("\n");

describe("a copay voucher remittance", () => {
  test("is recognised from the statement's own words", () => {
    assert.equal(looksLikeCopayRemittance(statement, "5171c9d9-Image_001.pdf"), true);
  });

  test("survives the heading coming out of a PDF fragmented", () => {
    const shredded = statement.replace("Remittance Advice - RAS Copay Voucher Reimbursement", "R A S   Copay  Voucher\nReimbursement");
    assert.equal(looksLikeCopayRemittance(shredded), true);
  });

  test("and the issuer alone corroborates where the heading is worse than that", () => {
    assert.equal(
      looksLikeCopayRemittance("RedSail Technologies\ncopay voucher reimbursement statement for your pharmacy"),
      true,
    );
  });

  test("a scan with no text layer answers false rather than guessing", () => {
    assert.equal(looksLikeCopayRemittance(""), false);
    assert.equal(looksLikeCopayRemittance("   \n \n  "), false);
    assert.equal(looksLikeCopayRemittance("", "RAS copay voucher remittance.pdf"), false);
  });

  test("the name of the file is never the evidence", () => {
    // The words say it is a covering note. The name says otherwise, and the name does not decide.
    assert.equal(
      looksLikeCopayRemittance("Please find attached this month's paperwork. Call the office with any questions.", "RAS_copay_voucher_remittance.pdf"),
      false,
    );
  });

  test("the footer's accounting words alone are not a remittance", () => {
    // Any statement of account carries these. Without the programme's own name they mean nothing.
    assert.equal(looksLikeCopayRemittance("Total Claims 12   Balance Forward 0.00   Total Amount Paid 431.10"), false);
  });
});
