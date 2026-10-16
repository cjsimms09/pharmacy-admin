/**
 * One row per delivered attachment, and which copy survives when there are twenty-eight.
 *
 * ── What happened ──
 *
 * The mailbox keys an inbox row on `<message-id>#<file name>`, which is exactly right: one row per
 * attachment per message. The dedupe that was meant to enforce it looked the key up the wrong way
 * for a while, and between 16 and 17 September 2026 the sweep ran twice an hour over mail it had
 * already read. 1,822 inbox rows for 180 delivered attachments. Both leaks — this and the document
 * one — stopped at 04:00 on the 17th; this is the clearing up behind them.
 *
 * ── Why the surviving row has to be chosen rather than picked ──
 *
 * The copies are not interchangeable. Each pass stored its own copy of the attachment, so the rows
 * for one message point at up to six different document ids — and some point at nothing, because
 * the pass that made them refused the attachment or never got that far. Keeping an arbitrary row
 * therefore risks keeping the one whose document does not exist, which reads on the inbox page as an
 * arrival with nothing behind it: the exact shape of the row that cannot be explained by looking at
 * it.
 *
 * So: prefer a row whose document is still there, then the earliest sweep, which is the one whose
 * timestamps describe when the message actually arrived.
 *
 * ── Why this one is allowed to run by itself ──
 *
 * An inbox row is a record of the post, not a pharmacy record. No inspector counts them, no invoice
 * points at one, and the documents they refer to are untouched by this — a row is removed, never a
 * file. The invoice archive clean-up is the one that needs a person's hand on it, and does.
 *
 * Pure. Nothing here reads or writes a database.
 */

export type InboxRow = {
  id: string;
  /** `<message-id>#<file name>`: one delivered attachment. Rows sharing it are the same arrival. */
  messageId: string;
  documentId: string | null;
  sweptAt: string | null;
};

export type InboxDedupe = {
  remove: string[];
  /** How many arrivals there really were, so the count can be said rather than implied. */
  arrivals: number;
  /**
   * Rows kept whose document is missing anyway, because every copy of that arrival lost its
   * document. Counted, not hidden: it is a real gap and this is not the thing that fixes it.
   */
  keptWithNoDocument: number;
};

/**
 * @param rows every inbox row
 * @param liveDocumentIds the ids of documents that actually exist
 */
export function inboxRowsToRemove(rows: InboxRow[], liveDocumentIds: Set<string>): InboxDedupe {
  const byKey = new Map<string, InboxRow[]>();
  for (const r of rows) {
    const at = byKey.get(r.messageId);
    if (at) at.push(r);
    else byKey.set(r.messageId, [r]);
  }

  const remove: string[] = [];
  let keptWithNoDocument = 0;
  for (const group of byKey.values()) {
    if (group.length === 1) {
      if (!group[0].documentId || !liveDocumentIds.has(group[0].documentId)) keptWithNoDocument++;
      continue;
    }
    const ranked = [...group].sort((a, b) => {
      const aHas = a.documentId !== null && liveDocumentIds.has(a.documentId);
      const bHas = b.documentId !== null && liveDocumentIds.has(b.documentId);
      if (aHas !== bHas) return aHas ? -1 : 1;
      /* Then the earliest sweep. A null sweep time sorts last: it knows least about when this came. */
      const at = a.sweptAt ?? "￿";
      const bt = b.sweptAt ?? "￿";
      if (at !== bt) return at < bt ? -1 : 1;
      /* Finally the id, so the same input always produces the same answer. */
      return a.id < b.id ? -1 : 1;
    });
    const keep = ranked[0];
    if (!keep.documentId || !liveDocumentIds.has(keep.documentId)) keptWithNoDocument++;
    for (const r of ranked.slice(1)) remove.push(r.id);
  }

  return { remove, arrivals: byKey.size, keptWithNoDocument };
}
