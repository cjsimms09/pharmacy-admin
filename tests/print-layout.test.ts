import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The bug this guards against was invisible on screen and ruined every printed document.
 *
 * The app shell is a two-column grid: a fixed 228px sidebar, then the page. The sidebar carries
 * `no-print`, which is `display: none` — and that removes it as a grid *item* without removing its
 * *track*. So when printing, <main> slid up into the 228px column and every form came out as a
 * ribbon an inch and a half wide down the left edge: the C-250, the C-900, the temperature logs,
 * the power of attorney, the whole policy manual. On screen it always looked right, because on
 * screen the sidebar is there holding the grid open.
 *
 * Two halves have to stay in place, in two different files, and losing either brings it back. A
 * screenshot test would catch it too but nobody runs one before changing a class name.
 */
describe("printing the app shell", () => {
  const layout = readFileSync(new URL("../src/app/(app)/layout.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

  test("the shell is marked so print CSS can find it", () => {
    assert.match(layout, /className="app-shell/, "the wrapper lost its app-shell class");
  });

  test("the sidebar is still hidden when printing", () => {
    assert.match(layout, /<aside className="no-print/);
  });

  test("the grid is collapsed for print, not merely emptied", () => {
    const print = css.slice(css.indexOf("@media print"));
    assert.match(print, /\.app-shell\s*\{[^}]*display:\s*block\s*!important/, "the shell must stop being a grid");
  });

  test("main loses the shell's screen padding when printed", () => {
    const print = css.slice(css.indexOf("@media print"));
    assert.match(print, /\.app-shell\s*>\s*main\s*\{[^}]*padding:\s*0\s*!important/);
  });

  test("the sidebar column is a fixed track, which is why hiding it is not enough", () => {
    // If this stops being a fixed-width grid the rule above can go, but not before.
    assert.match(layout, /md:grid-cols-\[\d+px_1fr\]/);
  });
});
