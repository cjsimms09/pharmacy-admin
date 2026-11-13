import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pickNadacDatasets,
  datasetDownloadUrl,
  weekDownloadUrl,
  latestAsOfUrl,
  parseLatestAsOf,
  wednesdaysFor,
  discoverNadacDatasets,
} from "../src/lib/nadac-sources";

/**
 * The dataset ids are looked up by title rather than written into the code, because CMS mints a
 * new id for the yearly dataset every January. These pin the lookup on a listing shaped like the
 * real one, and the two download addresses the loader builds from it.
 */
const listing = [
  { identifier: "d5eaf378-dcef-5779-83de-acdd8347d68e", title: "NADAC (National Average Drug Acquisition Cost)", modified: "2026-09-02" },
  { identifier: "fbb83258-11c7-47f5-8b18-5f8e79f7e704", title: "NADAC (National Average Drug Acquisition Cost) 2026", modified: "2026-09-02" },
  { identifier: "99315a95-37ac-4eee-946a-3c523b4c481e", title: "NADAC (National Average Drug Acquisition Cost) 2024", modified: "2024-12-25" },
  { identifier: "aaaaaaaa-0000-0000-0000-000000000001", title: "NADAC Comparison 2026", modified: "2026-09-02" },
  { identifier: "aaaaaaaa-0000-0000-0000-000000000002", title: "Medicaid Enrollment", modified: "2026-01-01" },
  { identifier: "", title: "NADAC (National Average Drug Acquisition Cost) 2023" },
  "not an object",
];

describe("picking the NADAC datasets out of the listing", () => {
  test("the weekly file and each year are found by exact title", () => {
    const d = pickNadacDatasets(listing, "2026-09-05T00:00:00Z");
    assert.equal(d.weekly?.id, "d5eaf378-dcef-5779-83de-acdd8347d68e");
    assert.deepEqual(Object.keys(d.years).sort(), ["2024", "2026"]);
    assert.equal(d.years["2026"].id, "fbb83258-11c7-47f5-8b18-5f8e79f7e704");
    assert.equal(d.readAt, "2026-09-05T00:00:00Z");
  });

  test("comparison files, unrelated datasets, blank ids and junk are left out", () => {
    const d = pickNadacDatasets(listing);
    const ids = [d.weekly?.id, ...Object.values(d.years).map((y) => y.id)];
    assert.ok(!ids.includes("aaaaaaaa-0000-0000-0000-000000000001"));
    assert.ok(!ids.includes("aaaaaaaa-0000-0000-0000-000000000002"));
    assert.equal(d.years["2023"], undefined, "a listing row with no identifier is no use");
  });

  test("a title repeated keeps the more recently modified one", () => {
    const d = pickNadacDatasets([
      { identifier: "old", title: "NADAC (National Average Drug Acquisition Cost) 2026", modified: "2026-01-01" },
      { identifier: "new", title: "NADAC (National Average Drug Acquisition Cost) 2026", modified: "2026-08-01" },
    ]);
    assert.equal(d.years["2026"].id, "new");
  });

  test("a listing that is not a list yields nothing rather than a crash", () => {
    assert.equal(pickNadacDatasets(null).weekly, null);
    assert.deepEqual(pickNadacDatasets({ items: [] }).years, {});
  });
});

describe("the addresses built from an id", () => {
  test("the whole dataset, as CSV", () => {
    assert.equal(datasetDownloadUrl("abc"), "https://data.medicaid.gov/api/1/datastore/query/abc/0/download?format=csv");
  });

  test("one week of a yearly dataset, filtered on as_of_date", () => {
    const u = new URL(weekDownloadUrl("abc", "2026-07-15"));
    assert.equal(u.pathname, "/api/1/datastore/query/abc/0/download");
    assert.equal(u.searchParams.get("conditions[0][property]"), "as_of_date");
    assert.equal(u.searchParams.get("conditions[0][value]"), "2026-07-15");
    assert.equal(u.searchParams.get("conditions[0][operator]"), "=");
    assert.equal(u.searchParams.get("format"), "csv");
  });

  test("the newest as_of_date: one row, sorted descending, nothing else", () => {
    const u = new URL(latestAsOfUrl("abc"));
    assert.equal(u.searchParams.get("limit"), "1");
    assert.equal(u.searchParams.get("sorts[0][property]"), "as_of_date");
    assert.equal(u.searchParams.get("sorts[0][order]"), "desc");
    assert.equal(u.searchParams.get("properties[0]"), "as_of_date");
  });
});

describe("reading the newest as_of_date back", () => {
  test("ISO and US spellings both read; anything else is null", () => {
    assert.equal(parseLatestAsOf({ results: [{ as_of_date: "2026-09-02" }] }), "2026-09-02");
    assert.equal(parseLatestAsOf({ results: [{ as_of_date: "2026-09-02T00:00:00" }] }), "2026-09-02");
    assert.equal(parseLatestAsOf({ results: [{ as_of_date: "9/2/2026" }] }), "2026-09-02");
    assert.equal(parseLatestAsOf({ results: [] }), null);
    assert.equal(parseLatestAsOf({}), null);
    assert.equal(parseLatestAsOf(null), null);
  });
});

describe("which Wednesday a week's file is published on", () => {
  test("the Wednesday on or before the date, and the one after", () => {
    assert.deepEqual(wednesdaysFor("2026-09-07"), { onOrBefore: "2026-09-02", after: "2026-09-09" }); // a Monday
    assert.deepEqual(wednesdaysFor("2026-09-02"), { onOrBefore: "2026-09-02", after: "2026-09-09" }); // the Wednesday itself
    assert.deepEqual(wednesdaysFor("2026-09-01"), { onOrBefore: "2026-08-26", after: "2026-09-02" }); // a Tuesday
  });
});

describe("reading the listing from the site", () => {
  test("parses what comes back, and refuses a non-2xx answer with the status in the message", async () => {
    const okFetch = (async () => new Response(JSON.stringify(listing), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const d = await discoverNadacDatasets(okFetch);
    assert.equal(d.weekly?.id, "d5eaf378-dcef-5779-83de-acdd8347d68e");

    const badFetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(() => discoverNadacDatasets(badFetch), /HTTP 503/);
  });
});
