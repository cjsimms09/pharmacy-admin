import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { onHandProofFraction, onHandProofGaps, onHandProofNote, skippedTotal, type OnHandImportProof } from "../src/lib/data-health-onhand-proof";

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
  skipped: { "with no NDC": 2, "with a code that is not an NDC": 1 },
  storedRows: 1_771,
  ...over,
});

describe("the real count, which does not reconcile cleanly", () => {
  const gaps = onHandProofGaps([sept8()]);

  test("one of the report's own records reached no row, and the row says so", () => {
    assert.match(gaps.join(" "), /says it holds 1,772 records and 1,771 are on the shelf — 1 of the report's own records reached no row/);
  });

  test("more lines were read than the report has records, which is a separate fact and is said separately", () => {
    /*
     * The number nobody would think to compare. Two more lines than records is what a wrapped row
     * looks like, and also what a line that is not a record looks like — either way the reader's
     * idea of a row and the report's idea of a record have come apart.
     */
    assert.match(gaps.join(" "), /read as 1,774 lines against 1,772 records the report claims — 2 more lines than records/);
  });

  test("the dropped rows are named with their reasons, worst first", () => {
    assert.match(gaps.join(" "), /dropped 3 rows: 2 with no NDC, 1 with a code that is not an NDC/);
    assert.equal(skippedTotal(sept8()), 3);
  });

  test("all three facts appear, so no one of them can stand for the count being right", () => {
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

  test("but a wrapped row is still called out even when the stored total happens to agree", () => {
    // Two lines read for one record, one of them dropped: stored lands on the reported figure by
    // luck. The count is right and the reader is not, and the second is worth knowing.
    const lucky = sept8({ reportedCount: 1_771, rowsRead: 1_773, itemsKept: 1_771, skipped: { "with no NDC": 2 }, storedRows: 1_771 });
    const g = onHandProofGaps([lucky]).join(" ");
    assert.match(g, /2 more lines than records/);
    assert.doesNotMatch(g, /reached no row/, "the stored total does agree, and the row must not claim otherwise");
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
    const rows = [sept8(), sept8({ countedOn: "2026-10-01", reportedCount: 1_000, rowsRead: 1_000, itemsKept: 900, storedRows: 900, skipped: { "with no NDC": 100 } })];
    assert.deepEqual(onHandProofFraction(rows), { numerator: 2_671, denominator: 2_772 });
    const g = onHandProofGaps(rows).join(" ");
    assert.match(g, /The 2026-09-08 count/);
    assert.match(g, /The 2026-10-01 count/);
    assert.match(onHandProofNote(rows), /0 of 2 counts hold exactly the number of records their report claims/);
  });
});
