import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseDrillDown, exclusionsFrom, monthKey, generatedOn, cents, percent, FULL_SCRUB } from "../src/lib/drill-down-read";
import type { PdfItem } from "../src/lib/pdf-text";

/**
 * The report is a dashboard: every cell shares one baseline and the columns are drawn top to
 * bottom, one after another. These fixtures reproduce that shape — including the three things that
 * each produced a confidently wrong answer on the real file.
 */
const HEADER = "Generated on September 6, 2026 at 8:41 AM EDT\nGCR Denominator Exclusions is Flu or Dropship or Specialty or GLP1 OS/Rx % Denominator Exclusions is Flu";

let seq = 0;
const at = (x: number, text: string): PdfItem => ({ page: 1, x, y: 15, text: `${text}` });
void seq;

/*
 * Two closed months and one part month, laid out as the real report lays them out:
 *
 *   pass one   row number, month label, then net / Rx / brand / generic, left to right
 *   pass two   the three ratio columns, in the same row order
 *
 * with the part month's brand and generic drawn last, out of row order, and right-aligned so a
 * shorter figure starts further right.
 */
function table(): PdfItem[] {
  const rows = [
    { n: "1", label: "September-2026", net: "$106,322.62", rx: "$105,966.91", brand: "$96,700.76", generic: "$9,621.86", gcr: "20.32%", osRx: "16.54%", osGx: "79.80%" },
    { n: "2", label: "August-2026", net: "$514,935.28", rx: "$511,890.20", brand: "$465,625.72", generic: "$49,309.56", gcr: "26.02%", osRx: "16.11%", osGx: "60.58%" },
    { n: "3", label: "July-2026", net: "$596,491.52", rx: "$594,284.10", brand: "$550,115.49", generic: "$46,376.03", gcr: "23.41%", osRx: "13.76%", osGx: "58.19%" },
  ];
  const out: PdfItem[] = [];
  // Pass one. The part month's brand and generic are withheld and drawn at the end.
  for (const r of rows) {
    out.push(at(38.25, r.n), at(63, r.label), at(223.828, r.net), at(348.828, r.rx));
    if (r.n !== "1") out.push(at(473.828, r.brand), at(605.578, r.generic));
  }
  // Right-aligned: the shorter figures start further right than the column's other entries.
  out.push(at(479.9, rows[0].brand), at(614.2, rows[0].generic));
  // The totals row, which carries no row number and would otherwise join the last month.
  out.push(at(383, "$1,217,749.42"), at(396, "$1,212,141.21"));
  // Pass two.
  for (const r of rows) out.push(at(72.094, r.gcr), at(192.094, r.osRx), at(312.094, r.osGx));
  // The OTC column, drawn out of row order like brand and generic.
  out.push(at(778.313, "$3,045.08"), at(778.313, "$2,207.42"), at(778.313, "$355.71"));
  return out;
}

describe("what the report says about itself", () => {
  test("the full exclusion list is McKesson's scrub, and may pick a band", () => {
    const r = exclusionsFrom("GCR Denominator Exclusions is Flu or Dropship or Specialty or GLP1 OS/Rx %");
    assert.equal(r.printed, "Flu or Dropship or Specialty or GLP1");
    assert.equal(r.scrubbed, true);
  });

  test("a narrower list is a position, not a settlement", () => {
    /*
     * The distinction the whole thing turns on. A GCR measured on Flu and Dropship alone sits on a
     * wider denominator than McKesson settles on, and on one real month the two read 10.13% and
     * 20.64% — so reading this one as scrubbed would pick a band on a figure half the right size.
     */
    const r = exclusionsFrom("GCR Denominator Exclusions is Flu or Dropship OS/Rx % Denominator");
    assert.equal(r.scrubbed, false);
    assert.equal(r.printed, "Flu or Dropship");
  });

  test("a report that does not say is unknown, which is neither yes nor no", () => {
    assert.equal(exclusionsFrom("Purchase Drill Down\nsome other text").scrubbed, null);
  });

  test("the scrub is the four McKesson applies, in any order", () => {
    const r = exclusionsFrom("GCR Denominator Exclusions is GLP1 or Specialty or Dropship or Flu OS/Rx");
    assert.equal(r.scrubbed, true);
    assert.equal(FULL_SCRUB.length, 4);
  });

  test("the generated date", () => {
    assert.equal(generatedOn("Generated on September 6, 2026 at 8:41 AM EDT"), "2026-09-06");
    assert.equal(generatedOn("no date here"), null);
  });
});

describe("reading the by-month table", () => {
  const r = parseDrillDown(table(), HEADER);

  test("every month, newest first, with its ratios", () => {
    assert.deepEqual(r.months.map((m) => m.month), ["2026-09", "2026-08", "2026-07"]);
    assert.deepEqual(r.months.map((m) => m.gcrPercent), [20.32, 26.02, 23.41]);
    assert.deepEqual(r.months.map((m) => m.osRxPercent), [16.54, 16.11, 13.76]);
    assert.deepEqual(r.months.map((m) => m.osGxPercent), [79.8, 60.58, 58.19]);
  });

  test("the totals row does not become the last month", () => {
    /*
     * It carries no row number, so it falls into the last month's group. Taken as data it handed
     * that month the whole period's figures — numbers that look entirely reasonable in the wrong
     * row, which nothing downstream could have caught.
     */
    const july = r.months[2];
    assert.equal(july.netPurchasesCents, 59_649_152);
    assert.notEqual(july.netPurchasesCents, 121_774_942);
  });

  test("the part month's brand and generic find their own row, though drawn last", () => {
    const sep = r.months[0];
    assert.equal(sep.totalBrandCents, 9_670_076);
    assert.equal(sep.totalGenericCents, 962_186);
    assert.equal(sep.totalBrandCents! + sep.totalGenericCents!, sep.netPurchasesCents);
  });

  test("OTC is what Rx falls short of net, confirmed against the page", () => {
    assert.deepEqual(r.months.map((m) => m.totalOtcCents), [35_571, 304_508, 220_742]);
  });

  test("brand over Rx, which the report prints and this recomputes", () => {
    assert.equal(r.months[0].brandOverRxPercent, 91.26);
    assert.equal(r.months[1].brandOverRxPercent, 90.96);
  });

  test("both identities hold, and nothing is reported as a problem", () => {
    assert.ok(r.checks.every((c) => c.ok), JSON.stringify(r.checks));
    assert.deepEqual(r.problems, []);
  });

  test("the scrub is carried through from the header", () => {
    assert.equal(r.scrubbed, true);
    assert.equal(r.generatedOn, "2026-09-06");
  });
});

describe("when it cannot be read", () => {
  test("a page with no month rows says so rather than returning nothing quietly", () => {
    const r = parseDrillDown([at(38.25, "1"), at(223.828, "$100.00")], HEADER);
    assert.deepEqual(r.months, []);
    assert.match(r.problems[0], /No month rows/);
  });

  test("figures that do not add up are refused, not filed", () => {
    /*
     * The failure worth being loudest about: a shifted layout produces perfectly plausible figures
     * under the wrong headings, and no screen further on could tell.
     */
    const broken = table().map((i) => (i.x === 473.828 ? { ...i, text: "$1.00" } : i));
    const r = parseDrillDown(broken, HEADER);
    assert.ok(!r.checks[0].ok);
    assert.match(r.problems.join(" "), /did not satisfy the report's own arithmetic/);
  });
});

describe("the small readers", () => {
  test("amounts and percentages", () => {
    assert.equal(cents("$1,234.56"), 123_456);
    assert.equal(cents("not money"), null);
    assert.equal(percent("24.43%"), 24.43);
    assert.equal(percent("24.43"), null);
    assert.equal(monthKey("September-2026"), "2026-09");
    assert.equal(monthKey("Smarch-2026"), null);
  });
});
