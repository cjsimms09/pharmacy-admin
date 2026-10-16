import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { whenLocal } from "../src/lib/dates";

/*
 * A stored moment read in the pharmacy's own clock.
 *
 * Every job's time is stored ISO UTC and this pharmacy is six hours behind it. On 16 September both sessions building
 * this site read "the mail sweep ran 12:58" as lunchtime when it was 07:58 at the counter, and one of them reported the
 * morning's PioneerRx pull as missed on the strength of it. The word for the day is the part that stops the mistake.
 */
const at = (local: string) => new Date(local).toISOString();

describe("a stored time, in the day of the person reading it", () => {
  const now = new Date("2026-09-16T09:00:00");

  test("today and yesterday are named, so no arithmetic is needed", () => {
    assert.match(whenLocal(at("2026-09-16T07:58:00"), now), /^today 07:58$/);
    assert.match(whenLocal(at("2026-09-15T08:40:00"), now), /^yesterday 08:40$/);
  });

  test("anything older carries its date", () => {
    assert.match(whenLocal(at("2026-09-11T05:02:00"), now), /^Sep 11 05:02$/);
  });

  test("never is never, and a time that will not parse says so rather than inventing one", () => {
    assert.equal(whenLocal(null, now), "never");
    assert.equal(whenLocal("", now), "never");
    assert.equal(whenLocal("not a time", now), "never");
  });

  test("the clock shown is the reader's, not the stored zone's", () => {
    /*
     * The hour is read back through the same local clock the site runs on, so a UTC string never reaches a screen as
     * though it were the counter's time. Compared with the platform's own formatting rather than with a fixed string,
     * because a test that hard-codes an offset passes in one timezone and fails in every other.
     */
    const iso = "2026-09-16T13:58:00Z";
    const expected = new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    assert.ok(whenLocal(iso, new Date(iso)).endsWith(expected));
  });
});
