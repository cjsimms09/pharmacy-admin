import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * What happens to an invoice's row when lines Claude read are stored over the lines the rules read. Nothing here calls Claude: a
 * reading is built by hand and handed to the store, which is arithmetic and database writes and no more. Every figure is invented.
 */
let storeModelInvoiceLines: typeof import("../src/lib/invoices").storeModelInvoiceLines;
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let cleanUpDb: (() => void) | null = null;

type Reading = Parameters<typeof import("../src/lib/invoices").storeModelInvoiceLines>[2];
const line = (n: number, extendedCents: number): Reading["lines"][number] => ({
  ndc11: `9999988880${n}`.slice(0, 11),
  description: null,
  itemNumber: null,
  quantity: 1,
  unitOfMeasure: "EACH",
  unitCostCents: extendedCents,
  extendedCents,
  itemClass: null,
  rebated: null,
});
const reading = (over: Partial<Reading>): Reading => ({ invoiceNumber: null, invoiceDate: "2026-09-15", totalCents: null, lines: [], unreadable: [], ...over });

async function invoiceWithShortfall(label: string, totalCents: number | null) {
  await db.insert(schema.supplierInvoices).values({
    id: `inv-${label}`,
    documentId: `doc-${label}`,
    supplier: "IPD",
    invoiceNumber: label,
    invoiceDate: "2026-09-15",
    totalCents,
    linesRead: 2,
    linesUnread: 0,
    linesShortCents: 1_500,
    linesShortCount: 1,
    linesShortNote: "the invoice is short $15.00 on 1 line the reader could not read",
  } as never);
  for (const [i, cents] of [3_000, 1_500].entries()) {
    await db.insert(schema.invoiceLines).values({ id: `old-${label}-${i}`, invoiceId: `inv-${label}`, ndc11: `9999977770${i}`.slice(0, 11), quantity: 1, unitCostCents: cents, extendedCents: cents } as never);
  }
  return (await db.query.supplierInvoices.findFirst({ where: (t, { eq }) => eq(t.id, `inv-${label}`) }))!;
}
const rowOf = (label: string) => db.query.supplierInvoices.findFirst({ where: (t, { eq }) => eq(t.id, `inv-${label}`) });
const linesOf = (label: string) => db.query.invoiceLines.findMany({ where: (t, { eq }) => eq(t.invoiceId, `inv-${label}`) });

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ({ storeModelInvoiceLines } = await import("../src/lib/invoices"));
  ({ db, schema } = await import("../src/db"));
});

after(() => cleanUpDb?.());

describe("lines Claude read, stored over lines the rules read", () => {
  test("lines that add up to the printed total replace the old ones, and the shortfall the rules recorded goes with them", async () => {
    const inv = await invoiceWithShortfall("adds-up", 4_500);
    const out = await storeModelInvoiceLines(inv.id, inv, reading({ totalCents: 4_500, lines: [line(1, 1_000), line(2, 1_500), line(3, 2_000)] }));
    assert.equal(out.stored, 3);
    assert.equal(out.reconciles, true);
    const row = await rowOf("adds-up");
    assert.equal(row?.linesShortCents, null, "the row no longer says the lines on it are short");
    assert.equal(row?.linesShortCount, null);
    assert.equal(row?.linesShortNote, null);
    assert.equal((await linesOf("adds-up")).length, 3, "the old lines are gone, not kept beside the new ones");
  });

  test("with no total anywhere to add them up to the lines are kept unchecked, and the old shortfall is cleared all the same", async () => {
    const inv = await invoiceWithShortfall("no-total", null);
    const out = await storeModelInvoiceLines(inv.id, inv, reading({ totalCents: null, lines: [line(1, 1_000), line(2, 1_500)] }));
    assert.equal(out.stored, 2);
    assert.equal(out.reconciles, null);
    const row = await rowOf("no-total");
    assert.equal(row?.linesShortCents, null);
    assert.equal(row?.linesShortNote, null);
    assert.equal(row?.totalCents, null, "a reading that printed no total leaves the invoice with none");
  });

  test("a total read off the page where none was held is kept with the lines", async () => {
    const inv = await invoiceWithShortfall("page-total", null);
    const out = await storeModelInvoiceLines(inv.id, inv, reading({ totalCents: 2_500, lines: [line(1, 1_000), line(2, 1_500)] }));
    assert.equal(out.reconciles, true);
    const row = await rowOf("page-total");
    assert.equal(row?.totalCents, 2_500);
    assert.equal(row?.linesShortCents, null);
  });

  test("a total already held is not replaced by a different one read off the page, and the lines are held to the one on file", async () => {
    const inv = await invoiceWithShortfall("held-total", 4_500);
    const out = await storeModelInvoiceLines(inv.id, inv, reading({ totalCents: 9_999, lines: [line(1, 3_000), line(2, 1_500)] }));
    assert.equal(out.reconciles, true, "the lines add up to the total on file, which is the one that counts");
    assert.equal((await rowOf("held-total"))?.totalCents, 4_500);
  });

  test("lines that do not add up are not kept, and the invoice is left exactly as it was, shortfall and lines included", async () => {
    const inv = await invoiceWithShortfall("does-not-add-up", 4_500);
    const out = await storeModelInvoiceLines(inv.id, inv, reading({ totalCents: 4_500, lines: [line(1, 1_000), line(2, 1_500)] }));
    assert.equal(out.stored, 0);
    assert.equal(out.reconciles, false);
    const row = await rowOf("does-not-add-up");
    assert.equal(row?.linesShortCents, 1_500, "the shortfall the rules recorded still describes the lines still on the row");
    assert.equal(row?.linesShortCount, 1);
    assert.equal((await linesOf("does-not-add-up")).length, 2);
  });

  test("a reading with no line that multiplies out is not kept either", async () => {
    const inv = await invoiceWithShortfall("nothing-multiplies", 4_500);
    const bad = { ...line(1, 1_000), quantity: 2 };
    const out = await storeModelInvoiceLines(inv.id, inv, reading({ totalCents: 4_500, lines: [bad] }));
    assert.equal(out.stored, 0);
    assert.equal(out.reconciles, null);
    assert.equal((await rowOf("nothing-multiplies"))?.linesShortCents, 1_500);
    assert.equal((await linesOf("nothing-multiplies")).length, 2);
  });
});
