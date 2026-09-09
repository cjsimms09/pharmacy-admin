import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { looksLikeCopayRemittance } from "../src/lib/copay-remittance";
import { pdfText } from "../src/lib/pdf-text";

/**
 * Recognising RedSail's copay voucher remittance (BACKLOG item 24, recogniser side).
 *
 * The text below is synthetic: built from session 1's reading of the document's own text layer on
 * 8 September, because that was all there was when this was written. The real fixture arrived
 * afterwards and is exercised in the second block; these cases stay because each one names a rule
 * — a shredded heading, a scan, a lying file name — that no single real document exhibits.
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

/**
 * And against the real thing, at last.
 *
 * `fixtures/copay-remit-redsail.txt` is the text layer of page 2 of the actual statement, with the
 * prescription numbers, the check number, the NPI and the pharmacy's own details invented and every
 * amount kept. It arrived after this detector was written, so until now the rules above were built
 * from a description of the document rather than from the document — which is exactly the gap this
 * closes. Two artifacts of the real text layer are preserved in it on purpose: a prescription
 * number and an NDC each broken across two runs by a space.
 */
describe("the real statement's text layer", () => {
  const real = readFileSync(new URL("../fixtures/copay-remit-redsail.txt", import.meta.url), "utf8");

  test("is recognised", () => {
    assert.equal(looksLikeCopayRemittance(real, "5171c9d9-Image_001.pdf"), true);
  });

  test("with the heading and the issuer both gone, it refuses rather than reading the table", () => {
    /*
     * Everything above "Payment Date:" is the title and the issuer, so this slice is the statement
     * with both names removed: a payment amount, an NPI, fourteen priced rows and the footer.
     *
     * It is refused, and that is the design rather than a shortfall. A table of prescriptions with
     * money beside them is the shape of half the documents this pharmacy receives, and "Total
     * Amount Paid" is on all of them. Recognising this would mean recognising a supplier statement
     * as a copay remittance, and a payment filed against the wrong programme is worse than a line
     * on the inbox asking what the document is.
     */
    const rowsOnly = real.split("Payment Date:").slice(1).join("Payment Date:");
    assert.equal(/copay|voucher|redsail/i.test(rowsOnly), false, "the slice really has lost both names");
    assert.equal(looksLikeCopayRemittance(rowsOnly), false);
  });

  test("but the issuer alone carries it when only the title is lost", () => {
    // The likelier damage: an extractor that drops a styled heading and keeps the body text.
    const noTitle = real.replace("Remittance Advice - RAS Copay Voucher Reimbursement", "");
    assert.equal(/copay voucher reimbursement/i.test(noTitle), false, "the title really is gone");
    assert.equal(looksLikeCopayRemittance(noTitle), true);
  });

  test("and the rows net to the total the statement prints", () => {
    // Not this module's job — the reader is 2's — but a fixture whose arithmetic does not close
    // would make every test written against it worthless, so it is checked once, here.
    const paid = real
      .split("\n")
      .filter((l) => /^\s*\d[\d\s]{6,}\s+202\d{5}\s/.test(l))
      .map((l) => Number(l.trim().split(/\s+/).pop()));
    assert.equal(paid.length, 14);
    assert.equal(Math.round(paid.reduce((n, c) => n + c, 0) * 100), 17725);
  });
});

/**
 * The link the fixture cannot test: from the PDF's bytes to the words this module reads.
 *
 * The real statement is a scan whose *second* page carries the text layer, and `contentVerdict`
 * only asks this detector where `pdfText` returned something. The fixture is that extracted text,
 * so it proves the rules and not the extraction — and a recogniser that never sees the words is a
 * recogniser that never fires, which is the fault this whole week has been about.
 *
 * So: a PDF whose first content stream is a drawing with no text at all, and whose second carries
 * the statement's heading. `pdfText` walks every stream in the file rather than the first page, and
 * skips one with no text-placing operator — this holds that behaviour, because the copay recogniser
 * depends on it and `pdf-text.ts` is not mine to keep still.
 */
describe("from the bytes of a scan to the words", () => {
  function twoPagePdf(pageOneOps: string, pageTwoText: string): Buffer {
    const stream = (body: string) => `stream\n${body}\nendstream\n`;
    const show = pageTwoText
      .split("\n")
      .map((line, i) => `BT /F1 10 Tf 72 ${700 - i * 14} Td (${line.replace(/([()\\])/g, "\\$1")}) Tj ET`)
      .join("\n");
    return Buffer.from(`%PDF-1.4\n${stream(pageOneOps)}${stream(show)}%%EOF\n`, "latin1");
  }

  test("a first page with no text layer does not hide the second page's words", () => {
    const pdf = twoPagePdf(
      // A scanned page: an image drawn into place, and not one text-placing operator.
      "q 612 0 0 792 0 0 cm /Im0 Do Q",
      ["RedSail Technologies", "Remittance Advice - RAS Copay Voucher Reimbursement", "Total Amount Paid 177.25"].join("\n"),
    );
    const text = pdfText(pdf);
    assert.match(text, /Copay Voucher/i, `pdfText should reach the second stream, got: ${JSON.stringify(text.slice(0, 120))}`);
    assert.equal(looksLikeCopayRemittance(text, "5171c9d9-Image_001.pdf"), true);
  });

  test("and a document that is only a scan still answers false", () => {
    // No text anywhere: the recogniser must say nothing rather than guess from the file's name.
    const pdf = twoPagePdf("q 612 0 0 792 0 0 cm /Im0 Do Q", "");
    assert.equal(looksLikeCopayRemittance(pdfText(pdf), "RAS copay voucher remittance.pdf"), false);
  });
});
