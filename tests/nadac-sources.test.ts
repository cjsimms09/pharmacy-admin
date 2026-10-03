import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { yearArchiveUrl, archiveYears, weeklyFileUrls, weeklySources } from "../src/lib/nadac-fetch";

/**
 * Which CMS dataset each address actually points at.
 *
 * This file exists because of a bug that had none: the fallback address in the source list
 * carried dfa2ab14-06c2-457a-9e36-5cb6d80f8d93, which is the **2022** dataset. On any day it
 * resolved it would have loaded four-year-old prices and reported success — the worst possible
 * outcome, because everything downstream would have gone on working and been quietly wrong.
 */
describe("the year archives", () => {
  test("a known year produces a datastore address carrying that year's dataset", () => {
    const url = yearArchiveUrl(2026);
    assert.ok(url, "2026 has no archive address");
    assert.match(url!, /^https:\/\/data\.medicaid\.gov\/api\/1\/datastore\/query\//);
    assert.match(url!, /fbb83258-11c7-47f5-8b18-5f8e79f7e704/);
    assert.match(url!, /format=csv/);
  });

  test("an unknown year returns nothing rather than a guessed address", () => {
    // A guessed id would either 404 or, far worse, quietly fetch a different year.
    assert.equal(yearArchiveUrl(2019), null);
    assert.equal(yearArchiveUrl("not-a-year"), null);
  });

  test("no two years share a dataset id", () => {
    const urls = archiveYears().map((y) => yearArchiveUrl(y));
    assert.equal(new Set(urls).size, urls.length, "two years point at the same dataset");
  });

  test("the 2022 dataset is never offered under any year", () => {
    // The exact mix-up that was in the source list.
    for (const y of archiveYears()) {
      assert.ok(!yearArchiveUrl(y)!.includes("dfa2ab14-06c2-457a-9e36-5cb6d80f8d93"), `${y} points at the 2022 dataset`);
    }
    assert.equal(yearArchiveUrl(2022), null);
  });

  test("nothing before the year the Kansas floor took effect is offered", () => {
    // 1 July 2026. No claim before it can have been paid under the floor, and the pharmacy is
    // starting its claim history from scratch, so an older archive is a large download of prices no
    // check will ever ask for.
    for (const y of archiveYears()) assert.ok(Number(y) >= 2026, `${y} is offered`);
  });

  test("years are offered newest first, because that is the one somebody wants", () => {
    const years = archiveYears();
    assert.deepEqual(years, [...years].sort().reverse());
    assert.equal(years[0], "2026");
  });

  test("every offered year actually resolves to an address", () => {
    for (const y of archiveYears()) assert.ok(yearArchiveUrl(y), `${y} is offered but has no address`);
  });
});

describe("the plain weekly files", () => {
  test("the most recent Wednesday first, then the weeks before it", () => {
    // A Saturday: the current file is Wednesday the 2nd.
    const urls = weeklyFileUrls(new Date("2026-09-05T12:00:00Z"), 3);
    assert.deepEqual(urls, [
      "https://download.medicaid.gov/data/nadac-national-average-drug-acquisition-cost-09-02-2026.csv",
      "https://download.medicaid.gov/data/nadac-national-average-drug-acquisition-cost-08-26-2026.csv",
      "https://download.medicaid.gov/data/nadac-national-average-drug-acquisition-cost-08-19-2026.csv",
    ]);
  });

  test("on a Wednesday, that Wednesday is the first tried", () => {
    const [first] = weeklyFileUrls(new Date("2026-09-02T09:00:00Z"), 1);
    assert.match(first, /09-02-2026\.csv$/);
  });

  test("a month and a year boundary are crossed correctly", () => {
    const urls = weeklyFileUrls(new Date("2026-01-03T12:00:00Z"), 2);
    assert.match(urls[0], /12-31-2025\.csv$/);
    assert.match(urls[1], /12-24-2025\.csv$/);
  });

  test("the pharmacy's own address is tried before any of them", () => {
    const s = weeklySources("https://example.test/mine.csv");
    assert.equal(s[0], "https://example.test/mine.csv");
    assert.match(s[1], /nadac-national-average-drug-acquisition-cost-/);
    assert.ok(s.length > 8, "the datastore addresses are still there as a fallback");
  });

  test("with no address of their own, the weekly files come first", () => {
    assert.match(weeklySources("")[0], /nadac-national-average-drug-acquisition-cost-/);
    assert.match(weeklySources(null)[0], /nadac-national-average-drug-acquisition-cost-/);
  });
});
