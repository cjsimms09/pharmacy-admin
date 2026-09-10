import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseInvoiceProof,
  invoiceProofFraction,
  invoiceProofGaps,
  invoiceProofNote,
  type InvoiceProof,
} from "../src/lib/data-health-invoice-proof";

/*
 * Every supplier invoice re-read from its own file.
 *
 * Written after the owner printed the supplier invoices screen on 9 September and three faults came
 * off one page — a $9,890.97 invoice with no item lines, an undated ParMed invoice, and an invoice
 * still saying it had no lines after the reader could read them. All three are a minute's
 * arithmetic against the file, and none was visible on any screen.
 */

const proof = (o: Partial<InvoiceProof> = {}): InvoiceProof => ({
  provedOn: "2026-09-10",
  invoices: 10, reconciled: 10, disagreed: 0, noLines: 0, undated: 0,
  readerMovedOn: 0, supplierDiffers: 0, unreadable: 0, unattributedCents: 0, rows: [], lines: [],
  ...o,
});

describe("what it will not count as a failure", () => {
  test("a scanned invoice proves nothing, and is not held against the fraction", () => {
    /*
     * Three states. "We could not check this" and "we checked it and it is wrong" are different
     * facts, and putting scans in the denominator would make the number fall every time somebody
     * photographs a delivery note — which trains people to ignore it.
     */
    const p = proof({ invoices: 10, reconciled: 8, unreadable: 2 });
    assert.deepEqual(invoiceProofFraction(p), { numerator: 8, denominator: 8 });
  });

  test("the unreadable ones are said out loud rather than hidden inside the fraction", () => {
    const note = invoiceProofNote(proof({ invoices: 10, reconciled: 8, unreadable: 2 }));
    assert.match(note, /2 invoices carried no text to re-read/);
    assert.match(note, /a scan rather than a fault/);
    assert.doesNotMatch(note, /fail/i);
  });

  test("nothing filed yet says so, rather than reading as nought out of nought", () => {
    assert.match(invoiceProofNote(proof({ invoices: 0, reconciled: 0 })), /nothing to re-read/);
  });

  test("every invoice unreadable is not the same as every invoice wrong", () => {
    const note = invoiceProofNote(proof({ invoices: 3, reconciled: 0, unreadable: 3 }));
    assert.match(note, /None of the 3 invoices on file could be re-read/);
  });
});

describe("the faults off the owner's own printouts", () => {
  test("an invoice with a total and no lines is the first thing said, because it is invisible", () => {
    const gaps = invoiceProofGaps(proof({ noLines: 1, unattributedCents: 989_097, reconciled: 9 }));
    assert.match(gaps[0], /1 invoice has a total and no item lines/);
    assert.match(gaps[0], /\$9,890\.97/);
    assert.match(gaps[0], /the buy list and every margin are blind/);
  });

  test("a reader that has improved since an invoice landed is a gap of its own", () => {
    /*
     * The new lesson. The file was right and the reader was wrong, and fixing the reader does not
     * reach backwards — the invoice went on saying it had no lines after the KI/KD fix landed.
     */
    const gaps = invoiceProofGaps(proof({ readerMovedOn: 2, reconciled: 8 }));
    assert.match(gaps[0], /2 invoices can be read better now/);
    assert.match(gaps[0], /The reader has improved and nobody went back/);
    assert.match(gaps[0], /Press Read again/);
  });

  test("the wholesaler the page names, where it is not the one it is filed under", () => {
    /*
     * The owner, 10 September: "I believe it labeled the parmed invoice as cardinal." ParMed is a
     * Cardinal Health company and was not on the name list at all. Teaching the reader does not
     * reach backwards, so every ParMed invoice already filed still reads as Cardinal — and the
     * supplier is what decides which returns policy times that stock.
     */
    const gaps = invoiceProofGaps(proof({ supplierDiffers: 2, reconciled: 8 }));
    assert.match(gaps.join(" "), /2 invoices are filed under a different wholesaler/);
    assert.match(gaps.join(" "), /which returns policy times the stock/);
  });

  test("an undated invoice is named for the reason it matters", () => {
    const gaps = invoiceProofGaps(proof({ undated: 1, reconciled: 9 }));
    assert.match(gaps.join(" "), /out of reach of any date range/);
    assert.match(gaps.join(" "), /what an inspector asks for/);
  });

  test("a clean run says nothing at all", () => {
    assert.deepEqual(invoiceProofGaps(proof()), []);
  });
});

describe("the verb moves with the count", () => {
  // The slip the claims proof's alert had: pluralising the noun and leaving the verb behind.
  test("one invoice", () => {
    const g = invoiceProofGaps(proof({ noLines: 1, disagreed: 1, undated: 1, readerMovedOn: 1 })).join(" ");
    assert.match(g, /1 invoice has a total/);
    assert.match(g, /1 invoice's stored lines do not sum to the total printed on it/);
    assert.match(g, /1 invoice has no date, so it is out of reach/);
    assert.match(g, /1 invoice can be read better now than when it arrived/);
  });

  test("more than one", () => {
    const g = invoiceProofGaps(proof({ noLines: 3, disagreed: 2, undated: 4, readerMovedOn: 5 })).join(" ");
    assert.match(g, /3 invoices have a total/);
    assert.match(g, /2 invoices' stored lines do not sum to the total printed on them/);
    assert.match(g, /4 invoices have no date, so they are out of reach/);
    assert.match(g, /5 invoices can be read better now than when they arrived/);
  });
});

describe("reading what the job wrote", () => {
  test("the job's own date is carried, so a job that has stopped ages visibly", () => {
    const p = parseInvoiceProof(JSON.stringify(proof({ provedOn: "2026-09-01" })));
    assert.equal(p?.provedOn, "2026-09-01");
    assert.match(invoiceProofNote(p!), /Last re-read 2026-09-01/);
  });

  test("nothing written yet is null, not an empty proof", () => {
    // An empty proof would render as a clean row. Never measured is not measured clean.
    assert.equal(parseInvoiceProof(null), null);
    assert.equal(parseInvoiceProof(""), null);
    assert.equal(parseInvoiceProof("not json"), null);
    assert.equal(parseInvoiceProof("[1,2]"), null, "an array is not a proof");
  });

  test("a row missing its figures reads as nought rather than throwing", () => {
    const p = parseInvoiceProof(JSON.stringify({ provedOn: "2026-09-10", rows: [{ invoiceId: "a" }, null, "x"] }));
    assert.equal(p?.rows.length, 1);
    assert.equal(p?.rows[0].storedLines, 0);
    assert.equal(p?.rows[0].totalCents, null, "a total nobody found is null, not nought");
  });

  test("a total of nought is kept as nought and not turned into unknown", () => {
    const p = parseInvoiceProof(JSON.stringify({ rows: [{ invoiceId: "a", totalCents: 0 }] }));
    assert.equal(p?.rows[0].totalCents, 0);
  });
});
