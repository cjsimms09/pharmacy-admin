import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { atLocal } from "../src/lib/dates";

/*
 * Stored timestamps are UTC and the pharmacy is not. Printing the stored characters told the reader the truth about
 * Greenwich: on 16 September both sessions read "12:58" off the same setting and disagreed about whether a job had run,
 * when the machine's own clock said 07:58 and the job was not due until eight.
 *
 * These cases are written against the machine's own zone rather than a fixed one, because that is what the pharmacy
 * reads and what every other date in this site is written in (`todayIso`).
 */
const offsetMinutes = (iso: string) => {
  const d = new Date(iso);
  return -d.getTimezoneOffset();
};

describe("a stored timestamp as the pharmacy's clock reads it", () => {
  test("it is shifted from UTC by this machine's own offset, not printed as stored", () => {
    const iso = "2026-09-15T13:40:56.186Z";
    const shown = atLocal(iso);
    const expected = new Date(Date.parse(iso) + offsetMinutes(iso) * 60_000).toISOString().slice(0, 16).replace("T", " ");
    assert.equal(shown, expected);
    if (offsetMinutes(iso) !== 0) assert.notEqual(shown, "2026-09-15 13:40", "the stored characters are what the reader must not be shown");
  });

  test("a stamp with no zone marker is read as UTC, because that is what wrote it", () => {
    assert.equal(atLocal("2026-09-15T13:40:56.186"), atLocal("2026-09-15T13:40:56.186Z"));
  });

  test("an offset that is already written out is honoured", () => {
    assert.equal(atLocal("2026-09-15T13:40:56+00:00"), atLocal("2026-09-15T13:40:56Z"));
  });

  test("nothing, and something that is not a time, say so rather than throwing", () => {
    assert.equal(atLocal(null), "—");
    assert.equal(atLocal(undefined), "—");
    assert.equal(atLocal(""), "—");
    assert.equal(atLocal("not a time at all"), "not a time at al");
  });

  test("the minute is kept and the seconds are dropped, which is what a person reads", () => {
    assert.match(atLocal("2026-09-16T12:58:40.114Z"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
