import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { looksLikeInvoice, filingFor, emptyInvoiceWarning, looksLikeInvoiceFromUnknownSender, replacesStoredLines } from "../src/lib/invoices";
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

/**
 * An invoice from a sender nobody registered.
 *
 * looksLikeInvoice refuses these, and should: filing PDFs from strangers under the heading an
 * inspector reads first would sweep up the wrong things. But refusing is not noticing, and today
 * nothing notices — the document lands in the general vault as "other". McKesson's register row
 * has no sender address at all, so a McKesson invoice arriving this afternoon could not be filed
 * as an invoice however plainly it said so on the page, and the pharmacy would go on believing its
 * purchase records were complete. Commingling a supplier invoice with ordinary documents is also
 * what 21 CFR 1304.04(h)(1) does not allow.
 */
describe("a supplier invoice whose sender is not on the register", () => {
  // Two lines each carrying an NDC and a price, which is what an invoice is. Identifiers invented.
  const invoiceWords = [
    "REMIT TO: A WHOLESALER",
    "00002143611 EMGALITY INJ PEN 120MG/ML 1 R $739.11 $739.11",
    "00169633910 NOVOLOG FLEXPEN 100UNIT/ML 2 R $131.02 $262.04",
    "TOTAL DUE $1,001.15",
  ].join("\n");
  const ask = (a: Partial<Parameters<typeof looksLikeInvoiceFromUnknownSender>[0]> = {}) =>
    looksLikeInvoiceFromUnknownSender({
      fileName: "invoice.pdf",
      mimeType: "application/pdf",
      subject: "Invoice 12345",
      supplier: null,
      text: invoiceWords,
      ...a,
    });

  test("the McKesson case: an invoice arrives, no sender address is registered, and it is noticed", () => {
    assert.equal(ask(), true);
  });

  test("a sender we do know is somebody else's job, not this one", () => {
    // looksLikeInvoice already handles those. Answering true here would double-file them.
    assert.equal(ask({ supplier: "IPC" }), false);
  });

  test("the words have to say it — a subject line is written by whoever sent the email", () => {
    assert.equal(ask({ text: "Our new fall catalogue is attached. No purchase necessary." }), false);
    assert.equal(ask({ text: null }), false, "a scan tells us nothing, and a stranger's scan is not a guess to make");
    assert.equal(ask({ text: "" }), false);
  });

  test("a statement, a credit memo and the daily purchase report are all still not invoices", () => {
    assert.equal(ask({ text: "STATEMENT OF ACCOUNT\nBalance forward $500.00\n31-60 days $120.00" }), false);
    assert.equal(ask({ text: `CREDIT MEMO RGA 88\n${invoiceWords}` }), false);
  });

  test("one item line is not enough, because one number and an NDC is not a bill", () => {
    assert.equal(ask({ text: "00002143611 EMGALITY INJ PEN 120MG/ML 1 R $739.11 $739.11" }), false);
  });

  test("anything that is not a PDF is not an invoice here", () => {
    assert.equal(ask({ fileName: "invoice.xlsx", mimeType: "application/vnd.ms-excel" }), false);
  });
});

/**
 * Reading an invoice again must never make it worse.
 *
 * An invoice is read more than once — on filing, again from the inbox with today's rules, again
 * when somebody presses the button on the page — and each re-read is entitled to improve on the
 * last. None is entitled to replace figures that were proved against the printed total with
 * figures that were not. The delete inside storeInvoiceLines used to be unconditional once a read
 * produced any lines; model-read lines survived a later rule read only because the rule read
 * nothing and returned before reaching it. That is ordering, not a guarantee.
 *
 * "Better" is arithmetic, not judgement: lines adding to the total the invoice printed have been
 * proved against the document.
 */
describe("whether a fresh read may replace the lines already stored", () => {
  const may = (a: Partial<Parameters<typeof replacesStoredLines>[0]> = {}) =>
    replacesStoredLines({ storedLines: 0, storedCents: 0, readReconciles: null, printedTotalCents: null, ...a });

  test("nothing stored means nothing to lose", () => {
    assert.equal(may({ storedLines: 0, readReconciles: true, printedTotalCents: 7_850 }), true);
    assert.equal(may({ storedLines: 0, readReconciles: null, printedTotalCents: 7_850 }), true);
  });

  test("lines proved against the printed total are not given up for a read that proves nothing", () => {
    // The hole that mattered: reconciles is null, not false, when the invoice printed no total for
    // THIS read to check against — so an unproved read fell straight through to the delete.
    const proved = { storedLines: 8, storedCents: 7_850, printedTotalCents: 7_850 };
    assert.equal(may({ ...proved, readReconciles: null }), false);
    assert.equal(may({ ...proved, readReconciles: false }), false);
  });

  test("a read that proves itself may replace one that also did", () => {
    assert.equal(may({ storedLines: 8, storedCents: 7_850, printedTotalCents: 7_850, readReconciles: true }), true);
  });

  test("lines that never added up are replaceable by anything", () => {
    // Nothing is being protected here — the stored lines are short of the printed total, so a
    // re-read is the only way they ever get better.
    assert.equal(may({ storedLines: 4, storedCents: 5_000, printedTotalCents: 7_850, readReconciles: null }), true);
    assert.equal(may({ storedLines: 4, storedCents: 5_000, printedTotalCents: 7_850, readReconciles: true }), true);
  });

  test("with no printed total nothing can be proved either way, and the newer read stands", () => {
    // Deliberately the behaviour that was already there: refusing every re-read on an invoice with
    // no total would freeze the first guess in place permanently.
    assert.equal(may({ storedLines: 8, storedCents: 7_850, printedTotalCents: null, readReconciles: null }), true);
  });

  test("the McKesson case the reconciliation was built for: a short read cannot quietly win", () => {
    // A line worth $83 was once dropped by a pattern anchored to the end of the line; the four
    // remaining lines looked perfect. Stored proved lines, re-read comes back $83 short and so
    // does not reconcile — the good rows stay.
    assert.equal(may({ storedLines: 5, storedCents: 100_000, printedTotalCents: 100_000, readReconciles: false }), false);
  });
});
