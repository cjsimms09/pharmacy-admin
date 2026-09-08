/**
 * The shelf count, proved against the record count the report prints about itself.
 *
 * PioneerRx's balance-on-hand export states how many records it contains. That figure is the only
 * independent check the on-hand family has: everything else the site knows about the count came out
 * of the same reader, so a reader that dropped rows and a report that never had them look
 * identical. The report's own count is the document's word against ours.
 *
 * ── Three numbers, and none of them is the answer on its own ──
 *
 *   reported   what the report says it contains
 *   read       the lines the reader found
 *   kept       the items stored on the shelf
 *
 * The 8 September count, re-filed once the column existed, reads 1,772 reported, 1,774 read, 1,771
 * kept — and every pair of those disagrees. Kept against reported is the proof and is the fraction.
 * Read against reported is a second, different fact: the reader found two more lines than the
 * report says it has records, which is what a wrapped row or a line that is not a record looks
 * like, and it is worth saying because it is the one number nobody would otherwise think to
 * compare. The skips explain the rest and are named with their reasons.
 *
 * A row that only reported "1,771 of 1,772" would be true, would look like rounding, and would
 * hide both of the other two facts.
 *
 * Pure.
 */

export type OnHandImportProof = {
  countedOn: string;
  fileName: string;
  /** Null for a count filed before migration 0092, or a report that printed no count of itself. */
  reportedCount: number | null;
  rowsRead: number;
  itemsKept: number;
  /** Why rows were dropped, by reason, as the reader recorded them. */
  skipped: Record<string, number>;
  /** Rows actually on the shelf table for this count, which is the last word. */
  storedRows: number;
};

const n = (x: number) => x.toLocaleString("en-US");

/** Total rows the reader declined, however many reasons there were. */
export function skippedTotal(i: OnHandImportProof): number {
  return Object.values(i.skipped).reduce((a, b) => a + b, 0);
}

/**
 * The fraction: items on the shelf, out of the records the report says it holds.
 *
 * Counts with no reported figure are outside the denominator rather than counted as failures. A
 * report that never printed a record count has not been contradicted by anything, and calling that
 * a failed proof would put a red row over a file that is doing nothing wrong.
 */
export function onHandProofFraction(imports: OnHandImportProof[]): { numerator: number; denominator: number } {
  const provable = imports.filter((i) => i.reportedCount !== null && i.reportedCount > 0);
  return {
    numerator: provable.reduce((a, i) => a + Math.min(i.storedRows, i.reportedCount!), 0),
    denominator: provable.reduce((a, i) => a + Math.max(i.reportedCount!, i.storedRows), 0),
  };
}

/** What differs, per count, in the words somebody would use to go and look. */
export function onHandProofGaps(imports: OnHandImportProof[]): string[] {
  const gaps: string[] = [];
  for (const i of imports) {
    const where = `The ${i.countedOn} count (${i.fileName})`;

    if (i.reportedCount === null) {
      gaps.push(
        `${where} has no record count of its own, so nothing independent says whether all of it was read. Either it was filed before the count was kept, or the report printed none.`,
      );
    } else if (i.storedRows !== i.reportedCount) {
      const by = i.reportedCount - i.storedRows;
      gaps.push(
        by > 0
          ? `${where} says it holds ${n(i.reportedCount)} records and ${n(i.storedRows)} are on the shelf — ${n(by)} of the report's own records reached no row.`
          : `${where} says it holds ${n(i.reportedCount)} records and ${n(i.storedRows)} are on the shelf — ${n(-by)} more rows than the report accounts for.`,
      );
    }

    /*
     * More lines read than the report says it has records.
     *
     * A separate fact from the one above and easily hidden by it. It is what a wrapped row looks
     * like — one record arriving as two lines — and also what a line that is not a record at all
     * looks like. Either way the reader's idea of a row and the report's idea of a record have come
     * apart, and that is worth a sentence even on a count whose stored total happens to agree.
     */
    if (i.reportedCount !== null && i.rowsRead > i.reportedCount) {
      gaps.push(
        `${where} was read as ${n(i.rowsRead)} lines against ${n(i.reportedCount)} records the report claims — ${n(i.rowsRead - i.reportedCount)} more lines than records, which is what a wrapped row or a line that is not a record looks like.`,
      );
    }

    const dropped = skippedTotal(i);
    if (dropped > 0) {
      const why = Object.entries(i.skipped)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, howMany]) => `${n(howMany)} ${reason}`)
        .join(", ");
      gaps.push(`${where} dropped ${n(dropped)} row${dropped === 1 ? "" : "s"}: ${why}.`);
    }

    // The stored rows and the kept count come from the same filing, so a difference is a write
    // that did not finish — the one failure here that is nobody's paperwork and everybody's problem.
    if (i.storedRows !== i.itemsKept) {
      gaps.push(
        `${where} recorded ${n(i.itemsKept)} items kept but the shelf holds ${n(i.storedRows)} for it. The filing did not finish writing.`,
      );
    }
  }
  return gaps;
}

export function onHandProofNote(imports: OnHandImportProof[]): string {
  if (imports.length === 0) return "No count of the shelf has been filed.";
  const provable = imports.filter((i) => i.reportedCount !== null);
  const exact = provable.filter((i) => i.storedRows === i.reportedCount).length;
  /*
   * The verbs move with the counts, in both clauses.
   *
   * "1 more print no record count and are outside this figure" is the shape this had, and it is
   * the same slip the claims proof's alert had — pluralising the noun and leaving the verb behind.
   * A sentence like that costs a little of the trust the whole page is for. Note that nought takes
   * the plural in English and one does not: nought hold, one holds, two hold.
   */
  const head =
    provable.length === 0
      ? `${n(imports.length)} count${imports.length === 1 ? "" : "s"} on file, none of which prints a record count of its own, so none can be proved against one.`
      : `${n(exact)} of ${n(provable.length)} count${provable.length === 1 ? "" : "s"} ${exact === 1 ? "holds" : "hold"} exactly the number of records their report claims.`;
  const unprovable = imports.length - provable.length;
  return (
    head +
    (unprovable > 0
      ? unprovable === 1
        ? " 1 more prints no record count and is outside this figure."
        : ` ${n(unprovable)} more print no record count and are outside this figure.`
      : "") +
    " The report's own count is the only check here that did not come out of the same reader as everything else."
  );
}
