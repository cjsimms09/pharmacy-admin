import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseNadacProof,
  nadacProofFraction,
  nadacProofGaps,
  nadacProofNote,
  parseNadacPrune,
  nadacPruneFraction,
  nadacPruneGaps,
  nadacPruneNote,
} from "../src/lib/data-health-nadac-proof";

/*
 * The benchmark every payment figure on this site is measured against, proved against its source.
 *
 * The numbers below are the first real run, 8 September 2026: 5 files, 5,754,041 rows read, 815,908
 * prices held over 43,396 NDCs, everything proved, nothing missing — and 770,412 prices sitting past
 * the cutoff because the prune had never run. That last figure is why there are two rows rather than
 * one: the prices were exactly right while the table was several times the size it should be, and a
 * single row would have shown one number and hidden the other.
 */
const proof = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    provedOn: "2026-09-08",
    cutoff: "2025-03-09",
    keepMonths: 18,
    files: [
      { file: "nadac-2026-09-02.csv", bytes: 8_400_000, sha256: "aaa", manifestSha256: "aaa", changedSinceLoad: false, loadedAt: "2026-09-02T05:00:00.000Z", rowsRead: 30_000, rowsUnreadable: 4, unreadableReasons: { "CMS placeholder row, not a price": 4 }, effectiveFrom: "2026-08-26", effectiveTo: "2026-09-02", proved: 30_000, prunedAway: 0, missing: 0, problems: [] },
      { file: "nadac-archive-2020.csv", bytes: 96_000_000, sha256: "bbb", manifestSha256: "bbb", changedSinceLoad: false, loadedAt: "2026-09-01T05:00:00.000Z", rowsRead: 5_724_041, rowsUnreadable: 0, unreadableReasons: {}, effectiveFrom: "2020-01-01", effectiveTo: "2026-08-19", proved: 5_724_041, prunedAway: 0, missing: 0, problems: [] },
    ],
    rowsInFiles: 5_754_041,
    provedRows: 5_754_041,
    provedKeys: 815_908,
    prunedRows: 0,
    missingRows: 0,
    missingKeys: 0,
    missingKeysCapped: false,
    tableRows: 815_908,
    tableNdcs: 43_396,
    tableRowsNoFileAccountsFor: 0,
    prunableStillHeld: 770_412,
    prunableStillHeldNdcs: 41_002,
    lines: [],
    ...over,
  });

describe("the NADAC proof row", () => {
  test("the fraction counts prices, never rows", () => {
    const p = parseNadacProof(proof())!;
    assert.deepEqual(nadacProofFraction(p), { numerator: 815_908, denominator: 815_908 });
    // 5,754,041 of 5,754,041 would be true, complete, and worthless.
    assert.notEqual(nadacProofFraction(p).denominator, p.rowsInFiles);
  });

  test("a price in the files the table never got costs the percentage", () => {
    const p = parseNadacProof(proof({ missingKeys: 50, missingRows: 350 }))!;
    const f = nadacProofFraction(p);
    assert.equal(f.denominator, 815_958, "the denominator counts prices the table has not got");
    assert.equal(f.numerator, 815_908);
    assert.ok(f.numerator < f.denominator);
    assert.match(nadacProofGaps(p).join(" "), /50 prices in the CMS files reached no row in the table/);
  });

  test("a price the table holds that no file explains costs it too, from the other side", () => {
    const p = parseNadacProof(proof({ provedKeys: 815_508, tableRowsNoFileAccountsFor: 400 }))!;
    const f = nadacProofFraction(p);
    assert.ok(f.numerator < f.denominator, "a stray on either side must stop this reading complete");
    assert.match(nadacProofGaps(p).join(" "), /400 prices in the table are accounted for by no file/);
  });

  test("a file that changed since it was loaded is named first, above every other fault", () => {
    /*
     * The one fault where every count is right. The table faithfully holds what the old file said
     * and the file saying it is gone, so nothing else on this page could ever notice.
     */
    const p = parseNadacProof(
      proof({
        files: [{ file: "nadac-2026-09-02.csv", bytes: 1, sha256: "ccc", manifestSha256: "aaa", changedSinceLoad: true, loadedAt: "2026-09-02T05:00:00.000Z", rowsRead: 1, rowsUnreadable: 0, unreadableReasons: {}, effectiveFrom: null, effectiveTo: null, proved: 1, prunedAway: 0, missing: 0, problems: [] }],
        prunableStillHeld: 0,
      }),
    )!;
    const gaps = nadacProofGaps(p);
    assert.match(gaps[0], /is not the file that was loaded on 2026-09-02/);
    assert.match(gaps[0], /the proof reports this and never loads anything itself/);
  });

  test("the pruner falling behind is reported here, because this row is the only thing that can see it", () => {
    const p = parseNadacProof(proof())!;
    assert.deepEqual(nadacProofFraction(p), { numerator: 815_908, denominator: 815_908 }, "every price is right");
    assert.match(nadacProofGaps(p).join(" "), /770,412 prices across 41,002 NDCs are older than 2025-03-09 with a newer price held/);
    assert.match(nadacProofGaps(p).join(" "), /The prices are not wrong; the table is growing/);
  });

  test("rows that were never prices are counted apart from prices that went missing", () => {
    assert.match(nadacProofGaps(parseNadacProof(proof())!).join(" "), /4 rows in the CMS files were not prices and were not counted: 4 CMS placeholder row, not a price/);
  });

  test("the note says prices and rows are different, because the difference is seven-fold", () => {
    const note = nadacProofNote(parseNadacProof(proof())!);
    assert.match(note, /5,754,041 rows carrying 815,908 distinct prices/);
    assert.match(note, /815,908 held over 43,396 NDCs/);
    assert.match(note, /effective 2020-01-01 to 2026-09-02/);
    assert.match(note, /rows far exceed prices and only prices are counted here/);
  });

  test("never run is null, and a run that read no file says so rather than reading as complete", () => {
    assert.equal(parseNadacProof(undefined), null);
    assert.equal(parseNadacProof("not json"), null);
    assert.match(nadacProofNote(parseNadacProof(proof({ files: [] }))!), /found no CMS file in the NADAC folder/);
  });
});

/*
 * The prune, which is a job and not a proportion.
 *
 * Its own row on purpose. On 8 September the prices were perfect and the table held 770,000 rows
 * that should have been deleted — one row showing one number would have shown the good half.
 */
describe("the NADAC prune row", () => {
  test("a successful run reads complete and says what it removed", () => {
    const p = parseNadacPrune("2026-09-09T04:10:02.114Z: removed 770,412 prices in 8213ms")!;
    assert.equal(p.ok, true);
    assert.equal(p.removed, 770_412);
    assert.equal(p.at, "2026-09-09T04:10:02.114Z");
    assert.deepEqual(nadacPruneFraction(p), { numerator: 1, denominator: 1 });
    assert.deepEqual(nadacPruneGaps(p), []);
    assert.match(nadacPruneNote(p), /removed 770,412 prices past the cutoff/);
  });

  test("a failed run is a red row and carries the reason", () => {
    const p = parseNadacPrune("2026-09-09T04:10:02.114Z: failed: database is locked")!;
    assert.equal(p.ok, false);
    assert.deepEqual(nadacPruneFraction(p), { numerator: 0, denominator: 1 });
    assert.match(nadacPruneGaps(p)[0], /The last NADAC prune failed: database is locked/);
    assert.match(nadacPruneGaps(p)[0], /the benchmark table grows, and every reading over it grows with it/);
  });

  test("removing nothing is the finished state, not a failure", () => {
    const p = parseNadacPrune("2026-09-20T04:10:00.000Z: removed 0 prices in 40ms")!;
    assert.equal(p.ok, true);
    assert.deepEqual(nadacPruneGaps(p), []);
    assert.match(nadacPruneNote(p), /removed nothing, which is the ordinary state once the table is trimmed/);
  });

  test("the word failed only counts after the timestamp, so a message that contains it elsewhere does not", () => {
    // A drug or a path with "failed" in it must not turn a good run into a red row.
    const p = parseNadacPrune("2026-09-09T04:10:02.114Z: removed 12 prices in 9ms (skipped nadac-failed-download.csv)")!;
    assert.equal(p.ok, true);
    assert.equal(p.removed, 12);
  });

  test("never run has nothing to measure, and is not a failure", () => {
    assert.equal(parseNadacPrune(undefined), null);
    assert.equal(parseNadacPrune(""), null);
    assert.deepEqual(nadacPruneFraction(null), { numerator: 0, denominator: 0 });
    assert.deepEqual(nadacPruneGaps(null), []);
    assert.match(nadacPruneNote(null), /has not recorded a run/);
  });
});
