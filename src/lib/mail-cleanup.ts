/**
 * Whether a message in the mailbox has been taken properly enough to delete.
 *
 * The owner, 17 September 2026: "can i delete email in gmail?? can we do this automatically once we
 * have what we need?" — and then, asked whether to archive or delete: "delete on gmail".
 *
 * ── Why this is the most careful function in the mail path ──
 *
 * Everything else here can be done again. A misread invoice can be read again, a wrong route can be
 * corrected, a duplicate can be deduped. A deleted email cannot be got back, and on the day something
 * has gone wrong it is the only remaining evidence of what a supplier actually sent — the bytes, the
 * headers, the date, the address. So the test is not "did we finish with it" but **"can we prove we
 * have it"**, and anything short of proof leaves the message where it is.
 *
 * Four conditions, and all four have to hold:
 *
 *   1. It produced at least one line. A message that produced none was never processed at all.
 *   2. Every line is stored. One refused or ignored attachment means part of it was not taken, and a
 *      message is not half-kept.
 *   3. Nothing it says sounds like a failure. A reader that could not read, a gate that held a
 *      figure, a total that would not balance — every one of those is a thing somebody may have to
 *      go back to the original for.
 *   4. Nothing is "unrecognised". The site does not know what that was, and a document nobody has
 *      identified is the last one to throw the envelope away for.
 *
 * A message that fails any of these stays in the mailbox for ever, which is the safe direction: the
 * cost is an inbox that is not quite empty, and the cost the other way is evidence that is gone.
 *
 * Pure, so what would be deleted can be examined before anything is.
 */

export type HandledRow = {
  status: string | null;
  routedAs: string | null;
  routeResult: string | null;
  documentId: string | null;
};

/**
 * Words that mean a reader stopped short, in the wording this site actually uses.
 *
 * Matched against what the row says rather than against a status, because the status is "stored" for
 * every one of them: the document was filed and the reading failed, which is exactly the case where
 * the original is still wanted.
 */
const SOUNDS_UNFINISHED =
  /could not|cannot|not read|unreadable|does not balance|do not add|held|refus|failed|no\s+(?:item\s+)?lines?|not recognised|unrecognised|by hand/i;

export function safeToDelete(rows: HandledRow[]): { ok: boolean; why: string } {
  if (rows.length === 0) return { ok: false, why: "nothing was recorded for it" };
  const notStored = rows.filter((r) => r.status !== "stored");
  if (notStored.length > 0) return { ok: false, why: `${notStored.length} of its attachments were not stored` };
  const unknown = rows.filter((r) => (r.routedAs ?? "") === "unrecognised" || (r.routedAs ?? "") === "");
  if (unknown.length > 0) return { ok: false, why: "the site could not say what it was" };
  const unfinished = rows.filter((r) => SOUNDS_UNFINISHED.test(r.routeResult ?? ""));
  if (unfinished.length > 0) return { ok: false, why: "a reader stopped short of finishing it" };
  return { ok: true, why: `${rows.length} line${rows.length === 1 ? "" : "s"}, all stored and read` };
}
