import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseClaimsProof,
  claimsProofFraction,
  claimsProofGaps,
  claimsProofNote,
  claimsProofAlert,
  cancelledRows,
  coversThrough,
} from "../src/lib/data-health-claims-proof";

/*
 * The proof that the claims still agree with the reports they came from.
 *
 * The owner: "these things need to be right!! we need to make sure claims are matching their info
 * properly and continue to … this is the most important thing." Every other Data health row asks
 * whether the site's tables agree with each other, which they can do perfectly while every one of
 * them disagrees with the file behind it.
 *
 * This module reads JSON another process writes, which is the kind of boundary where a shape drifts
 * without anybody noticing. So the tests are mostly about the ways it can be wrong quietly: a
 * missing field read as a zero, a stray on the side the denominator cannot see, and a proof that
 * stopped running reading as a proof that found nothing.
 */
const first = JSON.stringify({
  provedOn: "2026-09-08",
  files: [
    { file: "rx-2026-09-05.txt", period: { from: "2026-09-05", to: "2026-09-05" }, rowsRead: 600, paid: 529, reversed: 71, matched: 443, cancelledLater: 86, differs: 0, missing: 0, reportSalesCents: 500_000, readRemitCents: 400_000, readSalesCents: 500_000, skipped: 0, problems: [] },
    { file: "rx-2026-09-06.txt", period: { from: "2026-09-06", to: "2026-09-06" }, rowsRead: 700, paid: 587, reversed: 113, matched: 501, cancelledLater: 86, differs: 0, missing: 0, reportSalesCents: 600_000, readRemitCents: 480_000, readSalesCents: 600_000, skipped: 0, problems: [] },
    { file: "rx-2026-09-07.txt", period: { from: "2026-09-07", to: "2026-09-07" }, rowsRead: 500, paid: 500, reversed: 0, matched: 414, cancelledLater: 86, differs: 0, missing: 0, reportSalesCents: 400_000, readRemitCents: 320_000, readSalesCents: 400_000, skipped: 0, problems: [] },
    { file: "rx-2026-09-08.txt", period: { from: "2026-09-08", to: "2026-09-08" }, rowsRead: 500, paid: 500, reversed: 0, matched: 414, cancelledLater: 86, differs: 0, missing: 0, reportSalesCents: 400_000, readRemitCents: 320_000, readSalesCents: 400_000, skipped: 0, problems: [] },
  ],
  paidRowsInFiles: 2_116,
  matched: 1_772,
  disagreements: 0,
  tableRowsNoFileAccountsFor: 0,
  byDay: {},
  lines: [],
});

describe("reading what the nightly proof left behind", () => {
  test("the first real proof reads as complete, and the arithmetic is the script's own", () => {
    const p = parseClaimsProof(first)!;
    assert.ok(p);
    assert.equal(p.paidRowsInFiles, 2_116);
    assert.equal(cancelledRows(p), 344);
    const f = claimsProofFraction(p);
    assert.deepEqual(f, { numerator: 2_116, denominator: 2_116 }, "1,772 matched plus 344 cancelled is every paid row in the files");
    assert.deepEqual(claimsProofGaps(p), []);
  });

  test("never run is null, not a proof that found nothing", () => {
    // The two need different actions from different people, so they must never read alike.
    assert.equal(parseClaimsProof(undefined), null);
    assert.equal(parseClaimsProof(""), null);
    assert.equal(parseClaimsProof("not json"), null);
    assert.equal(parseClaimsProof("[]"), null, "an array is not a proof");
    assert.equal(parseClaimsProof("null"), null);
  });

  test("a field the script stops writing reads as absent, and never as a zero that flatters", () => {
    const p = parseClaimsProof(JSON.stringify({ provedOn: "2026-09-08", files: [{ file: "a.txt" }] }))!;
    assert.equal(p.files[0].rowsRead, 0);
    assert.equal(p.files[0].reportSalesCents, null, "a missing money total is unknown, not zero");
    assert.deepEqual(p.files[0].problems, []);
    assert.equal(p.files[0].period, null);
  });

  test("the proof's own date is kept, because the age of the proof is what the row is for", () => {
    assert.equal(parseClaimsProof(first)!.provedOn, "2026-09-08");
  });

  test("how far the evidence reaches is a different date from when it was proved", () => {
    const p = parseClaimsProof(first)!;
    assert.equal(coversThrough(p), "2026-09-08");
    // A proof run faithfully every night over files that stopped arriving is the case this catches.
    const stale = parseClaimsProof(first.replace(/"provedOn":"2026-09-08"/, '"provedOn":"2026-09-30"'))!;
    assert.equal(stale.provedOn, "2026-09-30");
    assert.equal(coversThrough(stale), "2026-09-08");
    assert.match(claimsProofNote(stale), /Proved on 2026-09-30, covering through 2026-09-08\./);
  });
});

describe("the denominator counts both directions", () => {
  test("a claim row no report accounts for costs the percentage, rather than being invisible", () => {
    /*
     * The whole reason the denominator is not simply "paid rows in the files". A stray row in the
     * claims table cannot appear in that denominator at all, so four hundred of them and none of
     * them read identically at a hundred per cent — the reassuring row, which is worse than none.
     */
    const p = parseClaimsProof(first.replace(/"tableRowsNoFileAccountsFor":0/, '"tableRowsNoFileAccountsFor":400'))!;
    const f = claimsProofFraction(p);
    assert.equal(f.denominator, 2_516);
    assert.equal(f.numerator, 2_116);
    assert.ok(f.numerator < f.denominator, "a stray on either side must stop this reading complete");
    assert.match(claimsProofGaps(p).join(" "), /400 claim rows in the table are accounted for by no report on file/);
  });

  test("the numerator never exceeds the denominator, whatever the script reports", () => {
    // A shape drift that inflated `matched` would otherwise print 103%, which reads as a fault in
    // the page rather than in the proof.
    const p = parseClaimsProof(first.replace(/"matched":1772/, '"matched":9999'))!;
    const f = claimsProofFraction(p);
    assert.ok(f.numerator <= f.denominator);
  });

  test("rows that differ and rows that are missing are named, and are not in the numerator", () => {
    const p = parseClaimsProof(
      first.replace(/"disagreements":0/, '"disagreements":12').replace(/"missing":0,"reportSalesCents":500000/, '"missing":3,"reportSalesCents":500000'),
    )!;
    const gaps = claimsProofGaps(p).join(" ");
    assert.match(gaps, /12 rows in the daily reports disagree with the claim stored from them/);
    assert.match(gaps, /3 paid rows in the reports reached no claim in the table at all/);
  });

  test("the script's own sentences are used verbatim, because only it read the files", () => {
    const p = parseClaimsProof(first.replace(/"lines":\[\]/, '"lines":["Rx 410088 on 2026-09-05: report says $174.31, claim says $174.13"]'))!;
    assert.ok(claimsProofGaps(p).some((g) => /Rx 410088 on 2026-09-05/.test(g)));
  });
});

describe("what reaches the screen read from the doorway", () => {
  test("a clean proof says nothing there, because a row that always appears is scrolled past", () => {
    assert.equal(claimsProofAlert(parseClaimsProof(first)), null);
  });

  test("a proof that has never run is a Data health gap, not an alarm about today's money", () => {
    assert.equal(claimsProofAlert(null), null);
  });

  test("claims disagreeing with their reports is on Today, and says why it outranks the scoreboard", () => {
    const p = parseClaimsProof(first.replace(/"disagreements":0/, '"disagreements":12'))!;
    const a = claimsProofAlert(p)!;
    assert.ok(a);
    assert.match(a.title, /12 claims disagree with the reports they were read from/);
    assert.match(a.why, /Every figure on this site starts at the claims/);
  });

  test("a report that could not be proved at all is on Today too, silence being the failure it cannot survive", () => {
    const p = parseClaimsProof(first.replace(/"problems":\[\]/, '"problems":["the stored file could not be read"]'))!;
    const a = claimsProofAlert(p)!;
    assert.ok(a);
    assert.match(a.title, /could not be checked/);
    assert.match(a.why, /rx-2026-09-05\.txt: the stored file could not be read/, "the file is named, or nobody knows which to look at");
  });

  test("one disagreement reads as one, not as 1 claims", () => {
    const p = parseClaimsProof(first.replace(/"disagreements":0/, '"disagreements":1'))!;
    assert.match(claimsProofAlert(p)!.title, /1 claim disagrees with the report/);
  });
});

describe("the note under the figure", () => {
  test("it says what was read and that the reports' own totals agree, so a hundred per cent is readable", () => {
    const note = claimsProofNote(parseClaimsProof(first)!);
    assert.match(note, /4 daily reports re-read/);
    assert.match(note, /1,772 matched and 344 cancelled by a later reversal, which is also proved/);
    assert.match(note, /grand totals of \$19,000\.00 equal what was read from them, to the cent/);
  });

  test("totals that do not agree are stated as a difference rather than left to be derived", () => {
    const p = parseClaimsProof(first.replace(/"readSalesCents":500000/, '"readSalesCents":499000'))!;
    assert.match(claimsProofNote(p), /a difference of \$10\.00/);
  });

  test("a proof that read no file at all says so, rather than saying everything checked out", () => {
    const p = parseClaimsProof(JSON.stringify({ provedOn: "2026-09-08", files: [] }))!;
    assert.match(claimsProofNote(p), /read no report file, so nothing was checked/);
  });
});
