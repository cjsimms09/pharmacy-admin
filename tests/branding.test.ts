import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { revisionOf } from "../src/lib/manual-version";
import type { Section } from "../src/lib/manual-store";

/**
 * Where the pharmacy's own mark may and may not go.
 *
 * The rule is not aesthetic. A C-550 or a C-900 is the Kansas Board's own form, reproduced
 * faithfully so an inspector recognises it; adding a pharmacy logo to one is altering a state
 * document, and handing somebody a page that looks official and is not is a worse problem than a
 * plain page. The flag that already separates the pharmacy's records from the Board's forms is the
 * one that decides this, so it cannot be got wrong one page at a time.
 *
 * That flag lives in the PrintFrame component, which cannot be rendered under the test runner. So
 * what is asserted here is the boundary itself: every screen that prints a Board form declares it,
 * and every screen that prints the pharmacy's own record declares that.
 */
import fs from "node:fs";
import path from "node:path";

const APP = path.join(process.cwd(), "src", "app");

function pagesUsing(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx") && fs.readFileSync(full, "utf8").includes("<PrintFrame")) out.push(full);
    }
  };
  walk(APP);
  return out;
}

describe("the logo boundary", () => {
  test("every printed page states whether it is the pharmacy's document or the Board's", () => {
    const pages = pagesUsing();
    assert.ok(pages.length > 5, `expected several printed forms, found ${pages.length}`);
    for (const file of pages) {
      const src = fs.readFileSync(file, "utf8");
      const frame = src.slice(src.indexOf("<PrintFrame"));
      // ownDocument present means the pharmacy's own record and the logo goes on it; absent means a
      // Board form, reproduced as the Board prints it.
      const declares = /ownDocument/.test(frame) || /formNumber=\{?["'][A-Z]/.test(frame);
      assert.ok(declares, `${path.relative(APP, file)} neither claims to be the pharmacy's nor names a Board form`);
    }
  });

  test("the Board's own forms are never marked as the pharmacy's document", () => {
    // C-550, C-900, C-250: the Board's numbered forms. If one of these ever gained ownDocument it
    // would print with a pharmacy logo on a state form.
    for (const file of pagesUsing()) {
      const src = fs.readFileSync(file, "utf8");
      const boardForm = /formNumber=["']C-\d/.test(src);
      if (!boardForm) continue;
      assert.ok(!/ownDocument/.test(src), `${path.relative(APP, file)} is a Board form and must not carry a logo`);
    }
  });
});

/**
 * The printed manual identifies the version it is.
 *
 * A hundred and forty loose sheets with nothing on them but body text cannot be put back in order,
 * and two printings of a living document cannot be told apart. The revision on the cover, in the
 * running header and in the approval block is what makes a printed copy answerable for itself.
 */
describe("the printed manual's identity", () => {
  const section = (over: Partial<Section>): Section =>
    ({
      id: "s1", sourceKey: null, source: "pharmacy", title: "T", level: 1, position: 1, body: "x",
      reviewedOn: null, reviewedBy: null, retiredOn: null, managedBy: null, updatedBy: null,
      auditedOn: null, auditFailedOn: null, auditError: null,
  auditFailCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...over,
    }) as Section;

  test("the cover, the header and the approval block can all name the same revision", () => {
    const r = revisionOf([section({}), section({ id: "s2", position: 2, title: "U" })]);
    assert.match(r.fingerprint, /^[0-9a-f]{8}$/);
    assert.equal(r.sections, 2);
  });

  test("an edit anywhere changes what the printed copy calls itself", () => {
    const before = revisionOf([section({})]);
    const after = revisionOf([section({ body: "x edited" })]);
    assert.notEqual(before.fingerprint, after.fingerprint);
  });
});
