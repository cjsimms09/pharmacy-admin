import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * "This does not expire" and "nobody entered a date" look identical in a database and mean
 * opposite things. One is a decision and the end of the matter; the other is the omission the
 * compliance screen exists to catch. Collapsing them either nags forever about certificates that
 * never lapse, or goes quiet about licences whose date nobody typed.
 */
describe("the flag is stored, not inferred", () => {
  const schema = fs.readFileSync("src/db/schema.ts", "utf8");

  test("credentials carry it", () => {
    const block = schema.slice(schema.indexOf("export const credentials"), schema.indexOf("export const ceEntries"));
    assert.match(block, /noExpiry: integer\("no_expiry"/);
  });

  test("documents carry it too, since a document can be filed without one", () => {
    const block = schema.slice(schema.indexOf("export const documents"), schema.indexOf("documents_person_idx"));
    assert.match(block, /noExpiry: integer\("no_expiry"/);
  });

  test("it defaults to false — silence must never be mistaken for a decision", () => {
    assert.match(schema, /noExpiry: integer\("no_expiry", \{ mode: "boolean" \}\)\.notNull\(\)\.default\(false\)/);
  });
});

describe("the due list respects it", () => {
  const due = fs.readFileSync("src/lib/due.ts", "utf8");

  test("a credential said not to expire is skipped entirely", () => {
    assert.match(due, /if \(held\.noExpiry\) continue;/);
  });

  test("the check comes before the missing-date warning, not after", () => {
    // The other order would flag it and then skip it, which is no better than not skipping.
    // Anchored on the branch that records a missing date rather than on its wording, so
    // rephrasing the message cannot quietly turn this into a test of nothing.
    assert.ok(due.indexOf("held.noExpiry") < due.indexOf("undated.set("));
  });

  test("the warning tells you both ways out of it", () => {
    assert.match(due, /Add the date, or tick "this does not expire"/);
  });
});

describe("every place a document is filed offers it", () => {
  for (const [what, file] of [
    ["the credential form", "src/app/(app)/staff/[id]/page.tsx"],
    ["the upload form", "src/components/documents.tsx"],
    ["filing from the inbox", "src/app/(app)/inbox/page.tsx"],
  ] as const) {
    test(what, () => {
      assert.match(fs.readFileSync(file, "utf8"), /name="noExpiry"/);
    });
  }
});
