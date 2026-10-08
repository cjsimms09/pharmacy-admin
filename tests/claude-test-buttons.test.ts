import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The screens say Claude is tested only by two buttons, so this reads who calls the test rather than the sentences.

const ROOT = process.cwd();
const SETTINGS = "src/app/(app)/settings/page.tsx";
const FEEDS_PAGE = "src/app/(app)/settings/feeds/page.tsx";
const FEEDS = "src/lib/feeds.ts";
const OTHER_TEST = ["src/lib/pioneer-sql.ts", "src/app/(app)/tools/pioneer-sql/page.tsx"];
const BUTTONS = "the Test connection and Save and test buttons under Settings → Claude";

const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
const bodyOf = (text: string, fn: string) => (text.split(`async function ${fn}(`)[1] ?? "").split("\n  async function ")[0];

describe("what the screens say about testing Claude", () => {
  test("the connection test is called from the Settings page and from nowhere else", () => {
    const users = walk(path.join(ROOT, "src"))
      .map(rel)
      .filter((f) => f !== "src/lib/ai.ts" && !OTHER_TEST.includes(f) && /\btestConnection\b/.test(read(f)));
    assert.deepEqual(users, [SETTINGS]);
    assert.equal(count(read(SETTINGS), /\btestConnection\(\)/g), 2, "a third call needs the screens' sentences looked at again");
  });

  test("those two calls sit behind the two buttons the screens name", () => {
    const page = read(SETTINGS);
    assert.match(page, /action=\{testKey\}>\s*<button[^>]*>Test connection<\/button>/);
    assert.match((page.split("<form action={setKey}")[1] ?? "").split("</form>")[0], /<button[^>]*>Save and test<\/button>/);
    assert.match(bodyOf(page, "testKey"), /\btestConnection\(\)/);
    assert.match(bodyOf(page, "setKey"), /\btestConnection\(\)/);
  });

  test("the Claude row on the feeds page names both buttons and links to the card that has them", () => {
    const row = read(FEEDS).split('key: "claude"')[1]?.split("feeds.push")[0] ?? "";
    assert.ok(row.includes(BUTTONS), "the row's detail has to name both buttons");
    assert.match(row, /href: "\/settings#claude"/);
    assert.match(read(SETTINGS), /<h2 id="claude"[^>]*>Claude<\/h2>/);
  });

  test("the feeds page names both buttons wherever it says Claude is not asked from there", () => {
    const text = read(FEEDS_PAGE);
    assert.equal(count(text, /only the Test connection and Save and test buttons under Settings → Claude make that call/g), 2);
    assert.doesNotMatch(text, /only the Test connection button/);
    assert.match(text, /the live check is, on the rows that have one\./);
    assert.ok(read(FEEDS).includes(`which only the Test connection and Save and test`), "the header of feeds.ts says the same");
  });
});
