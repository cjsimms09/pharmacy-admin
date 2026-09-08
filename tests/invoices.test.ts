import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { looksLikeInvoice, filingFor, emptyInvoiceWarning } from "../src/lib/invoices";
import { INVOICE_SCHEDULES } from "../src/db/schema";

/**
 * Where a supplier invoice is allowed to land.
 *
 * 21 CFR 1304.04(h)(1) requires Schedule II records to be maintained separately from all other
 * records the registrant holds. The only failure that matters here is a C2 invoice ending up
 * anywhere else, so the safe direction is asymmetric on purpose: an unread invoice is kept with
 * the Schedule IIs, never with the ordinary ones.
 */
describe("where each schedule is filed", () => {
  test("no schedule shares a folder or a category with another, except by the cautious default", () => {
    const two = filingFor("schedule_2");
    assert.notEqual(two.folder, filingFor("schedule_3_5").folder);
    assert.notEqual(two.folder, filingFor("none").folder);
    assert.notEqual(two.category, filingFor("schedule_3_5").category);
    assert.notEqual(two.category, filingFor("none").category);
  });

  test("an invoice nobody could read is kept with the Schedule IIs, not with the ordinary ones", () => {
    assert.equal(filingFor("unknown").folder, filingFor("schedule_2").folder);
    assert.equal(filingFor("unknown").category, filingFor("schedule_2").category);
    assert.notEqual(filingFor("unknown").category, filingFor("none").category);
  });

  test("every schedule has somewhere to go", () => {
    for (const s of INVOICE_SCHEDULES) {
      const f = filingFor(s);
      assert.ok(f.folder.length > 0, s);
      assert.ok(f.category.length > 0, s);
      assert.ok(f.label.length > 0, s);
    }
  });

  test("the Schedule II category is not one the general document list already uses", () => {
    assert.equal(filingFor("schedule_2").category, "invoice_schedule_2");
  });
});

describe("recognising a supplier invoice in the post", () => {
  const base = { fileName: "invoice-88213.pdf", mimeType: "application/pdf", subject: "Your invoice", supplier: "McKesson" };

  test("a PDF from a named supplier, about an invoice, is one", () => {
    assert.equal(looksLikeInvoice(base), true);
  });

  test("a sender the pharmacy has not named as a supplier is not swept up", () => {
    assert.equal(looksLikeInvoice({ ...base, supplier: null }), false);
  });

  test("a spreadsheet is left on the path it was already on", () => {
    assert.equal(
      looksLikeInvoice({ ...base, fileName: "prices.csv", mimeType: "text/csv" }),
      false,
    );
  });

  test("a PDF from a supplier that is not about an invoice is left alone", () => {
    assert.equal(
      looksLikeInvoice({ ...base, fileName: "catalog-changes.pdf", subject: "Formulary update" }),
      false,
    );
  });

  test("the word can be in either the subject or the file name", () => {
    assert.equal(looksLikeInvoice({ ...base, fileName: "88213.pdf", subject: "Invoice attached" }), true);
    assert.equal(looksLikeInvoice({ ...base, fileName: "INVOICE_88213.PDF", subject: "" }), true);
  });
});

/**
 * An invoice with money on it and nothing under it.
 *
 * The failure this catches is silence, which is the same one that dropped eight invoice lines out
 * of the rebate figures. A scanned PDF has no text layer, so the total is read off the front page,
 * the row is filed, no line reader is ever called and no screen says anything is missing. One is on
 * the live database now: $1,530.89, zero lines read, zero unread, needs_review already cleared. Every
 * per-NDC cost and every rebate figure is short by that invoice and looks complete.
 */
describe("an invoice that carries a total and no lines", () => {
  const warn = (linesStored: number, totalCents: number | null, hasTextLayer = true) =>
    emptyInvoiceWarning({ linesStored, totalCents, hasTextLayer });

  test("the real one on the database is caught, and the money is named in the sentence", () => {
    const why = warn(0, 153_089, false);
    assert.ok(why, "an invoice for $1,530.89 with no lines must not pass silently");
    assert.match(why, /\$1,530\.89/);
    // The advice has to differ: there is nothing on a scan to re-read, so somebody keys it or
    // gets a readable copy. Telling them to "look" at a page with no text layer wastes the trip.
    assert.match(why, /no text layer/);
  });

  test("a readable invoice that yielded no lines is a different sentence", () => {
    const why = warn(0, 153_089, true);
    assert.ok(why);
    assert.doesNotMatch(why, /no text layer/);
  });

  test("an invoice whose lines were read is not flagged", () => {
    // The other IPC invoice: 8 lines, $78.50, read and reconciled. Nothing is wrong with it.
    assert.equal(warn(8, 7_850), null);
    assert.equal(warn(1, 1), null);
  });

  test("a total of zero or none is not a missing invoice", () => {
    // An invoice for nothing has nothing to be missing, and a total that could not be read is
    // already its own problem — flagging it here would say something untrue about the lines.
    assert.equal(warn(0, 0), null);
    assert.equal(warn(0, null), null);
  });

  test("a negative total — a credit memo — is not treated as money owing with lines missing", () => {
    assert.equal(warn(0, -5_000), null);
  });
});
