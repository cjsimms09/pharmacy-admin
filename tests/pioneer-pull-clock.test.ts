import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { section } from "./support/fixtures";
import { readFile } from "node:fs/promises";

/**
 * The eight o'clock PioneerRx pull, and the clock it runs on.
 *
 * The tick decided "is it eight yet" on the local hour and "has it run today" on the UTC date. In
 * Wichita the UTC date turns over at 7pm Central, so every evening the guard saw a new day, started
 * the pull at 7pm, and stamped the next day as done — and the next morning's eight o'clock run was
 * skipped. Found 15 September: every pull result stamped 00:02Z, the markers already reading the
 * 15th, and nothing at 13:00Z.
 *
 * The owner chose eight for a reason: "the night's receiving has been keyed in by eight and the
 * day's order is placed around four, so the shelf the order is planned against is this morning's".
 * It was being planned on the evening before's.
 *
 * Two files have to agree — the tick reads the markers the script writes — so the test is on both.
 */
const src = (p: string) => readFile(p, "utf8");

describe("the pull and the guard that starts it use the pharmacy's own day", () => {
  test("REGRESSION: neither decides 'today' from the UTC date", async () => {
    for (const file of ["src/instrumentation.ts", "scripts/pioneer-pull.ts"]) {
      const text = await src(file);
      /* Either marker missing means this is no longer looking at the block that decides the day, and `section` says so. */
      const block = file.endsWith("instrumentation.ts") ? section(text, "const pioneerTick", "const runAll") : text.slice(0, text.indexOf("const due"));
      assert.doesNotMatch(block, /const today = new Date\(\)\.toISOString\(\)/, `${file} decides today on the UTC date again`);
      assert.match(block, /const today = todayIso\(\)/, `${file} should take today from todayIso(), the local date`);
    }
  });

  test("the guard's hour is local, so the date beside it must be local too", async () => {
    const text = await src("src/instrumentation.ts");
    const block = text.slice(text.indexOf("const pioneerTick"), text.indexOf("const runAll"));
    assert.match(block, /getHours\(\) < 8/, "the eight o'clock test moved — re-check that the date beside it is on the same clock");
  });

  test("todayIso is the local date, which is what makes the two agree", async () => {
    const { todayIso } = await import("../src/lib/dates");
    const d = new Date();
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    assert.equal(todayIso(), local);
  });
});
