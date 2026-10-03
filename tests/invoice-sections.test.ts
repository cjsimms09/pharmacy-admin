import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * IPD sends two invoices in one PDF — the owner, 16 September: "ipd sends controlled and non controlled items in same
 * document, they are different invoices but in the same pdf" — each half closed by its own subtotal.
 *
 * The rule used to be all or nothing against the whole document. On IPD 1013225 the Schedule II half read perfectly and
 * proved against its own subtotal, and was thrown away because the non-controlled half was $112.77 short on two lines of
 * a shape the reader did not know. The DEA asks about the half that was discarded.
 *
 * Every number here is invented and shaped like the real page. Nothing is imported at the top: the database is fixed on
 * first import (see tests/support/scratch-db).
 */
let storeInvoiceLines: typeof import("../src/lib/invoices").storeInvoiceLines;
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let cleanUpDb: (() => void) | null = null;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ({ storeInvoiceLines } = await import("../src/lib/invoices"));
  ({ db, schema } = await import("../src/db"));
});

after(() => cleanUpDb?.());

/* The Schedule II half: one line, $1,077.40, closed by its own subtotal. */
const controlledHalf = ["99999888801 1 0EACH 1,077.40  0  1,077.40", "OXYCODONE HCL 5MG TAB 100", "CII Subtotal:$1,077.40"];

/* The other half: five lines, $233.28 printed, one of which this reader is about to be unable to read. */
const otherHalf = [
  "99999888802 1 0EACH 15.99  0  15.99",
  "IBUPROFEN 200MG TAB 100",
  "99999888803 1 0EACH 17.55  0  17.55",
  "CETIRIZINE 10MG TAB 30",
  "99999888804 3 0EACH 28.99  0  86.97",
  "AMOXICILLIN 500MG CAP 30",
  "99999888805 1 0EACH 1.80  0  1.80",
  "FAMOTIDINE 20MG TAB 30",
  "99999888806 3 0EACH 36.99  0  110.97",
  "LORATADINE 10MG TAB 30",
  "Non-CII Subtotal:$233.28",
];

const page = (lines: string[]) =>
  [
    "Independent Pharmacy Distributor",
    "Invoice 9000001  Ship Date 09/15/2026",
    "Product Product Name Quantity B/O UOM Price Discount Extension",
    ...lines,
    "Invoice Total:$1,310.68",
    /* Long enough that the reader does not skip it as a stub. */
    "Remit to: PO Box 1000, Testtown KS 60000. Questions: (555) 555-0100. Terms net 30. Thank you for your order.",
  ].join("\n");

async function readInto(text: string): Promise<{ stored: number; shortCents?: number; shortNote?: string | null }> {
  const id = `inv-${Math.random().toString(36).slice(2, 10)}`;
  await db.insert(schema.documents).values({ id: `doc-${id}`, category: "invoice", title: "test", fileName: "test.pdf", mimeType: "application/pdf", sizeBytes: 1, sha256: id, storageKey: `x/${id}`, uploadedBy: "test" } as never);
  await db.insert(schema.supplierInvoices).values({ id, documentId: `doc-${id}`, supplier: "IPD", invoiceNumber: "9000001", invoiceDate: "2026-09-15", totalCents: 131_068 } as never);
  const r = await storeInvoiceLines(id, { supplier: "IPD", invoiceDate: "2026-09-15", text, printedTotalCents: 131_068 });
  const held = await db.query.supplierInvoices.findFirst({ where: (t, { eq }) => eq(t.id, id), columns: { linesShortCents: true, linesShortNote: true, linesRead: true } });
  return { stored: r.stored, shortCents: held?.linesShortCents ?? undefined, shortNote: held?.linesShortNote ?? null };
}

describe("two invoices in one document, each judged on its own subtotal", () => {
  test("a document whose halves both balance keeps every line and says nothing is short", async () => {
    const r = await readInto(page([...controlledHalf, ...otherHalf]));
    assert.equal(r.stored, 6);
    assert.equal(r.shortCents, undefined);
    assert.equal(r.shortNote, null);
  });

  test("REGRESSION: a half that cannot be read does not take the half that can with it", async () => {
    /*
     * The $110.97 line loses its extension AND its price column, so no rule claims it: the shape that cost invoice
     * 1013225 everything. The Schedule II half is untouched and must survive.
     */
    const broken = page([...controlledHalf, ...otherHalf]).replace("99999888806 3 0EACH 36.99  0  110.97", "99999888806 3 0EACH ??.??  0 %");
    const r = await readInto(broken);
    assert.equal(r.stored, 5, "the five lines that read are kept; under the old rule this was nought");
    assert.equal(r.shortCents, 11_097, "the half is short by the line's own amount, named");
    assert.match(String(r.shortNote), /non-controlled half is short \$110\.97/);
    assert.doesNotMatch(String(r.shortNote), /Schedule II/, "the controlled half balanced, so nothing is said about it");
  });

  test("what it keeps includes the controlled line itself, which is the one the DEA asks about", async () => {
    const broken = page([...controlledHalf, ...otherHalf]).replace("99999888806 3 0EACH 36.99  0  110.97", "99999888806 3 0EACH ??.??  0 %");
    const id = `inv-dea-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(schema.documents).values({ id: `doc-${id}`, category: "invoice", title: "test", fileName: "t.pdf", mimeType: "application/pdf", sizeBytes: 1, sha256: id, storageKey: `x/${id}`, uploadedBy: "test" } as never);
    await db.insert(schema.supplierInvoices).values({ id, documentId: `doc-${id}`, supplier: "IPD", invoiceNumber: "9000002", invoiceDate: "2026-09-15", totalCents: 131_068 } as never);
    await storeInvoiceLines(id, { supplier: "IPD", invoiceDate: "2026-09-15", text: broken, printedTotalCents: 131_068 });
    const lines = await db.query.invoiceLines.findMany({ where: (t, { eq }) => eq(t.invoiceId, id), columns: { extendedCents: true, controlled: true } });
    assert.ok(lines.some((l) => l.controlled === true && l.extendedCents === 107_740), "the Schedule II line is on file with its own amount");
  });
});
