import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evictions, MAX_HELD, type HeldEntry } from "../src/lib/held-evict";

const e = (key: string, readAt: number, over: Partial<HeldEntry> = {}): HeldEntry => ({ key, readAt, pending: false, has: true, ...over });

describe("letting go of held readings", () => {
  test("under the ceiling nothing is dropped", () => {
    assert.deepEqual(evictions([e("a", 1), e("b", 2)], 60), []);
  });

  test("over it, the least recently read goes first", () => {
    const held = [e("monday", 100), e("today", 900), e("tuesday", 200), e("yesterday", 800)];
    assert.deepEqual(evictions(held, 2), ["monday", "tuesday"]);
  });

  test("last read, not last computed — the difference this exists for", () => {
    /*
     * `refreshStale` recomputes on every idle tick, so a reading nobody has opened since Tuesday
     * looks brand new by its computed time. Keyed on that, the cache would keep the untouched one
     * and drop the page somebody opens every morning.
     */
    const stale = e("recomputed-nightly-never-opened", 100);
    const daily = e("opened-every-morning", 900);
    assert.deepEqual(evictions([stale, daily], 1), ["recomputed-nightly-never-opened"]);
  });

  test("a reading being computed right now is never dropped", () => {
    // Something is waiting on it: dropping frees nothing and guarantees the work is done twice.
    const held = [e("in-flight", 0, { pending: true, has: false }), e("old", 1), e("new", 2)];
    assert.deepEqual(evictions(held, 1), ["old"]);
  });

  test("an entry with no value yet is not counted against the ceiling", () => {
    const held = [e("no-value", 0, { has: false }), e("a", 1), e("b", 2)];
    assert.deepEqual(evictions(held, 2), []);
  });

  test("the ceiling leaves a normal day's working set alone", () => {
    // About thirty distinct readings plus a handful of parameterised ones. Evicting what people use
    // would trade a memory problem for the speed problem the owner noticed first.
    const day = Array.from({ length: 40 }, (_, i) => e(`reading-${i}`, i));
    assert.deepEqual(evictions(day, MAX_HELD), []);
    assert.equal(MAX_HELD, 60);
  });

  test("a fortnight of dated keys is bounded rather than kept", () => {
    // books:2026-09:2026-09-01 … one a day, each a whole period's object graph, never read again.
    const fortnight = Array.from({ length: 14 }, (_, i) => e(`books:2026-09:2026-09-${String(i + 1).padStart(2, "0")}`, i));
    const working = Array.from({ length: 55 }, (_, i) => e(`reading-${i}`, 1000 + i));
    const dropped = evictions([...fortnight, ...working], MAX_HELD);
    assert.equal(dropped.length, 9);
    assert.equal(dropped.every((k) => k.startsWith("books:")), true, "the dated ones go, the working set stays");
  });

  test("nothing is dropped from an empty cache", () => {
    assert.deepEqual(evictions([], 60), []);
  });
});
