import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseDirectoryProof,
  directoryProofFraction,
  directoryProofGaps,
  directoryProofNote,
  proofAgeDays,
  DIRECTORY_STALE_DAYS,
} from "../src/lib/data-health-directory-proof";

/*
 * The directory, proved by the loader rather than by a nightly re-read.
 *
 * Re-reading the two zips every night would be a 430 MB peak on a 7.3 GB machine that ran out
 * twice on 8 September, to prove files the FDA changes weekly. At the moment the loader writes, it
 * already holds every figure the proof needs, so it stamps them and this reads them back.
 *
 * That trade has a cost and the tests are mostly about it: this can see the table drifting from
 * what was loaded, and it cannot see the FDA changing the file. What stands in for the second is
 * the date, which is the load's — so a fetch that quietly stopped shows as an ageing proof over
 * counts that are all perfectly correct.
 */
const proof = JSON.stringify({
  provedOn: "2026-09-08T07:02:00.000Z",
  parsed: { products: 60_411, packages: 217_773, orangeBook: 44_120 },
  wrote: { rows: 217_773, rated: 120_004 },
  origin: "fda.gov",
  files: {
    ndcDirectory: { bytes: 41_943_040, sha256: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90" },
    orangeBook: { bytes: 3_145_728, sha256: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0" },
  },
});

describe("reading what the load stamped", () => {
  test("a load that wrote what it parsed, with the table holding exactly that, is complete", () => {
    const p = parseDirectoryProof(proof)!;
    assert.deepEqual(directoryProofFraction(p, 217_773), { numerator: 217_773, denominator: 217_773 });
    assert.deepEqual(directoryProofGaps(p, 217_773, "2026-09-09"), []);
  });

  test("never proved is null, and a proof that cannot say what it wrote is not a proof of zero", () => {
    assert.equal(parseDirectoryProof(undefined), null);
    assert.equal(parseDirectoryProof("not json"), null);
    assert.equal(parseDirectoryProof("[]"), null);
    assert.equal(parseDirectoryProof(JSON.stringify({ provedOn: "2026-09-08", wrote: {} })), null, "no row count is nothing to prove against");
  });

  test("a file the load did not touch is null, which is not the same as it having no rows", () => {
    // The Orange Book refreshed alone: the packages were rebuilt from what was held, not re-read.
    const p = parseDirectoryProof(JSON.stringify({ provedOn: "2026-09-08T07:00:00Z", parsed: { orangeBook: 44_120 }, wrote: { rows: 217_773, rated: 120_004 } }))!;
    assert.equal(p.parsed.products, null);
    assert.equal(p.parsed.packages, null);
    assert.equal(p.parsed.orangeBook, 44_120);
  });
});

describe("the table drifting from what was written", () => {
  test("rows lost since the load cost the percentage and name themselves", () => {
    const p = parseDirectoryProof(proof)!;
    const f = directoryProofFraction(p, 217_000);
    assert.equal(f.numerator, 217_000);
    assert.equal(f.denominator, 217_773);
    assert.match(directoryProofGaps(p, 217_000, "2026-09-09")[0], /773 fewer than were written\. Something has removed rows since\./);
  });

  test("rows added that the loader never wrote read as a fault, not as more than complete", () => {
    const p = parseDirectoryProof(proof)!;
    const f = directoryProofFraction(p, 218_000);
    assert.ok(f.numerator <= f.denominator, "227 extra rows must never print as 100.1%");
    assert.equal(f.denominator, 218_000);
    assert.match(directoryProofGaps(p, 218_000, "2026-09-09")[0], /227 more than were written\. Something has added rows the loader did not\./);
  });
});

describe("staleness, which is the half a re-read would have hidden", () => {
  test("the age is counted from the load, not from the health sweep", () => {
    const p = parseDirectoryProof(proof)!;
    assert.equal(proofAgeDays(p, "2026-09-09"), 1);
    assert.equal(proofAgeDays(p, "2026-09-30"), 22);
  });

  test("a fetch that quietly stopped shows here even though every count is right", () => {
    /*
     * The case the whole design turns on. A nightly re-read would have refreshed the date and gone
     * on reporting a perfect match against a directory three weeks out of date; the proof's date
     * being the load's is what makes the silence visible.
     */
    const p = parseDirectoryProof(proof)!;
    const gaps = directoryProofGaps(p, 217_773, "2026-09-30");
    assert.equal(directoryProofFraction(p, 217_773).numerator, 217_773, "the counts still agree perfectly");
    assert.match(gaps[0], /last loaded 22 days ago/);
    assert.match(gaps[0], /counts here can be perfectly correct and the contents 22 days out of date/);
  });

  test("inside the window nothing is said, because the FDA publishes weekly", () => {
    const p = parseDirectoryProof(proof)!;
    assert.deepEqual(directoryProofGaps(p, 217_773, "2026-09-16"), [], `${DIRECTORY_STALE_DAYS} days is the allowance`);
  });

  test("a proof with an unreadable date has no age rather than a wrong one", () => {
    const p = parseDirectoryProof(JSON.stringify({ provedOn: "whenever", wrote: { rows: 10, rated: 0 } }))!;
    assert.equal(proofAgeDays(p, "2026-09-09"), null);
  });
});

describe("a load of one file only", () => {
  test("refreshing the Orange Book alone says the packages are older than the proof's date", () => {
    const p = parseDirectoryProof(JSON.stringify({ provedOn: "2026-09-08T07:00:00Z", parsed: { orangeBook: 44_120 }, wrote: { rows: 217_773, rated: 120_004 }, origin: "fda.gov" }))!;
    const gaps = directoryProofGaps(p, 217_773, "2026-09-09");
    assert.match(gaps.join(" "), /refreshed the Orange Book alone.*older than this proof's date/);
  });

  test("refreshing the directory alone says the ratings were carried forward", () => {
    const p = parseDirectoryProof(JSON.stringify({ provedOn: "2026-09-08T07:00:00Z", parsed: { products: 60_411, packages: 217_773 }, wrote: { rows: 217_773, rated: 120_004 }, origin: "fda.gov" }))!;
    assert.match(directoryProofGaps(p, 217_773, "2026-09-09").join(" "), /carried forward from what was already held/);
  });
});

describe("the note", () => {
  test("it says what was read, what it joined to, and what the table holds", () => {
    const note = directoryProofNote(parseDirectoryProof(proof)!, 217_773);
    assert.match(note, /60,411 products and 217,773 packages read from the NDC Directory/);
    assert.match(note, /44,120 Orange Book products/);
    assert.match(note, /joined to 217,773 rows, 120,004 of them with a rating/);
    assert.match(note, /The table holds exactly that\./);
  });

  test("the file's fingerprint is on it, so an unchanged count can be told from an unchanged file", () => {
    const note = directoryProofNote(parseDirectoryProof(proof)!, 217_773);
    assert.match(note, /40\.0 MB, a1b2c3d4e5f6\./);
  });

  test("a table that does not hold what was written says the number rather than 'exactly that'", () => {
    const note = directoryProofNote(parseDirectoryProof(proof)!, 217_000);
    assert.match(note, /The table holds 217,000\./);
  });
});
