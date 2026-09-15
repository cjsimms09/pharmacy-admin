import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classify, emptyReportMarker } from "../src/lib/autoroute";

/**
 * A scheduled report that ran and correctly carried nothing.
 *
 * Sunday 13 September 2026: the pharmacy was shut, so the daily claims report arrived as twelve
 * bytes reading "No Data". The header reader took that as a one-column header, matched no known
 * report, and filed it as unrecognised — the same pile as a file whose format has never been seen.
 *
 * That is the third state rendered as a fault, and the cost is not tidiness. The first question of
 * the daily check is whether each feed ran; an empty report on the unrecognised pile is
 * indistinguishable from a feed that stopped, and it lands there every Sunday and every holiday. A
 * real break would be one more line on a pile that always has a line on it.
 */
const buf = (s: string) => Buffer.from(s, "utf8");

describe("the report that ran and had nothing in it", () => {
  test("REGRESSION: the real Sunday file is recognised, not filed as unreadable", () => {
    // Twelve bytes, from notifications@rxlocal.com, 2026-09-13T23:30. sha256 282ebb8f…
    const c = classify("Daily 9_13_2026 12_00_00 AM.txt", buf("﻿No Data\r\n"));
    assert.equal(c.kind, "empty_report");
    assert.match(c.why, /daily claims report/i, "it should name which report, so the line can be dismissed at a glance");
    assert.match(c.why, /not a reader that failed/);
  });

  test("it names the report from the filename where it can, and does not guess where it cannot", () => {
    /*
     * The only rule in this file that reads a name rather than contents, because an empty report has
     * no contents to read. Where the name is not one it knows, the honest answer is the generic one.
     */
    assert.match(classify("Daily 9_13_2026 12_00_00 AM.txt", buf("No Data")).why, /^The daily claims report/);
    assert.match(classify("whatever.txt", buf("No Data")).why, /^A scheduled report/);
  });

  test("it quotes the report's own words rather than paraphrasing them", () => {
    assert.match(classify("x.txt", buf("No Records Found")).why, /"No Records Found"/);
  });

  test("the family of wordings is matched, not the one string that happened to arrive", () => {
    for (const s of [
      "No Data",
      "no data",
      "NO DATA",
      "No Data Found",
      "No Records Found",
      "No record found",
      "No Results",
      "No rows to display",
      "No data available",
      "No data returned",
      "(No Data)",
      "No Data.",
      "  No Data  \r\n",
    ]) {
      assert.equal(classify("x.txt", buf(s)).kind, "empty_report", JSON.stringify(s));
    }
  });
});

describe("what it must never swallow, which is the whole risk of a rule like this", () => {
  test("a file that merely MENTIONS no data is untouched", () => {
    /*
     * Anchored to the whole file. A report with a "No Data" cell in it is a report, and routing it
     * here would throw away its rows silently — the worst failure this rule could have.
     */
    const withRows = "Rx Number,Status,Amount\r\n100001,Paid,12.50\r\n100002,No Data,0.00\r\n";
    assert.notEqual(classify("x.csv", buf(withRows)).kind, "empty_report");
    assert.equal(emptyReportMarker(buf(withRows)), null);
  });

  test("a large file is refused whatever it says, because no real report is this small", () => {
    // The size bound is what stops the rule ever reaching a real report. 512 bytes.
    assert.equal(emptyReportMarker(buf("No Data")), "No Data");
    assert.equal(emptyReportMarker(buf("No Data".padEnd(513, " "))), null);
  });

  test("zero bytes is NOT an empty report, and stays unrecognised", () => {
    /*
     * A file with no content at all is as likely to be a download that failed as a report that ran,
     * and those are different facts. Claiming it here would turn a broken feed into a quiet Sunday.
     */
    assert.equal(emptyReportMarker(Buffer.alloc(0)), null);
    assert.notEqual(classify("Daily 9_13_2026 12_00_00 AM.txt", Buffer.alloc(0)).kind, "empty_report");
  });

  test("a real report still wins, even a very short one", () => {
    // Every positive content rule is checked before this one. A one-row claims export is a claims
    // export, not an empty day.
    const claims = "Rx Number,Date Filled,BIN\r\n100001,2026-09-13,004336\r\n";
    assert.equal(classify("x.csv", buf(claims)).kind, "claims");
  });

  test("a genuinely unreadable file is still unrecognised, which is the point of keeping them apart", () => {
    const c = classify("mystery.csv", buf("Widget Code,Sprocket Count\r\n7,9\r\n"));
    assert.equal(c.kind, "unrecognised");
  });

  test("near misses are not matched", () => {
    for (const s of ["No", "Data", "no data found here", "There is no data", "No Data Available For This Period Because The Store Was Closed"]) {
      assert.equal(emptyReportMarker(buf(s)), null, JSON.stringify(s));
    }
  });
});
