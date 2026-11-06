import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * Files copied into OneDrive\ProviderPay are read by the site on its half-hourly beat, with no key and no button.
 * Until 6 November 2026 the sweep only ran inside the MTF job, which stops when no MTF key is stored.
 */
describe("the watched folders are read without anybody pressing anything", () => {
  const src = readFileSync("src/instrumentation.ts", "utf8");

  test("the sweep is its own job on the beat, not a part of the MTF pull", () => {
    assert.match(src, /whenIdle\("folder-watch", folderWatchTick\)/);
    const tick = src.slice(src.indexOf("const folderWatchTick"), src.indexOf("const runAll"));
    assert.match(tick, /sweepRemittances\(\{ name: "Folder watch" \}\)/);
    assert.doesNotMatch(tick, /mtf_api_key|readSecret|downloadMtf/, "it must not depend on the MTF key");
  });

  test("it reads the disk only: no network, no model", () => {
    const tick = src.slice(src.indexOf("const folderWatchTick"), src.indexOf("const runAll"));
    assert.doesNotMatch(tick, /fetch\(|anthropic|asked\(|callModel/i);
  });

  test("it stays quiet when the folders hold nothing, and says what it did when they did", () => {
    const tick = src.slice(src.indexOf("const folderWatchTick"), src.indexOf("const runAll"));
    assert.match(tick, /if \(waiting === 0\) return;/);
    assert.match(tick, /setSetting\(\s*"folder_watch_result"/);
  });
});
