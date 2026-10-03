import "server-only";
import { db, schema } from "@/db";
import { inArray, sql } from "drizzle-orm";
import { duplicatesToRemove, type RemovalPlan } from "./duplicate-documents";

/**
 * Counts, and then removes, the copies of invoice documents the mailbox filed twice.
 *
 * The decision is in `duplicate-documents.ts` and is pure, so what would go can be counted before
 * any of it does — which is how this is meant to be used: look first, then act. Both halves read the
 * same function, so the count he is shown and the rows that are deleted cannot disagree.
 */

/**
 * Every column in the database that names a document.
 *
 * Written by hand first, as five tables — and that was wrong: twenty-eight tables carry a
 * `document_id`, and three more name one under another heading (`material_document_id`,
 * `reply_document_id`, `calibration_document_id`). A hand-kept list of them would have been right on
 * the day it was written and quietly wrong at the next migration, and the thing it would have got
 * wrong is a document deleted out from under the only row that pointed at it. So the schema is
 * asked instead. Any column whose name ends in `document_id`, in any table, counts as a reference.
 */
async function referencingColumns(): Promise<{ table: string; column: string }[]> {
  const tables = await db.all<{ name: string }>(
    sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`,
  );
  const found: { table: string; column: string }[] = [];
  for (const t of tables) {
    if (t.name === "documents") continue;
    /* The table name comes from sqlite_master, so it is a real identifier and not anybody's input. */
    const cols = await db.all<{ name: string }>(sql.raw(`pragma table_info("${t.name}")`));
    for (const c of cols) if (/document_id$/i.test(c.name)) found.push({ table: t.name, column: c.name });
  }
  return found;
}

async function plan(): Promise<RemovalPlan> {
  const docs = await db.query.documents.findMany({
    columns: { id: true, category: true, sha256: true, storageKey: true },
  });

  const referenced = new Set<string>();
  const invoiceDocumentIds = new Set<string>();
  for (const { table, column } of await referencingColumns()) {
    const rows = await db.all<{ v: string | null }>(
      sql.raw(`select distinct "${column}" as v from "${table}" where "${column}" is not null`),
    );
    for (const r of rows) {
      if (!r.v) continue;
      referenced.add(r.v);
      if (table === "supplier_invoices") invoiceDocumentIds.add(r.v);
    }
  }

  return duplicatesToRemove(docs, referenced, invoiceDocumentIds);
}

export type DuplicateReading = {
  removable: number;
  /** Distinct files behind those rows: what the removal actually spares him counting twice. */
  files: number;
  drawers: { category: string; rows: number; files: number }[];
  keptBecause: { reason: string; count: number }[];
};

/** What would go, without touching anything. */
export async function duplicateInvoiceDocuments(): Promise<DuplicateReading> {
  const p = await plan();
  const docs = await db.query.documents.findMany({ columns: { category: true, sha256: true } });
  const byDrawer = new Map<string, { rows: number; files: Set<string> }>();
  for (const d of docs) {
    if (!d.category.startsWith("invoice")) continue;
    const cur = byDrawer.get(d.category) ?? { rows: 0, files: new Set<string>() };
    cur.rows++;
    if (d.sha256) cur.files.add(d.sha256);
    byDrawer.set(d.category, cur);
  }
  return {
    removable: p.remove.length,
    files: new Set(p.remove.map((r) => r.sha256)).size,
    drawers: [...byDrawer]
      .map(([category, v]) => ({ category, rows: v.rows, files: v.files.size }))
      .sort((a, b) => a.category.localeCompare(b.category)),
    keptBecause: p.keptBecause,
  };
}

/**
 * Removes them, and says what it removed.
 *
 * The stored file goes with the row, because the row was the only thing naming it — the plan refuses
 * any row that shares a storage key, so nothing else can lose its document to this. A file that will
 * not delete is not a reason to abandon the clean-up: the row is what an inspector counts, and a
 * stranded file on disk costs nothing but space.
 */
export async function removeDuplicateInvoiceDocuments(by: {
  userId?: string | null;
  userName: string;
}): Promise<{ removed: number; files: number; says: string }> {
  const p = await plan();
  if (p.remove.length === 0) return { removed: 0, files: 0, says: "There are no duplicate invoice documents to remove." };

  const { deleteFile } = await import("./files");
  for (const r of p.remove) {
    if (r.storageKey) await deleteFile(r.storageKey).catch(() => {});
  }
  /* In batches, because a delete naming five hundred ids in one statement is a statement nothing can read back. */
  const ids = p.remove.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 100) {
    await db.delete(schema.documents).where(inArray(schema.documents.id, ids.slice(i, i + 100)));
  }

  const files = new Set(p.remove.map((r) => r.sha256)).size;
  const says =
    `${p.remove.length} duplicate invoice document${p.remove.length === 1 ? "" : "s"} removed, ` +
    `leaving one of each of ${files} file${files === 1 ? "" : "s"}. ` +
    `Every one was byte-identical to a document an invoice record still points at, and nothing anywhere named it.`;
  const { audit } = await import("./audit");
  await audit({ action: "documents.duplicates_removed", userId: by.userId ?? null, userName: by.userName, details: says });
  return { removed: p.remove.length, files, says };
}
