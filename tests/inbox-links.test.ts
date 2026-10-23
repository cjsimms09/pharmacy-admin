import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * "Show them anyway" on an Inbox with nothing left to do linked to /inbox?done=1, and the page reads only showDone=yes, so the owner
 * pressed it and nothing happened ("it wont show me all inbox items that have been sorted"). A link to a page's own options has to
 * use an option the page reads; this reads the page's source for both.
 */
const src = readFileSync(new URL("../src/app/(app)/inbox/page.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("every query option the Inbox page links to is one it reads", () => {
  const read = /searchParams: Promise<\{([^}]*)\}>/.exec(src)?.[1] ?? "";
  const known = new Set([...read.matchAll(/(\w+)\?:/g)].map((m) => m[1]));
  const linked = [...src.matchAll(/href="\/inbox\?(\w+)=/g)].map((m) => m[1]);
  assert.ok(linked.length >= 2, "the page links to its own options");
  for (const k of linked) assert.ok(known.has(k), `/inbox?${k}= is linked but the page does not read ${k}`);
});

test("asking to see the handled arrivals loads more than the latest 200", () => {
  assert.match(src, /limit\(showDoneParam === "yes" \? \d{4,} : 200\)/);
});
