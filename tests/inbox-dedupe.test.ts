import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { inboxRowsToRemove, type InboxRow } from "../src/lib/inbox-dedupe";

const row = (id: string, messageId: string, documentId: string | null, sweptAt: string | null): InboxRow => ({
  id,
  messageId,
  documentId,
  sweptAt,
});

describe("inboxRowsToRemove", () => {
  test("one row per arrival is left alone", () => {
    const r = inboxRowsToRemove([row("a", "m1#f.pdf", "d1", "2026-09-17T04:00:00Z")], new Set(["d1"]));
    assert.deepEqual(r.remove, []);
    assert.equal(r.arrivals, 1);
  });

  test("twenty-eight copies of one arrival come down to one", () => {
    const rows = Array.from({ length: 28 }, (_, i) => row(`r${i}`, "m1#f.pdf", "d1", `2026-09-17T0${i % 4}:00:00Z`));
    const r = inboxRowsToRemove(rows, new Set(["d1"]));
    assert.equal(r.remove.length, 27);
    assert.equal(r.arrivals, 1);
  });

  test("different attachments of one message are different arrivals", () => {
    const r = inboxRowsToRemove(
      [row("a", "m1#one.pdf", "d1", "2026-09-17T04:00:00Z"), row("b", "m1#two.pdf", "d2", "2026-09-17T04:00:00Z")],
      new Set(["d1", "d2"]),
    );
    assert.deepEqual(r.remove, []);
    assert.equal(r.arrivals, 2);
  });

  test("the row whose document still exists is the one kept, even when a later sweep made it", () => {
    const r = inboxRowsToRemove(
      [
        row("early", "m1#f.pdf", "gone", "2026-09-17T01:00:00Z"),
        row("late", "m1#f.pdf", "d1", "2026-09-17T03:00:00Z"),
      ],
      new Set(["d1"]),
    );
    assert.deepEqual(r.remove, ["early"]);
    assert.equal(r.keptWithNoDocument, 0);
  });

  test("a row with no document at all loses to one that has a live document", () => {
    const r = inboxRowsToRemove(
      [row("none", "m1#f.pdf", null, "2026-09-17T01:00:00Z"), row("has", "m1#f.pdf", "d1", "2026-09-17T02:00:00Z")],
      new Set(["d1"]),
    );
    assert.deepEqual(r.remove, ["none"]);
  });

  test("among rows that all have a live document, the earliest sweep wins", () => {
    const r = inboxRowsToRemove(
      [
        row("third", "m1#f.pdf", "d3", "2026-09-17T03:00:00Z"),
        row("first", "m1#f.pdf", "d1", "2026-09-17T01:00:00Z"),
        row("second", "m1#f.pdf", "d2", "2026-09-17T02:00:00Z"),
      ],
      new Set(["d1", "d2", "d3"]),
    );
    assert.deepEqual(r.remove.sort(), ["second", "third"]);
  });

  test("a sweep time that was never recorded knows least, so it sorts last", () => {
    const r = inboxRowsToRemove(
      [row("nulltime", "m1#f.pdf", "d1", null), row("timed", "m1#f.pdf", "d2", "2026-09-17T05:00:00Z")],
      new Set(["d1", "d2"]),
    );
    assert.deepEqual(r.remove, ["nulltime"]);
  });

  test("the same input always gives the same answer", () => {
    const rows = [
      row("b", "m1#f.pdf", "d1", "2026-09-17T01:00:00Z"),
      row("a", "m1#f.pdf", "d2", "2026-09-17T01:00:00Z"),
    ];
    assert.deepEqual(inboxRowsToRemove(rows, new Set(["d1", "d2"])).remove, ["b"]);
    assert.deepEqual(inboxRowsToRemove([...rows].reverse(), new Set(["d1", "d2"])).remove, ["b"]);
  });
});

describe("what it says about what it could not fix", () => {
  test("an arrival whose every copy lost its document is kept and counted, not quietly dropped", () => {
    const r = inboxRowsToRemove(
      [row("a", "m1#f.pdf", "gone1", "2026-09-17T01:00:00Z"), row("b", "m1#f.pdf", "gone2", "2026-09-17T02:00:00Z")],
      new Set(),
    );
    assert.equal(r.remove.length, 1);
    assert.equal(r.keptWithNoDocument, 1);
  });

  test("a lone row with no document is counted too", () => {
    const r = inboxRowsToRemove([row("a", "m1#f.pdf", null, null)], new Set());
    assert.deepEqual(r.remove, []);
    assert.equal(r.keptWithNoDocument, 1);
  });
});
