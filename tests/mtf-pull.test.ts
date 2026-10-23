import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mtfPull, MTF_QUIET_DAYS } from "../src/lib/feed-rules";

/*
 * The facilitator's feed is judged on the last pull that worked, not the last one tried.
 *
 * Found 7 October 2026 reading what the feed's clock was. `mtf_last_pull` was set at the end of every pull, whatever the outcome,
 * and the feed judged "is it arriving" from it. A key that had lapsed, or a tool that had gone, would fail every day and every
 * failure would reset the clock, so the feed read "on time" for ever while the facilitator's payments went unposted. Nothing was
 * failing when this was found; the last pull on file had worked.
 *
 * `mtf_last_pull` still has to move on a failure: the daily job reads it so that it does not try twice in a day. So the feed gets
 * its own clock, `mtf_last_ok`, which only a pull that worked moves, and `mtf_last_failed` so the feed can say the latest one did not.
 *
 * Every date and message here is invented.
 */
let feedsNow: typeof import("../src/lib/feeds").feedsNow;
let recordMtfPull: typeof import("../src/lib/mtf").recordMtfPull;
let getSettings: typeof import("../src/lib/settings").getSettings;
let setSetting: typeof import("../src/lib/settings").setSetting;
let cleanUpDb: (() => void) | null = null;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ({ feedsNow } = await import("../src/lib/feeds"));
  ({ recordMtfPull } = await import("../src/lib/mtf"));
  ({ getSettings, setSetting } = await import("../src/lib/settings"));
  /* Only that a key is stored matters to the feed; it is never decrypted here. */
  await setSetting("mtf_api_key_enc", "not-a-real-key");
});

after(() => cleanUpDb?.());

const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n, 15, 0, 0));
const mtf = async (now: Date) => {
  const f = (await feedsNow({ now })).feeds.find((x) => x.key === "mtf");
  assert.ok(f, "the facilitator feed is listed");
  return f;
};

describe("before any pull has been recorded as working, the newest payment is still the clock", () => {
  test("a facilitator payment 10 days old is on time and one 15 days old is not", async () => {
    const { db } = await import("../src/db");
    const { sql } = await import("drizzle-orm");
    await db.run(
      sql`insert into claim_payments (id, rx_number, source, amount_cents, received_on, recorded_by) values ('test-mtf-pay-1', 'RX-TEST-1', 'mtf', 1000, '2026-10-05', 'test')`,
    );
    assert.equal((await mtf(new Date("2026-10-15T15:00:00Z"))).state, "on_time");
    assert.equal((await mtf(new Date("2026-10-20T15:00:00Z"))).state, "late");
  });
});

describe("a pull that failed does not count as the feed arriving", () => {
  test("a pull that worked is on time, and says what it did", async () => {
    await recordMtfPull({ ok: true, message: "Ran successfully. Nothing new to download for that range. Nothing new to post.", at: day(0) });
    const f = await mtf(day(1));
    assert.equal(f.state, "on_time");
    assert.match(f.detail, /Last pull: Ran successfully\. Nothing new to download for that range\. Nothing new to post\.( |$)/);
    assert.doesNotMatch(f.detail, /\.\./, "no sentence ends in two full stops");
    assert.doesNotMatch(f.detail, /called stopped/, "a pull that worked has nothing to warn of");
  });

  test("a failure is said beside a badge that is still inside its allowance, and the last good pull is named", async () => {
    await recordMtfPull({ ok: false, message: "Could not fetch: The MTF tool did not finish in time. Nothing new to post.", at: day(1) });
    const f = await mtf(day(2));
    assert.equal(f.state, "on_time", "one failed try is not yet a stopped feed: each try looks three weeks back");
    assert.match(f.detail, /Last pull: Could not fetch: The MTF tool did not finish in time\. Nothing new to post\./);
    assert.match(f.detail, /The last pull that worked was 2 days ago; this feed is called stopped after 14 days without one\./);
  });

  test("REGRESSION: pulls that keep failing do not keep the feed on time", async () => {
    /* Tried and failed on day 14, the way a lapsed key would on every day. The old clock read that as a pull on day 14. */
    await recordMtfPull({ ok: false, message: "Could not fetch: unauthorised. Nothing new to post.", at: day(14) });
    assert.equal((await mtf(day(14))).state, "on_time", "14 days after the last good pull is still inside the allowance");
    const f = await mtf(day(15));
    assert.equal(f.state, "late", "15 days with no pull that worked is a stopped feed, however many were tried");
    assert.match(f.detail, /The last pull that worked was 2 weeks ago/);
  });

  test("a failure still moves the time it was tried, which is what keeps the daily job from running twice in a day", async () => {
    const s = await getSettings();
    assert.equal(s.mtf_last_pull, day(14).toISOString());
    assert.equal(s.mtf_last_ok, day(0).toISOString(), "the good-pull time was not moved by a failure");
    assert.equal(s.mtf_last_failed, day(14).toISOString());
  });

  test("a pull that works again puts the feed back on time and the warning goes", async () => {
    await recordMtfPull({ ok: true, message: "Downloaded 1 new file into the download folder. Nothing new to post.", at: day(16) });
    const f = await mtf(day(16));
    assert.equal(f.state, "on_time");
    assert.doesNotMatch(f.detail, /called stopped/);
    assert.match(f.detail, /Last pull: Downloaded 1 new file/);
  });
});

describe("an attempt that is not yet a verdict", () => {
  /* The daily job fetches, then reads what was fetched. Whether the pull worked is known only after the read, and a read that throws
     must not have been recorded as a pull that worked. So the fetch records that it was tried, and the verdict comes once, at the end. */
  test("verdict: false records the attempt and what it said, and leaves both verdict clocks where they were", async () => {
    const before = await getSettings();
    await recordMtfPull({ ok: true, message: "Downloaded 2 new files into the download folder.", at: day(17), verdict: false });
    const fetched = await getSettings();
    assert.equal(fetched.mtf_last_pull, day(17).toISOString(), "the attempt stamp moves: it is what stops the daily job fetching again at once");
    assert.equal(fetched.mtf_last_result, "Downloaded 2 new files into the download folder.");
    assert.equal(fetched.mtf_last_ok, before.mtf_last_ok, "a fetch that has not been read is not yet a pull that worked");
    assert.equal(fetched.mtf_last_failed, before.mtf_last_failed);

    await recordMtfPull({ ok: false, message: "Could not fetch: unauthorised.", at: day(18), verdict: false });
    const failed = await getSettings();
    assert.equal(failed.mtf_last_pull, day(18).toISOString());
    assert.equal(failed.mtf_last_ok, before.mtf_last_ok);
    assert.equal(failed.mtf_last_failed, before.mtf_last_failed, "a failed fetch is recorded as a failed pull by the cycle's own verdict, not by the attempt");
  });

  test("the verdict that follows moves exactly one of the two, as before", async () => {
    await recordMtfPull({ ok: true, message: "Ran successfully. Nothing new to post.", at: day(19) });
    const s = await getSettings();
    assert.equal(s.mtf_last_ok, day(19).toISOString());
    assert.equal(s.mtf_last_failed, day(14).toISOString(), "a pull that worked does not touch the time of the last failure");
  });
});

describe("every record of a pull goes through the one recorder (read from the source; the tool itself is not run here)", () => {
  const source = (p: string) => fs.readFileSync(path.join(__dirname, p), "utf8").replace(/\r\n/g, "\n");
  const between = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to));

  test("the four settings that hold a pull are written in the recorder and nowhere before it in the tool's code", () => {
    const src = source("../src/lib/mtf.ts");
    const at = src.indexOf("export async function recordMtfPull");
    assert.ok(at > 0, "the recorder is where this test looks for it");
    assert.doesNotMatch(src.slice(0, at), /["']mtf_last_(pull|result|ok|failed)["']/, "a pull recorded anywhere else would move a clock without saying which way it went");
    const body = src.slice(at, src.indexOf("\n}\n", at));
    for (const key of ["mtf_last_pull", "mtf_last_result", "mtf_last_ok", "mtf_last_failed"]) {
      assert.ok(body.includes(`"${key}"`), `${key} is written by the recorder`);
    }
  });

  test("downloadMtf hands its own result to the recorder and records its verdict unless told not to", () => {
    const download = between(source("../src/lib/mtf.ts"), "export async function downloadMtf", "async function listFiles");
    assert.match(download, /verdict = true\)/);
    assert.match(download, /recordMtfPull\(\{ ok: r\.ok, message: [^\n]*, verdict \}\)/);
  });

  test("the daily cycle's fetch records the attempt only, and the verdict is recorded once, after the folder has been read", () => {
    const cycle = between(source("../src/lib/mtf.ts"), "export async function mtfCycle", "export async function recordMtfPull");
    assert.match(cycle, /downloadMtf\(iso\(from\), iso\(to\), true, false\)/);
    assert.match(cycle, /recordMtfPull\(\{ ok: pulled\.ok, message \}\)/);
    assert.equal(cycle.match(/recordMtfPull\(/g)?.length, 1, "the cycle records one verdict, and no other before the folder has been read");
    assert.ok(cycle.indexOf("sweepRemittances(user)") < cycle.indexOf("recordMtfPull({ ok: pulled.ok"), "the verdict follows the read");
  });

  test("the feed reads the good-pull clock and not the time of the last try", () => {
    const src = source("../src/lib/feeds.ts");
    assert.doesNotMatch(src, /mtf_last_pull/, "the time of the last try is the daily job's, never the feed's clock");
    assert.match(src, /lastOk: s\.mtf_last_ok/);
    assert.match(src, /newestPaymentOn: lastAt/, "before a pull is recorded as working the newest payment stays the clock");
  });
});

describe("what the pull's sentence says, branch by branch", () => {
  const now = new Date("2026-10-20T15:00:00Z");
  const base = { lastOk: null, lastFailed: null, lastResult: null, newestPaymentOn: null, now };

  test("nothing recorded yet: no failure is claimed, and the feed says it has not been measured", () => {
    const r = mtfPull(base);
    assert.equal(r.failing, false);
    assert.equal(r.says, "Last pull: never. No pull has been recorded as working yet, and no payment has arrived through it.");
    assert.equal(r.clockAt, null);
  });

  test("before any pull is recorded as working, the clock is the newest payment, and the sentence says so", () => {
    const r = mtfPull({ ...base, newestPaymentOn: "2026-10-05", lastResult: "Ran successfully." });
    assert.equal(r.clockAt, "2026-10-05");
    assert.equal(r.failing, false);
    assert.equal(
      r.says,
      `Last pull: Ran successfully. No pull has been recorded as working yet, so this feed is judged on its newest payment, and is called stopped after ${MTF_QUIET_DAYS} days without one.`,
    );
  });

  test("once a pull is recorded as working and none has failed, the sentence is only what the pull did", () => {
    const r = mtfPull({ ...base, lastOk: "2026-10-19T15:00:00.000Z", lastResult: "Ran successfully." });
    assert.equal(r.failing, false);
    assert.equal(r.says, "Last pull: Ran successfully.");
  });

  test("a pull that worked is the clock even when a payment is newer or older", () => {
    assert.equal(mtfPull({ ...base, lastOk: "2026-10-19T15:00:00.000Z", newestPaymentOn: "2026-10-05" }).clockAt, "2026-10-19T15:00:00.000Z");
    assert.equal(mtfPull({ ...base, lastOk: "2026-10-01T15:00:00.000Z", newestPaymentOn: "2026-10-19" }).clockAt, "2026-10-01T15:00:00.000Z");
  });

  test("a failure with no pull ever recorded as working says so and names the clock it uses instead", () => {
    const r = mtfPull({ ...base, lastFailed: "2026-10-19T15:00:00.000Z", lastResult: "Could not fetch: unauthorised", newestPaymentOn: "2026-10-05" });
    assert.equal(r.failing, true);
    assert.equal(
      r.says,
      `Last pull: Could not fetch: unauthorised. No pull has been recorded as working yet, so this feed is judged on its newest payment, and is called stopped after ${MTF_QUIET_DAYS} days without one.`,
    );
  });

  test("a failure with no working pull and no payment at all does not promise a stopped badge", () => {
    const r = mtfPull({ ...base, lastFailed: "2026-10-19T15:00:00.000Z", lastResult: "Could not fetch: unauthorised." });
    assert.equal(r.says, "Last pull: Could not fetch: unauthorised. No pull has been recorded as working yet, and no payment has arrived through it.");
  });

  test("a failure after a good pull names the good pull; a good pull after the failure clears the warning", () => {
    const failed = mtfPull({ ...base, lastOk: "2026-10-18T15:00:00.000Z", lastFailed: "2026-10-19T15:00:00.000Z", lastResult: "Could not fetch: unauthorised." });
    assert.equal(failed.failing, true);
    assert.match(failed.says, /The last pull that worked was 2 days ago; this feed is called stopped after 14 days without one\.$/);
    const mended = mtfPull({ ...base, lastOk: "2026-10-20T10:00:00.000Z", lastFailed: "2026-10-19T15:00:00.000Z", lastResult: "Ran successfully." });
    assert.equal(mended.failing, false);
    assert.equal(mended.says, "Last pull: Ran successfully.");
  });

  test("a message gets one full stop, whether or not it came with one", () => {
    const worked = { ...base, lastOk: "2026-10-19T15:00:00.000Z" };
    assert.equal(mtfPull({ ...worked, lastResult: "Ran successfully" }).says, "Last pull: Ran successfully.");
    assert.equal(mtfPull({ ...worked, lastResult: "Ran successfully." }).says, "Last pull: Ran successfully.");
  });
});

/* What the feed's own row says of the key, in the one place a person reads it. Dates are chosen against `day(17)`, which is 18 October. */
describe("the facilitator feed says what the key has left, that it has run out, and when nobody knows", () => {
  const detailWithKey = async (keySetOn: string) => {
    await setSetting("mtf_key_set_on", keySetOn);
    return (await mtf(day(17))).detail;
  };

  test("a key with six days left says six days", async () => {
    assert.match(await detailWithKey("2026-07-26"), /The API key expires in 6 days\.$/);
  });

  test("REGRESSION: a key that has run out says so, and no sentence reads as a negative deadline", async () => {
    const detail = await detailWithKey("2026-06-01");
    assert.match(detail, /The API key is dated 139 days ago and CMS ends a key 90 days after it is made, so it has run out; a new one has to be made at CMS and stored on the Connections page\.$/);
    assert.doesNotMatch(detail, /expires in/);
  });

  test("a key with more than two weeks left says nothing about its age", async () => {
    const detail = await detailWithKey("2026-10-01");
    assert.doesNotMatch(detail, /API key/);
    assert.doesNotMatch(detail, /not on record/);
  });

  /* Found 7 October 2026: the live site holds a key and no day for it. The test that stood here asserted that this said nothing,
     which was the fault written down as intended. */
  test("REGRESSION: a key is stored and the day it was made is not on record, and the feed says it cannot count, and what settles it", async () => {
    const detail = await detailWithKey("");
    assert.match(detail, /The day this key was made is not on record, so the site cannot say how long it has left\./);
    assert.match(detail, /Enter the day on the Connections page, or make a new key at CMS and store it there, which records the day\.$/);
    assert.doesNotMatch(detail, /expires in|run out/);
  });

  test("a day on record that is not a day, or has not come, is said to be unmeasured and is not counted from", async () => {
    for (const bad of ["not a date", "2026-02-30", "2026-10-19"]) {
      assert.match(await detailWithKey(bad), /The day this key was made is not on record/, `for ${bad}`);
    }
  });

  test("with no key stored there is no age to say, whatever day is left on record", async () => {
    await setSetting("mtf_key_set_on", "2026-07-26");
    await setSetting("mtf_api_key_enc", "");
    try {
      assert.match((await mtf(day(17))).detail, /^No facilitator key is stored, so nothing is pulled\.$/);
    } finally {
      await setSetting("mtf_api_key_enc", "not-a-real-key");
    }
  });
});
