import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { yearArchiveUrl, archiveYears } from "../src/lib/nadac-fetch";

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

  test("the 2022 dataset is only ever offered as 2022", () => {
    // The exact mix-up that was in the source list.
    const twentyTwo = yearArchiveUrl(2022);
    for (const y of archiveYears()) {
      if (y === "2022") continue;
      assert.notEqual(yearArchiveUrl(y), twentyTwo, `${y} points at the 2022 dataset`);
    }
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
