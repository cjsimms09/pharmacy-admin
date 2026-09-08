import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  percentOf,
  percentTextOf,
  fractionTextOf,
  countTextOf,
  daysSince,
  healthOf,
  buildHealth,
  summarise,
  SPECS,
  type Measurement,
} from "../src/lib/data-health";

/**
 * The page exists because an absent figure looks exactly like a good one.
 *
 * So the arithmetic here has one job beyond being right: it must never round a gap out of
 * existence, and it must never let "nobody counted" and "we counted, it was nothing" print the
 * same. Both mistakes would reproduce, on the page built to detect silence, the silence it was
 * built to detect.
 */

describe("a percentage that cannot lie about being finished", () => {
  test("100% is printed only when nothing at all is missing", () => {
    // The case that motivates the rule: one row short of 26,246 is 99.996%, which rounds to
    // 100.0% at any sane precision. Printing it would tell the owner the catalogue is complete
    // on the very page whose job is to say what is missing.
    assert.equal(percentTextOf(26_245, 26_246), "99.9%");
    assert.equal(percentTextOf(26_246, 26_246), "100%");
  });

  test("0% is printed only when the numerator really is zero", () => {
    // The same rule the other way up. One matched row out of a million is not "none".
    assert.equal(percentTextOf(1, 1_000_000), "0.1%");
    assert.equal(percentTextOf(0, 1_081), "0%");
  });

  test("nothing to measure is a third answer, not zero", () => {
    // No on-hand count has ever been received. "0%" would read as "nothing on the shelf matches
    // the catalogue", which is a fault; the truth is that the question cannot be asked yet.
    assert.equal(percentTextOf(0, 0), "nothing to measure");
    assert.equal(percentOf(0, 0), null);
    assert.equal(percentOf(5, 0), null);
  });

  test("a numerator above its denominator is a counting fault, not 103%", () => {
    assert.equal(percentTextOf(31, 30), "counting fault");
  });

  test("the raw ratio stays unrounded, so sorting sorts by the real number", () => {
    const a = percentOf(26_245, 26_246)!;
    const b = percentOf(26_244, 26_246)!;
    assert.ok(a > b, "two figures that both print as 99.9% must still order correctly");
  });

  test("the real figures from the database read as they should", () => {
    assert.equal(percentTextOf(652, 681), "95.7%"); // NADAC on dispensed NDCs
    assert.equal(percentTextOf(26_246, 45_791), "57.3%"); // NADAC across the catalogue
    assert.equal(percentTextOf(0, 1_081), "0%"); // claims matching a contract
  });
});

describe("how much trouble a row is in", () => {
  const at = (numerator: number, denominator: number, measuredAt: string | null = "2026-09-08") =>
    healthOf({ numerator, denominator, measuredAt });

  test("a link with a denominator that matched nothing is broken, not merely poor", () => {
    // 0 of 1,081 insured fills match a contract. Everywhere else on the site that is indistinguishable
    // from a quiet month, which is the whole reason this page exists.
    assert.equal(at(0, 1_081), "broken");
  });

  test("never measured is its own state, and is not a measurement of zero", () => {
    assert.equal(at(0, 0, null), "unmeasured");
    assert.equal(at(0, 1_081, null), "unmeasured");
  });

  test("no data to measure is not the same as a link that fails", () => {
    // On-hand: no count has ever been received, so nothing is broken — nothing has been tried.
    assert.equal(at(0, 0), "empty");
  });

  test("the bands", () => {
    assert.equal(at(681, 681), "complete");
    assert.equal(at(652, 681), "good"); // 95.7
    assert.equal(at(600, 681), "fair"); // 88.1
    assert.equal(at(200, 681), "poor"); // 29.4
  });

  test("a count above its denominator is broken rather than complete", () => {
    assert.equal(at(31, 30), "broken");
  });
});

describe("age and staleness", () => {
  test("days are counted between calendar dates, not by clock time", () => {
    assert.equal(daysSince("2026-09-01", "2026-09-08"), 7);
    assert.equal(daysSince("2026-09-08", "2026-09-08"), 0);
  });

  test("a measurement nobody has taken has no age", () => {
    assert.equal(daysSince(null, "2026-09-08"), null);
  });

  test("an unreadable date is not silently treated as today", () => {
    assert.equal(daysSince("not a date", "2026-09-08"), null);
  });
});

describe("building the page's rows", () => {
  const measured = (over: Partial<Measurement> & { key: string }): Measurement => ({
    numerator: 0,
    denominator: 0,
    measuredAt: "2026-09-08",
    ...over,
  });

  test("every link the owner named has a row, measured or not", () => {
    const rows = buildHealth([], "2026-09-08");
    assert.equal(rows.length, SPECS.length);
    // A link nobody has counted is exactly as invisible as one that fails, so it must still appear.
    assert.ok(rows.every((r) => r.health === "unmeasured"));
    assert.ok(rows.every((r) => r.percentText === "not measured"));
    assert.equal(rows.find((r) => r.key === "claim-contract")?.percent, null);
  });

  test("the worst rows come first, because the page is read to decide what to do next", () => {
    const rows = buildHealth(
      [
        measured({ key: "claim-fda", numerator: 660, denominator: 681 }),
        measured({ key: "claim-contract", numerator: 0, denominator: 1_081 }),
        measured({ key: "fda-directory", numerator: 217_773, denominator: 217_773 }),
      ],
      "2026-09-08",
    );
    assert.equal(rows[0].key, "claim-contract", "a link matching nothing must lead");
    assert.equal(rows[rows.length - 1].health, "complete");
  });

  test("a measured zero carries its reason, because the number alone would send somebody the wrong way", () => {
    const rows = buildHealth(
      [
        measured({
          key: "claim-contract",
          numerator: 0,
          denominator: 1_081,
          note: "The matcher reads BIN, PCN and group; the contracts on file name networks and chain codes.",
          gaps: ["353 of 357 contract documents have never been read"],
        }),
      ],
      "2026-09-08",
    );
    const row = rows.find((r) => r.key === "claim-contract")!;
    assert.equal(row.health, "broken");
    assert.equal(row.percentText, "0%");
    assert.equal(row.missing, 1_081);
    assert.match(row.note!, /BIN, PCN and group/);
    assert.equal(row.gaps.length, 1);
  });

  test("what is missing is a count, not a percentage, and is absent where it cannot be known", () => {
    const rows = buildHealth(
      [
        measured({ key: "claim-nadac", numerator: 652, denominator: 681 }),
        measured({ key: "on-hand", numerator: 0, denominator: 0 }),
        measured({ key: "claim-fda", numerator: 0, denominator: 0, measuredAt: null }),
      ],
      "2026-09-08",
    );
    assert.equal(rows.find((r) => r.key === "claim-nadac")!.missing, 29);
    assert.equal(rows.find((r) => r.key === "on-hand")!.missing, null, "nothing to measure means nothing is missing");
    assert.equal(rows.find((r) => r.key === "claim-fda")!.missing, null, "unmeasured means unknown, not zero");
  });

  test("a measurement for a key nobody defined is ignored rather than shown as a mystery row", () => {
    const rows = buildHealth([measured({ key: "invented", numerator: 5, denominator: 5 })], "2026-09-08");
    assert.equal(rows.length, SPECS.length);
    assert.ok(!rows.some((r) => r.key === "invented"));
  });

  test("a count that has not been re-run for a week says so", () => {
    const rows = buildHealth([measured({ key: "claims", numerator: 10, denominator: 10, measuredAt: "2026-09-01" })], "2026-09-10");
    const row = rows.find((r) => r.key === "claims")!;
    assert.equal(row.ageDays, 9);
    assert.equal(row.stale, true);
    // Still complete: stale is about the measurement, not about the data it measured.
    assert.equal(row.health, "complete");
  });
});

describe("the sentence at the top of the page", () => {
  test("nothing measured says exactly that", () => {
    assert.match(summarise(buildHealth([], "2026-09-08")).says, /never measured/);
  });

  test("links matching nothing are named first and counted", () => {
    const rows = buildHealth(
      [
        { key: "claim-contract", numerator: 0, denominator: 1_081, measuredAt: "2026-09-08" },
        { key: "claim-remit-deposit", numerator: 0, denominator: 1_081, measuredAt: "2026-09-08" },
        { key: "on-hand", numerator: 0, denominator: 0, measuredAt: "2026-09-08" },
      ],
      "2026-09-08",
    );
    const s = summarise(rows);
    assert.equal(s.worst, "broken");
    assert.match(s.says, /2 links matching nothing at all/);
    assert.match(s.says, /1 with no data to measure/);
  });

  test("all well is said plainly, and only when it is true", () => {
    const all = SPECS.map((s) => ({ key: s.key, numerator: 7, denominator: 7, measuredAt: "2026-09-08" }));
    const s = summarise(buildHealth(all, "2026-09-08"));
    assert.equal(s.worst, "complete");
    assert.match(s.says, /every one of them holds/);
  });
});

describe("the count beside the percentage", () => {
  test("the fraction is what the owner acts on, so it is never dropped", () => {
    // "29 dispensed NDCs have no NADAC" is a morning's work with a list at the end of it.
    // "95.7%" is a feeling about the data.
    assert.equal(countTextOf(652, 681), "652 of 681 · 95.7%");
    assert.equal(countTextOf(26_245, 26_246), "26,245 of 26,246 · 99.9%");
  });

  test("a measured zero prints its denominator, which is the whole force of it", () => {
    assert.equal(countTextOf(0, 1_081), "0 of 1,081 · 0%");
  });

  test("an empty denominator says so rather than printing 'of 0'", () => {
    assert.equal(fractionTextOf(0, 0), "0 of none");
    assert.equal(countTextOf(0, 0), "0 of none · nothing to measure");
  });

  test("thousands are grouped, because these are numbers somebody reads aloud", () => {
    assert.equal(fractionTextOf(217_773, 217_773), "217,773 of 217,773");
  });

  test("an unmeasured row prints no fraction it cannot support", () => {
    const row = buildHealth([], "2026-09-08").find((r) => r.key === "claim-contract")!;
    assert.equal(row.countText, "not measured");
    assert.equal(row.fractionText, "not measured");
  });
});

/*
 * The two rows that count wholesalers rather than documents.
 *
 * The point of both is a denominator the invoice row cannot have. "Invoices with lines read, out
 * of invoices filed" is blind by construction to a wholesaler that has never sent one: it
 * contributes to neither half of the fraction, so four missing wholesalers read as a perfect
 * score. On 8 September that was the live position — one IPC invoice on file, nothing from ANDA,
 * IPD, ParMed or McKesson, and 1,200 lines on Return soon with no supplier against them.
 *
 * These hold the shape, since the arithmetic itself needs a database. What they hold is that the
 * denominator is wholesalers, and that a wholesaler who has sent nothing is inside it.
 */
describe("what is missing is counted per wholesaler, not per document", () => {
  const spec = (key: string) => SPECS.find((s) => s.key === key);

  test("both rows exist and say they count wholesalers", () => {
    for (const key of ["supplier-invoices", "supplier-returns"]) {
      const s = spec(key);
      assert.ok(s, `${key} has no spec`);
      assert.match(s.of, /out of every active wholesaler/, "the denominator has to be the register, or a silent wholesaler cannot be seen");
      assert.ok(s.why.length > 80, "the row has to say why a gap here matters, not just that there is one");
    }
  });

  test("a wholesaler that has sent nothing is a gap, not an absence", () => {
    // Four of five on the register have sent nothing: the fraction has to say 1 of 5, never 1 of 1.
    const rows = buildHealth([
      { key: "supplier-invoices", numerator: 1, denominator: 5, gaps: ["No invoice has ever been loaded from: ANDA, IPD, ParMed, Mckesson."], measuredAt: "2026-09-08", note: null },
    ], "2026-09-08");
    const r = rows.find((x) => x.key === "supplier-invoices")!;
    assert.equal(r.percentText, "20.0%");
    assert.equal(r.fractionText, "1 of 5");
    assert.equal(r.health, "poor");
    assert.match(r.gaps[0], /ANDA, IPD, ParMed, Mckesson/, "the names are the whole value of the row: they are the list to act on");
  });

  test("a returns policy nobody has typed shows as missing rather than as no returns due", () => {
    const rows = buildHealth([
      { key: "supplier-returns", numerator: 1, denominator: 5, gaps: ["No returns policy on file for: IPD, ParMed, Mckesson, ANDA."], measuredAt: "2026-09-08", note: null },
    ], "2026-09-08");
    const r = rows.find((x) => x.key === "supplier-returns")!;
    assert.equal(r.fractionText, "1 of 5");
    assert.notEqual(r.health, "complete", "silence about a supplier's stock must never read as nothing to send back");
  });

  test("all five on file is the finished state, and reads as finished", () => {
    const rows = buildHealth([
      { key: "supplier-invoices", numerator: 5, denominator: 5, gaps: [], measuredAt: "2026-09-08", note: null },
      { key: "supplier-returns", numerator: 5, denominator: 5, gaps: [], measuredAt: "2026-09-08", note: null },
    ], "2026-09-08");
    for (const key of ["supplier-invoices", "supplier-returns"]) {
      const r = rows.find((x) => x.key === key)!;
      assert.equal(r.percentText, "100%");
      assert.equal(r.health, "complete");
    }
  });
});

/*
 * The proof rows, which ask a different question from every other row on the page.
 *
 * The rest of Data health asks whether the site's tables agree with one another. A proof asks
 * whether they agree with the document they were read from — the owner's "these things need to be
 * right!! … and continue to". The invoice one is the case where the two questions visibly differ:
 * an invoice can be filed, linked to a supplier, carry a rebate ladder and sit on every screen
 * looking complete, while the lines under it add to eighty-three dollars less than its own face.
 */
describe("proving a dataset against the document behind it", () => {
  test("the invoice proof exists and says its denominator is invoices that print a total", () => {
    const s = SPECS.find((x) => x.key === "invoices-proof");
    assert.ok(s);
    assert.match(s.of, /out of invoices carrying a total/);
  });

  test("an invoice whose lines do not add to its face stops the row reading complete", () => {
    const rows = buildHealth(
      [{ key: "invoices-proof", numerator: 6, denominator: 7, gaps: ["IPC invoice 11490216: 14 lines add to less than the printed total, by $128.79."], measuredAt: "2026-09-08", note: null }],
      "2026-09-08",
    );
    const r = rows.find((x) => x.key === "invoices-proof")!;
    assert.equal(r.fractionText, "6 of 7");
    assert.notEqual(r.health, "complete");
    assert.match(r.gaps[0], /by \$128\.79/, "the amount is the row's value: it says how much cost is wrong");
  });

  test("no invoice printing a total is nothing to measure, not a failure", () => {
    const rows = buildHealth([{ key: "invoices-proof", numerator: 0, denominator: 0, gaps: [], measuredAt: "2026-09-08", note: null }], "2026-09-08");
    const r = rows.find((x) => x.key === "invoices-proof")!;
    assert.equal(r.health, "empty", "an unanswerable question is not a failed one");
  });
});
