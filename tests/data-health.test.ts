import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  percentOf,
  percentTextOf,
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
