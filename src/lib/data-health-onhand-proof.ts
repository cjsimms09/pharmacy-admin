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
 * The 8 September count reads 1,772 reported, 1,774 read, 1,771 kept, and every pair of those
 * disagrees. Working out why took two wrong answers, and both are worth keeping.
 *
 * The first was that the two extra lines were wrapped manufacturer names counted as products. That
 * story fitted the arithmetic exactly and was wrong: the lines are complete records — a drug, a
 * size, a cost, an order point, a quantity — sitting between complete neighbours that lack nothing.
 * What they share is no usable NDC, and PioneerRx does not count an item without one as a record.
 * More lines than records is the report counting something narrower than the file, not a fault.
 *
 * The second was that this left the shelf short by one. It leaves it short by three. Every row
 * dropped for want of a usable code carried a quantity — that is what made it a record rather than
 * a wrapped tail — so all three are real stock, on a real shelf, missing from the table that values
 * the inventory. The record counts forgive two of them because the report does not count them
 * either, which is exactly how three missing bottles hide behind a fraction reading 1,771 of 1,772.
 *
 * So the row says three things, and no one of them can stand for the count being right: what the
 * shelf holds against what the report claims; whether the extra lines are explained; and how much
 * real stock was dropped for want of a code.
 *
 * Pure.
 */
import { ON_HAND_UNCODED_REASONS } from "./on-hand";


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
     * More lines read than the report says it has records — which on this report is not a fault.
     *
     * I called the 8 September count's 1,774 against 1,772 two wrapped rows, and said the shelf was
     * whole. It was neither. Both lines are complete records in their own right — a drug, a size, a
     * cost, an order point, a quantity — sitting between complete neighbours that lack nothing, and
     * what they have in common is no usable NDC. PioneerRx does not count an item without one as a
     * record. The file has more lines than the report has records because the report is counting
     * something narrower, and that is the report being consistent with itself.
     *
     * So the excess earns a sentence only where the items dropped for want of a code do not explain
     * it. Where they do, the arithmetic is closed, and saying anything would be crying wolf over a
     * file behaving exactly as it should.
     */
    const uncoded = ON_HAND_UNCODED_REASONS.reduce((a, r) => a + (i.skipped[r] ?? 0), 0);
    if (i.reportedCount !== null && i.rowsRead > i.reportedCount) {
      const excess = i.rowsRead - i.reportedCount;
      if (excess > uncoded) {
        const left = excess - uncoded;
        gaps.push(
          `${where} was read as ${n(i.rowsRead)} lines against ${n(i.reportedCount)} records the report claims, and only ${n(uncoded)} of the ${n(excess)} extra are items with no usable code. ${n(left)} ${left === 1 ? "line is" : "lines are"} unaccounted for.`,
        );
      }
    }

    /*
     * Stock the shelf does not know it has, which is the money question and was nearly missed.
     *
     * Every row dropped for want of a usable code still carried a quantity — that is exactly what
     * made it a record rather than a wrapped tail. So each one is real stock, on a real shelf,
     * absent from the table that values the inventory and stands on one side of the cost-of-goods
     * identity. Three of them on the 8 September count, not the one the record counts suggest.
     *
     * Said separately from the report's own count on purpose, because the two disagree about how
     * many of these matter. The report forgives the ones with no NDC, not counting them as records
     * either, so the totals appear to close. The pharmacy's shelf forgives none of them: the
     * bottles are there whatever the header says.
     */
    if (uncoded > 0) {
      gaps.push(
        `${where} holds ${n(uncoded)} item${uncoded === 1 ? "" : "s"} with a quantity and no usable NDC, so ${uncoded === 1 ? "it is" : "they are"} real stock the shelf does not carry and the inventory is not valued at. The report does not count ${uncoded === 1 ? "it as a record" : "them as records"} either, which is why the totals can still appear to agree.`,
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
