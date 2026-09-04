import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { searchSections } from "../src/lib/manual-store";

/**
 * Finding a section without knowing which chapter it is in.
 *
 * A hundred and fifty sections under fourteen chapters, and the way anybody actually arrives at a
 * manual is with a question — what do we do about a recall, who signs for a delivery, how long do
 * we keep this. Answering that by remembering which chapter it lives in is a memory test, and the
 * paper copy at least had an index.
 */
const row = (id: string, title: string, body: string, level = 2) => ({
  id,
  sourceKey: null,
  source: "pharmacy" as const,
  title,
  level,
  position: Number(id) * 100,
  body,
  reviewedOn: null,
  reviewedBy: null,
  retiredOn: null,
  managedBy: null,
  updatedBy: null,
  auditedOn: null,
  auditFailedOn: null,
  auditError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const rows = [
  row("1", "Pharmacy Policies", "", 1),
  row("2", "Drug Recalls", "A recall notice is acted on the day it arrives. The pharmacist-in-charge quarantines affected stock."),
  row("3", "Receiving Deliveries", "Every delivery is checked against the invoice and signed for by a pharmacist."),
  row("4", "Record Retention", "Records are kept for five years, which is the Kansas period."),
  row("5", "Controlled Substances", "", 1),
  row("6", "Ordering", "Schedule II orders are placed through CSOS. A recall of a controlled substance is reported to the DEA."),
];

describe("searching the manual", () => {
  test("a word in a heading finds that section", () => {
    const hits = searchSections(rows, "recalls");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, "Drug Recalls");
  });

  test("a word in the body finds it too, and says which chapter it is in", () => {
    const hits = searchSections(rows, "quarantines");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].chapterTitle, "Pharmacy Policies");
  });

  test("the heading match comes first when several sections mention the word", () => {
    const hits = searchSections(rows, "recall");
    assert.equal(hits.length, 2);
    assert.equal(hits[0].title, "Drug Recalls");
    assert.equal(hits[0].inTitle, true);
    assert.equal(hits[1].title, "Ordering");
  });

  test("every word has to appear, so two words narrow rather than widen", () => {
    assert.equal(searchSections(rows, "recall dea").length, 1);
    assert.equal(searchSections(rows, "recall dea").at(0)?.title, "Ordering");
  });

  test("a phrase somebody would actually type finds the policy", () => {
    assert.equal(searchSections(rows, "five years").at(0)?.title, "Record Retention");
  });

  test("the snippet shows the matching text rather than the first line", () => {
    const hit = searchSections(rows, "quarantines")[0];
    assert.match(hit.snippet, /quarantines/);
  });

  test("case does not matter", () => {
    assert.equal(searchSections(rows, "CSOS").length, 1);
    assert.equal(searchSections(rows, "csos").length, 1);
  });

  test("an empty search is not a search", () => {
    assert.deepEqual(searchSections(rows, ""), []);
    assert.deepEqual(searchSections(rows, "   "), []);
  });

  test("nothing matching comes back empty rather than everything", () => {
    assert.deepEqual(searchSections(rows, "naloxone"), []);
  });

  test("a retired section is not offered", () => {
    const retired = [...rows, { ...row("7", "Old Policy", "recall something"), retiredOn: "2026-02-01" }];
    assert.ok(!searchSections(retired, "recall").some((h) => h.title === "Old Policy"));
  });

  test("every hit carries the number a person would read out", () => {
    for (const h of searchSections(rows, "a")) assert.match(h.number, /^\d+(\.\d+)*$/);
  });
});
