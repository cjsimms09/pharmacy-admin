import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The bug this guards against was invisible on screen and ruined every printed document.
 *
 * The app shell used to be a two-column grid with a fixed sidebar. Hiding the sidebar for print
 * removed it as a grid item without removing its track, so every form came out as a ribbon down
 * the left edge of the page. The shell is now a bar across the top and a centred page under it,
 * which cannot fail that way — but the two halves that make a printed document a document still
 * have to stay in place, in two different files: the head and the crumb bar hidden, and the page
 * frame dropping its screen padding and width cap so a form fills the sheet.
 */
describe("printing the app shell", () => {
  const layout = readFileSync(new URL("../src/app/(app)/layout.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  const print = css.slice(css.indexOf("@media print"));

  test("the head of the site is marked so print CSS can find it", () => {
    assert.match(layout, /<header className="site-head no-print"/, "the head lost its site-head class or its no-print");
    assert.match(layout, /<main className="page"/, "the page frame lost its page class");
  });

  test("the head and the crumb bar are hidden when printing", () => {
    assert.match(print, /\.site-head,\s*\.topbar\s*\{[^}]*display:\s*none\s*!important/);
  });

  test("the page loses its screen padding and width cap when printed", () => {
    assert.match(print, /\.page\s*\{[^}]*padding:\s*0\s*!important/);
    assert.match(print, /\.page\s*\{[^}]*max-width:\s*none\s*!important/);
  });

  test("the shell is no longer a grid with a fixed track, which is what made hiding the sidebar unsafe", () => {
    assert.doesNotMatch(layout, /md:grid-cols-\[\d+px_1fr\]/);
  });
});
