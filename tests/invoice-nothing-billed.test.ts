import { test, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * An invoice that billed nothing has no lines to read, and is not counted as one the reader has not been run on.
 * 12 November 2026: three McKesson documents (a DEA return kit with a recall notice, quantity 0, total $0.00) were "3 invoices without item lines".
 */
let cleanup: () => void;
let invoicesWithoutLines: typeof import("../src/lib/invoices").invoicesWithoutLines;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  const { db, schema } = await import("../src/db");
  ({ invoicesWithoutLines } = await import("../src/lib/invoices"));
  const add = async (label: string, totalCents: number | null) => {
    await db.insert(schema.documents).values({ id: `doc-${label}`, category: "invoice", title: "test", fileName: `${label}.pdf`, mimeType: "application/pdf", sizeBytes: 1, sha256: `sha-${label}`, storageKey: `k-${label}`, uploadedBy: "test" } as never);
    await db.insert(schema.supplierInvoices).values({ id: `inv-${label}`, documentId: `doc-${label}`, supplier: "McKesson", invoiceNumber: label, invoiceDate: "2026-10-30", totalCents } as never);
  };
  await add("zero", 0);
  await add("billed", 12_345);
  await add("unread-total", null);
});
after(() => cleanup());

test("a printed total of nought has no lines to read; a billed total and a total never read still do", async () => {
  assert.equal(await invoicesWithoutLines(), 2);
});
