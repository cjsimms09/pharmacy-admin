import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { storyOf, type InboxRow } from "../src/lib/inbox-line";

/*
 * The Inbox judged whether a report worked by matching English, and never read the answer the sweep recorded (`imported`). A refusal in
 * words the list did not have showed as a success, with no control on it. 23 October 2026: the USave rebate breakdown. Every value here
 * is invented.
 */
const row = (o: Partial<InboxRow> = {}): InboxRow => ({
  receivedAt: "2026-10-19T23:34:00Z", fromAddress: "reports@example.test", subject: "Report", fileName: "report.pdf", documentId: "d1",
  status: "stored", reason: null, routedAs: "rebate_report", routeResult: "A sentence the wording list has never seen.", scanned: true, imported: null, ...o,
});

describe("what the sweep recorded decides whether a report was refused", () => {
  test("a refusal in words the list does not have is held, and asks for him", () => {
    const s = storyOf(row({ imported: false, routeResult: "The figures on this report do not agree with the tier table printed on it, so the tiers were not stored." }));
    assert.equal(s.outcome, "held");
    assert.equal(s.tone, "crit");
  });

  test("the same words with the loader's yes are a success", () => {
    assert.equal(storyOf(row({ imported: true, routeResult: "Filed 11 tiers against Mckesson." })).outcome, "loaded");
  });

  test("for a loader whose flag means \"changed something this run\", false is not a refusal", () => {
    /* A statement read a second time posts nothing new, so these say false and were read perfectly. Three correct rows nearly turned red. */
    for (const kind of ["ipd_statement", "accesshealth_payment", "report_summary", "empty_report", "veridikal_report"]) {
      assert.notEqual(storyOf(row({ imported: false, routedAs: kind, routeResult: "Read again: filed; nothing new to post." })).outcome, "held", kind);
    }
  });

  test("for the loaders where the flag means stored, false is a refusal", () => {
    for (const kind of ["rebate_report", "sales_by_payment", "accrual_sales"]) {
      assert.equal(storyOf(row({ imported: false, routedAs: kind })).outcome, "held", kind);
    }
  });

  test("a row recorded before the column existed still falls back to the wording", () => {
    assert.equal(storyOf(row({ imported: null, routeResult: "Held, nothing stored: it does not balance." })).outcome, "held");
    assert.equal(storyOf(row({ imported: null, routeResult: "A sentence the wording list has never seen." })).outcome, "loaded");
  });

  test("a row passed over, or refused at the door, keeps its own state whatever the flag says", () => {
    assert.equal(storyOf(row({ status: "ignored", imported: false })).outcome, "ignored");
    assert.equal(storyOf(row({ status: "rejected", imported: false })).outcome, "rejected");
  });
});
