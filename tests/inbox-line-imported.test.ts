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

  test("a totals sheet and a No Data report are not read on purpose, so false is their normal state", () => {
    assert.notEqual(storyOf(row({ imported: false, routedAs: "report_summary", routeResult: "A totals sheet. The detail it summarises is read separately." })).outcome, "held");
    assert.notEqual(storyOf(row({ imported: false, routedAs: "empty_report", routeResult: "The daily claims report arrived carrying \"No Data\" and nothing else." })).outcome, "held");
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
