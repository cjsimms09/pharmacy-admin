import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { judgeClose, endOf, type CloseCheck } from "../src/lib/month-close";

const doc = (done: boolean, name = "Bank statement"): CloseCheck => ({ key: name, name, done, says: done ? `${name}: filed.` : `${name} — nothing is reconciled.`, gate: "document" });
const money = (done: boolean, says = "All 118 bank lines are accounted for."): CloseCheck => ({ key: "bank_lines_placed", name: "Every line means something", done, says, gate: "money" });

describe("the last day of a month", () => {
  test("including the ones that are not thirty days", () => {
    assert.equal(endOf("2026-09"), "2026-09-30");
    assert.equal(endOf("2026-02"), "2026-02-28");
    assert.equal(endOf("2028-02"), "2028-02-29");
    assert.equal(endOf("2026-12"), "2026-12-31");
  });
});

describe("when a month may be called closed", () => {
  /*
   * The owner, 16 September 2026: "it should show month closed only once everything is done, money
   * matches and everything lines up". Three conditions, and the gap between the first and the last is
   * the reason this exists.
   */
  test("a month still running is not incomplete, it is running", () => {
    const r = judgeClose({ month: "2026-09", today: "2026-09-16", checks: [doc(false)] });
    assert.equal(r.state, "running");
    assert.match(r.says, /still running/);
    assert.match(r.says, /Nothing here is late/, "said outright, because a document not yet owed reads as a gap otherwise");
  });

  test("the last day of the month is still the month", () => {
    assert.equal(judgeClose({ month: "2026-09", today: "2026-09-30", checks: [doc(false)] }).state, "running");
    assert.equal(judgeClose({ month: "2026-09", today: "2026-10-01", checks: [doc(false)] }).state, "waiting_on_documents");
  });

  test("documents outstanding are named, because the answer is to fetch them", () => {
    const r = judgeClose({ month: "2026-09", today: "2026-10-04", checks: [doc(false, "Bank statement"), doc(false, "System Sales Summary"), doc(true, "Closing count")] });
    assert.equal(r.state, "waiting_on_documents");
    assert.equal(r.documentsOutstanding, 2);
    assert.match(r.says, /Bank statement, System Sales Summary/);
  });

  test("everything on file and the money disagreeing is NOT closed", () => {
    /*
     * The fault this whole type exists to prevent. Every document filed and eleven lines nothing
     * explains is not a closed month, and calling it one is a promise that the books balance.
     */
    const r = judgeClose({
      month: "2026-09",
      today: "2026-10-04",
      checks: [doc(true), money(false, "11 of 118 bank lines are money nothing explains, $4,204.19 between them.")],
    });
    assert.equal(r.state, "money_does_not_tie");
    assert.equal(r.documentsOutstanding, 0);
    assert.match(r.says, /\$4,204\.19/);
  });

  test("closed says which figures tie, not merely that they do", () => {
    const r = judgeClose({ month: "2026-09", today: "2026-10-04", checks: [doc(true), money(true)] });
    assert.equal(r.state, "closed");
    assert.match(r.says, /All 118 bank lines are accounted for/);
  });

  test("a month with no money check at all cannot reach closed by having no checks to fail", () => {
    /*
     * The money gates are only asked once the documents are in, so a month missing its statement has
     * none of them. If an absent check counted as a passing one, that month would close on the
     * strength of the question nobody asked.
     */
    const r = judgeClose({ month: "2026-09", today: "2026-10-04", checks: [doc(false)] });
    assert.equal(r.state, "waiting_on_documents");
  });
});
