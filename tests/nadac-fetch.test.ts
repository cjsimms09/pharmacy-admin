import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fetchDue, weekOfUrl, weeklyFileUrls, weeklySourcesNeeded } from "../src/lib/nadac-fetch";

/**
 * CMS publishes weekly, on a Wednesday, and a check now costs nothing: each weekly file carries
 * the Wednesday in its own address, so a week already held is never asked for again and the
 * ordinary daily check downloads nothing at all. Only the week just published is fetched, once.
 */
describe("fetchDue", () => {
  const now = Date.parse("2026-09-10T12:00:00Z");
  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();

  test("never fetched means fetch", () => {
    assert.equal(fetchDue(null, now), true);
    assert.equal(fetchDue("", now), true);
  });

  test("an unreadable timestamp is treated as never, not as recent", () => {
    // Failing closed here would silently stop the collection forever.
    assert.equal(fetchDue("not a date", now), true);
  });

  test("checked within the day is not due again", () => {
    assert.equal(fetchDue(ago(0.5), now), false);
    assert.equal(fetchDue(ago(1), now), true, "a day later, look again");
  });

  test("due again the next day, and every day after", () => {
    assert.equal(fetchDue(ago(4), now), true);
    assert.equal(fetchDue(ago(8), now), true);
  });

  test("checked a moment ago is not due", () => {
    assert.equal(fetchDue(new Date(now - 60_000).toISOString(), now), false);
  });
});

/**
 * What makes a daily check free: the week a file is for is written in its own address, so a week
 * already in the database is never downloaded again. This is the whole of "pick up what is new".
 */
describe("asking only for the weeks we do not hold", () => {
  const wednesday = new Date(Date.UTC(2026, 8, 9)); // 9 September 2026, a Wednesday

  test("the week a weekly address is for is read off the address", () => {
    assert.equal(
      weekOfUrl("https://download.medicaid.gov/data/nadac-national-average-drug-acquisition-cost-09-02-2026.csv"),
      "2026-09-02",
    );
    assert.equal(weekOfUrl("https://data.medicaid.gov/api/1/datastore/query/abc/0/download?format=csv"), null);
  });

  test("the most recent Wednesday comes first, then the weeks before it", () => {
    const urls = weeklyFileUrls(wednesday, 3);
    assert.deepEqual(urls.map(weekOfUrl), ["2026-09-09", "2026-09-02", "2026-08-26"]);
  });

  test("a week already held is not asked for; the rest still are", () => {
    const offered = weeklyFileUrls().map((u) => weekOfUrl(u)!);
    const held = new Set(offered.slice(1)); // every week but the most recent
    const needed = weeklySourcesNeeded(held).map((u) => weekOfUrl(u));
    assert.deepEqual(needed, [offered[0]], "only the week we do not hold");
  });

  test("holding every week this knows about leaves nothing to ask for", () => {
    const held = new Set(weeklyFileUrls().map((u) => weekOfUrl(u)!));
    assert.deepEqual(weeklySourcesNeeded(held), []);
  });

  test("the pharmacy's own address is never filtered out — its contents cannot be guessed from its name", () => {
    const held = new Set(weeklyFileUrls().map((u) => weekOfUrl(u)!));
    assert.deepEqual(weeklySourcesNeeded(held, "https://example.org/ours.csv"), ["https://example.org/ours.csv"]);
  });
});

