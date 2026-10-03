import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { onHandProofFraction, onHandProofGaps, onHandProofNote, skippedTotal, type OnHandImportProof } from "../src/lib/data-health-onhand-proof";
import { ON_HAND_SKIP } from "../src/lib/on-hand";

/*
 * The shelf count against the record count the report prints about itself.
 *
 * Everything else the site knows about a count came out of the same reader, so a reader that
 * dropped rows and a report that never had them look identical. PioneerRx printing its own record
 * count is the one figure that did not come from us, which is what makes it a proof and not
 * another measurement.
 *
 * The numbers below are the real 8 September count, re-filed once the column existed: 1,772
 * reported, 1,774 read, 1,771 kept, three rows dropped. Every pair of those disagrees, and the
 * tests are that the row says all three rather than the one that flatters.
 */
const sept8 = (over: Partial<OnHandImportProof> = {}): OnHandImportProof => ({
  countedOn: "2026-09-08",
  fileName: "balance-on-hand.txt",
  reportedCount: 1_772,
  rowsRead: 1_774,
  itemsKept: 1_771,
  skipped: { [ON_HAND_SKIP.noNdc]: 2, [ON_HAND_SKIP.badCode]: 1 },
  storedRows: 1_771,
  ...over,
});

describe("the real count, which does not reconcile cleanly", () => {
  const gaps = onHandProofGaps([sept8()]);

  test("one of the report's own records reached no row, and the row says so", () => {
    assert.match(gaps.join(" "), /says it holds 1,772 records and 1,771 are on the shelf — 1 of the report's own records reached no row/);
  });

  test("three items of real stock are missing, which the record counts forgive and the shelf does not", () => {
    /*
     * The finding, and the one the fraction cannot show. All three dropped rows carried a quantity
     * — that is what made them records rather than wrapped tails — so all three are bottles on a
     * shelf that the table valuing the inventory does not have. The report itself does not count
     * two of them, which is exactly how three missing items hide behind "1,771 of 1,772".
     */
    assert.match(gaps.join(" "), /holds 3 items with a quantity and no usable NDC, so they are real stock the shelf does not carry/);
    assert.match(gaps.join(" "), /The report does not count them as records either, which is why the totals can still appear to agree/);
  });

  test("more lines than records is not flagged, because the uncoded items explain it exactly", () => {
    /*
     * The first wrong answer, held so it cannot come back. 1,774 against 1,772 looked like two
     * wrapped rows and was not: PioneerRx does not count an item with no NDC as a record, so a file
     * with three such items has more lines than records by arithmetic rather than by fault. Crying
     * wolf here would be crying it on every count this pharmacy ever files.
     */
    assert.doesNotMatch(gaps.join(" "), /unaccounted for/);
  });

  test("an excess the uncoded items do not explain is still flagged, and says how much is left over", () => {
    const odd = sept8({ rowsRead: 1_776 });
    assert.match(onHandProofGaps([odd]).join(" "), /only 3 of the 4 extra are items with no usable code\. 1 line is unaccounted for/);
  });

  test("the dropped rows are named with their reasons, worst first", () => {
    assert.match(gaps.join(" "), /dropped 3 rows: 2 no NDC, 1 code is neither an NDC nor a barcode/);
    assert.equal(skippedTotal(sept8()), 3);
  });

  test("three facts appear, and none of them can stand for the count being right", () => {
    // Short by one record; three items of real stock gone; three rows dropped and why.
    assert.equal(gaps.length, 3);
  });

  test("the fraction is what is stored against what the report claims", () => {
    assert.deepEqual(onHandProofFraction([sept8()]), { numerator: 1_771, denominator: 1_772 });
  });
});

describe("a count that agrees with its report", () => {
  const clean = sept8({ reportedCount: 1_771, rowsRead: 1_771, itemsKept: 1_771, skipped: {}, storedRows: 1_771 });

  test("says nothing at all, which is what makes the sentences above worth reading", () => {
    assert.deepEqual(onHandProofGaps([clean]), []);
    assert.deepEqual(onHandProofFraction([clean]), { numerator: 1_771, denominator: 1_771 });
  });

  test("stock dropped for want of a code is named even when every total agrees", () => {
    /*
     * The case the fraction is blind to by construction. Two items with no NDC: the report does not
     * count them, so reported, read and stored all agree perfectly and the row reads complete —
     * while two bottles sit on the shelf that the inventory is not valued at.
     */
    const hidden = sept8({ reportedCount: 1_771, rowsRead: 1_773, itemsKept: 1_771, skipped: { [ON_HAND_SKIP.noNdc]: 2 }, storedRows: 1_771 });
    const g = onHandProofGaps([hidden]).join(" ");
    assert.deepEqual(onHandProofFraction([hidden]), { numerator: 1_771, denominator: 1_771 }, "the fraction is complete");
    assert.match(g, /holds 2 items with a quantity and no usable NDC/);
    assert.doesNotMatch(g, /reached no row/, "the stored total does agree, and the row must not claim otherwise");
    assert.doesNotMatch(g, /unaccounted for/, "two uncoded items explain two extra lines exactly");
  });

  test("one such item reads as one, in every clause", () => {
    const one = sept8({ reportedCount: 1_771, rowsRead: 1_772, itemsKept: 1_771, skipped: { [ON_HAND_SKIP.badCode]: 1 }, storedRows: 1_771 });
    assert.match(onHandProofGaps([one]).join(" "), /holds 1 item with a quantity and no usable NDC, so it is real stock/);
    assert.match(onHandProofGaps([one]).join(" "), /The report does not count it as a record either/);
  });
});

describe("counts that cannot be proved", () => {
  test("no record count of its own is named as unprovable, not counted as a failure", () => {
    const old = sept8({ reportedCount: null });
    assert.deepEqual(onHandProofFraction([old]), { numerator: 0, denominator: 0 }, "outside the fraction entirely");
    assert.match(onHandProofGaps([old])[0], /has no record count of its own/);
    assert.match(onHandProofGaps([old])[0], /filed before the count was kept, or the report printed none/);
  });

  test("an unprovable count does not drag a provable one down, and does not hide behind it either", () => {
    const rows = [sept8(), sept8({ countedOn: "2026-08-01", reportedCount: null })];
    assert.deepEqual(onHandProofFraction(rows), { numerator: 1_771, denominator: 1_772 });
    assert.match(onHandProofNote(rows), /1 more prints no record count and is outside this figure/);
  });

  test("no counts at all is said plainly", () => {
    assert.match(onHandProofNote([]), /No count of the shelf has been filed\./);
    assert.deepEqual(onHandProofFraction([]), { numerator: 0, denominator: 0 });
  });
});

describe("a filing that did not finish", () => {
  test("items kept and rows on the shelf disagreeing is a write that stopped, and is said as one", () => {
    const half = sept8({ storedRows: 900 });
    const g = onHandProofGaps([half]).join(" ");
    assert.match(g, /recorded 1,771 items kept but the shelf holds 900 for it\. The filing did not finish writing\./);
  });

  test("more rows on the shelf than the report accounts for reads as a fault, not as more than complete", () => {
    const extra = sept8({ storedRows: 1_800 });
    const f = onHandProofFraction([extra]);
    assert.ok(f.numerator <= f.denominator, "28 extra rows must never print above 100%");
    assert.match(onHandProofGaps([extra]).join(" "), /28 more rows than the report accounts for/);
  });
});

describe("more than one count", () => {
  test("each is proved against its own report rather than rolled into one total", () => {
    // A complete count must not cover a short one; the fraction adds per document.
    const rows = [sept8(), sept8({ countedOn: "2026-10-01", reportedCount: 1_000, rowsRead: 1_000, itemsKept: 900, storedRows: 900, skipped: { [ON_HAND_SKIP.noNdc]: 100 } })];
    assert.deepEqual(onHandProofFraction(rows), { numerator: 2_671, denominator: 2_772 });
    const g = onHandProofGaps(rows).join(" ");
    assert.match(g, /The 2026-09-08 count/);
    assert.match(g, /The 2026-10-01 count/);
    assert.match(onHandProofNote(rows), /0 of 2 counts hold exactly the number of records their report claims/);
  });
});
