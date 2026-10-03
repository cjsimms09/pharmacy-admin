/**
 * Which copies of a document may be removed, and the four things that have to be true first.
 *
 * ── Where 535 copies came from ──
 *
 * `documents.sha256` has been written since the table existed and was never read when the mailbox
 * stored an attachment, so a message carrying bytes the site already held filed them again. It cost
 * little while that happened once a week. On 16 September 2026 the sweep was changed to read mail
 * that had already been opened, fifty-five messages arrived at once, and for one night the same
 * attachments were re-filed twice an hour: 599 invoice-category document rows behind 64 actual
 * files, and one file with twenty-eight copies of itself.
 *
 * The leak is fixed — the sweep dedupes on content now — and this is the clearing up. The archive was
 * never wrong: every invoice has its document and no invoice is missing. What is wrong is the
 * counting. The Schedule II drawer holds 151 rows for 13 files, and an inspector counting Schedule II
 * records gets twenty times the invoices. Nothing is breached; the first question is still "why".
 *
 * ── The four conditions ──
 *
 * This deletes records from the archive a DEA inspection reads, so it refuses unless every one holds
 * for the row in front of it:
 *
 *   1. **Nothing points at it.** No invoice, expense, receipt, payment or inbox line names this id.
 *   2. **Its bytes survive.** Another row with the same sha256 IS pointed at by an invoice, so the
 *      document itself remains in the archive and can still be produced.
 *   3. **It does not share a file.** No other row uses the same storage key, so removing this row's
 *      file cannot take the kept row's document with it.
 *   4. **It is one of these.** Only invoice-category rows, because that is where the duplication
 *      happened and a rule that ranges wider than its evidence is how a clean-up becomes an incident.
 *
 * A row failing any of them is left alone for ever. The cost of keeping a duplicate is a number on a
 * screen; the cost of deleting the only copy of a Schedule II invoice is the kind that ends with
 * somebody explaining themselves to a board.
 *
 * Pure, so what would go can be listed and counted before anything does.
 */

export type DocumentRow = {
  id: string;
  category: string;
  sha256: string | null;
  storageKey: string | null;
};

export type Removable = { id: string; storageKey: string | null; sha256: string; keptId: string };

export type RemovalPlan = {
  remove: Removable[];
  /** Kept and why, counted rather than listed: the reader wants the number and the reason, not 64 ids. */
  keptBecause: { reason: string; count: number }[];
};

export function duplicatesToRemove(
  docs: DocumentRow[],
  /** Every document id anything at all points at — invoices, expenses, receipts, payments, inbox lines. */
  referenced: Set<string>,
  /** Document ids a supplier invoice points at: the copy that must survive. */
  invoiceDocumentIds: Set<string>,
): RemovalPlan {
  const remove: Removable[] = [];
  const kept = new Map<string, number>();
  const keep = (reason: string) => kept.set(reason, (kept.get(reason) ?? 0) + 1);

  /* Which storage keys are used more than once, so a shared file is never deleted from under a row. */
  const keyUses = new Map<string, number>();
  for (const d of docs) if (d.storageKey) keyUses.set(d.storageKey, (keyUses.get(d.storageKey) ?? 0) + 1);

  /* For each set of identical bytes, the copy an invoice record points at. */
  const keeperBySha = new Map<string, string>();
  for (const d of docs) {
    if (!d.sha256) continue;
    if (invoiceDocumentIds.has(d.id) && !keeperBySha.has(d.sha256)) keeperBySha.set(d.sha256, d.id);
  }

  for (const d of docs) {
    if (!d.category.startsWith("invoice")) {
      keep("not an invoice record, so outside what this may touch");
      continue;
    }
    if (!d.sha256) {
      keep("no content hash on file, so nothing can prove another copy is identical");
      continue;
    }
    if (referenced.has(d.id)) {
      keep("something points at it");
      continue;
    }
    const keptId = keeperBySha.get(d.sha256);
    if (!keptId) {
      keep("no copy of these bytes is held against an invoice, so this may be the only one");
      continue;
    }
    if (d.storageKey && (keyUses.get(d.storageKey) ?? 0) > 1) {
      keep("it shares its file with another row");
      continue;
    }
    remove.push({ id: d.id, storageKey: d.storageKey, sha256: d.sha256, keptId });
  }

  return { remove, keptBecause: [...kept].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) };
}
