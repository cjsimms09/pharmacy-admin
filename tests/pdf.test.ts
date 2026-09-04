import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { textPdf, wrapForPdf } from "../src/lib/pdf";
import { linkHealth } from "../src/lib/mail-health";

/**
 * A hand-written PDF that a reader refuses is worse than the text file it replaced, so the
 * structural promises are pinned here: the header, a cross-reference table whose offsets match
 * where the objects actually start, and the trailer that points at it. Get an offset wrong and
 * every reader rejects the whole file.
 */
describe("the PDF writer", () => {
  const pdf = textPdf("Test", [
    { text: "West Wichita Family Pharmacy", bold: true, size: 11 },
    { text: "HIPAA privacy and security", bold: true, size: 15 },
    { text: "Body text with (parentheses), a backslash \\ and a smart quote's apostrophe." },
  ]);
  const s = pdf.toString("latin1");

  test("is a PDF a reader will open", () => {
    assert.ok(s.startsWith("%PDF-1.4"), "missing header");
    assert.ok(s.trimEnd().endsWith("%%EOF"), "missing trailer marker");
    assert.match(s, /\/Type \/Catalog/);
    assert.match(s, /\/Type \/Pages/);
    assert.match(s, /\/Type \/Page\b/);
  });

  test("the cross-reference offsets point at the objects they claim", () => {
    const start = Number(/startxref\s+(\d+)/.exec(s)![1]);
    assert.equal(s.slice(start, start + 4), "xref");
    const rows = s.slice(start).split("\n").filter((l) => /^\d{10} \d{5} n\s*$/.test(l));
    assert.ok(rows.length > 0, "no object rows in the xref");
    rows.forEach((row, i) => {
      const off = Number(row.slice(0, 10));
      assert.match(s.slice(off, off + 12), new RegExp(`^${i + 1} 0 obj`), `object ${i + 1} is not where xref says`);
    });
  });

  test("characters that would break a PDF string are escaped", () => {
    assert.match(s, /\\\(parentheses\\\)/);
    assert.match(s, /\\\\/);
  });

  test("both weights are declared, so bold headings actually render bold", () => {
    assert.match(s, /\/BaseFont \/Helvetica\b/);
    assert.match(s, /\/BaseFont \/Helvetica-Bold/);
  });

  test("text colour is stated rather than inherited", () => {
    assert.match(s, /BT 0 g /);
  });

  test("long documents paginate instead of running off the page", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ text: `line ${i}` }));
    assert.ok((textPdf("Long", many).toString("latin1").match(/\/Type \/Page\b/g) ?? []).length > 5);
  });

  test("wrapping breaks on words and keeps blank lines", () => {
    const lines = wrapForPdf("a ".repeat(200).trim() + "\n\nnext", 10);
    assert.ok(lines.length > 3);
    assert.ok(lines.includes(""), "a blank line was lost");
    assert.ok(!lines.some((l) => l.startsWith(" ")), "a line began with a space");
  });
});

describe("links that get a message junked", () => {
  test("a private address on an odd port over http is called out on every count", () => {
    const h = linkHealth("http://192.168.1.40:3100");
    assert.equal(h.privateOnly, true);
    assert.equal(h.spamShaped, true);
    assert.equal(h.reasons.length, 4);
  });

  test("a real name over https on the default port is fine", () => {
    const h = linkHealth("https://pharmacy.wwfrx.com");
    assert.equal(h.privateOnly, false);
    assert.equal(h.spamShaped, false);
    assert.deepEqual(h.reasons, []);
  });

  test("no address at all is the worst case, not the safest", () => {
    assert.equal(linkHealth("").privateOnly, true);
    assert.equal(linkHealth(null).spamShaped, true);
  });

  test("nonsense is not quietly treated as healthy", () => {
    assert.equal(linkHealth("not a url").spamShaped, true);
  });
});
