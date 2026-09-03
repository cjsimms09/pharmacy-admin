import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { incidentStage, isThin, reviewCompleteDeadline, reviewStartDeadline } from "../src/lib/cqi-rules";
import { addDays, todayIso } from "../src/lib/dates";

const full = "x".repeat(500);
type Inc = Parameters<typeof incidentStage>[0];
const base: Inc = {
  aiState: "idle",
  rootCauseAnalysis: full,
  correctiveActionPlan: full,
  reportCreatedOn: addDays(todayIso(), -3),
  reviewStartedOn: null,
  reviewCompletedOn: null,
  capImplementedOn: null,
};
const stage = (o: Partial<Inc>, reviews: { reviewNumber: number; effective: boolean | null }[] = []) =>
  incidentStage({ ...base, ...o }, reviews, "2026-12-15");

describe("review deadlines (K.A.R. 68-19-1)", () => {
  test("7 days to start, 30 to complete, from the report date", () => {
    assert.equal(reviewStartDeadline("2026-08-20"), "2026-08-27");
    assert.equal(reviewCompleteDeadline("2026-08-20"), "2026-09-19");
  });
});

describe("isThin", () => {
  test("a missing analysis is thin", () => {
    assert.equal(isThin(null, full), true);
    assert.equal(isThin(full, null), true);
  });
  test("a one-line corrective action is thin even with a full analysis", () => {
    assert.equal(isThin(full, "Implementation of pre-check station."), true);
  });
  test("two full sections are not thin", () => {
    assert.equal(isThin(full, full), false);
  });
  test("whitespace does not count as content", () => {
    assert.equal(isThin(" ".repeat(500), full), true);
  });
});

describe("incidentStage — the order follows the regulation", () => {
  test("a logged incident is not analysed until the pharmacist opens the review", () => {
    const s = stage({ rootCauseAnalysis: null, correctiveActionPlan: null });
    assert.equal(s.key, "logged");
    assert.equal(s.automatic, false);
    assert.equal(s.dueOn, reviewStartDeadline(base.reportCreatedOn));
  });

  test("drafting is reported as automatic so the PIC knows to leave it alone", () => {
    const s = stage({ aiState: "queued" });
    assert.equal(s.key, "drafting");
    assert.equal(s.automatic, true);
  });

  test("a failed draft is critical and needs a person", () => {
    const s = stage({ aiState: "failed" });
    assert.equal(s.key, "draft_failed");
    assert.equal(s.level, "crit");
    assert.equal(s.automatic, false);
  });

  test("review started but analysis still thin", () => {
    const s = stage({ reviewStartedOn: todayIso(), correctiveActionPlan: "one line" });
    assert.equal(s.key, "analysis_missing");
  });

  test("analysis written, review not yet completed", () => {
    const s = stage({ reviewStartedOn: todayIso() });
    assert.equal(s.key, "review_open");
  });

  test("review complete but the corrective action has no start date", () => {
    const s = stage({ reviewStartedOn: todayIso(), reviewCompletedOn: todayIso() });
    assert.equal(s.key, "cap_not_started");
  });

  test("waits for the first effectiveness review once the CAP is in place", () => {
    const s = stage({ reviewStartedOn: todayIso(), reviewCompletedOn: todayIso(), capImplementedOn: todayIso() });
    assert.equal(s.key, "eval_1");
    assert.equal(s.automatic, true);
  });

  test("one review done means the second is still owed", () => {
    const s = stage(
      { reviewStartedOn: todayIso(), reviewCompletedOn: todayIso(), capImplementedOn: todayIso() },
      [{ reviewNumber: 1, effective: true }],
    );
    assert.equal(s.key, "eval_2");
  });

  test("closes only after both effectiveness reviews", () => {
    const s = stage(
      { reviewStartedOn: todayIso(), reviewCompletedOn: todayIso(), capImplementedOn: todayIso() },
      [
        { reviewNumber: 1, effective: true },
        { reviewNumber: 2, effective: true },
      ],
    );
    assert.equal(s.key, "closed");
  });

  test("a corrective action judged not effective reopens as critical, whichever review said so", () => {
    for (const reviews of [
      [{ reviewNumber: 1, effective: false }],
      [
        { reviewNumber: 1, effective: true },
        { reviewNumber: 2, effective: false },
      ],
    ]) {
      const s = stage({ reviewStartedOn: todayIso(), reviewCompletedOn: todayIso(), capImplementedOn: todayIso() }, reviews);
      assert.equal(s.key, "revise");
      assert.equal(s.level, "crit");
    }
  });

  test("reviews out of order are still read newest-last", () => {
    const s = stage(
      { reviewStartedOn: todayIso(), reviewCompletedOn: todayIso(), capImplementedOn: todayIso() },
      [
        { reviewNumber: 2, effective: false },
        { reviewNumber: 1, effective: true },
      ],
    );
    assert.equal(s.key, "revise");
  });
});

describe("overdue deadlines escalate", () => {
  test("a passed 7-day window is critical, not a warning", () => {
    const s = stage({ reportCreatedOn: addDays(todayIso(), -30), rootCauseAnalysis: null, correctiveActionPlan: null });
    assert.equal(s.key, "logged");
    assert.equal(s.level, "crit");
  });

  test("inside the window it is only a warning", () => {
    const s = stage({ reportCreatedOn: addDays(todayIso(), -1), rootCauseAnalysis: null, correctiveActionPlan: null });
    assert.equal(s.level, "warn");
  });

  test("a passed 30-day completion window is critical", () => {
    const s = stage({ reportCreatedOn: addDays(todayIso(), -40), reviewStartedOn: addDays(todayIso(), -35) });
    assert.equal(s.key, "review_open");
    assert.equal(s.level, "crit");
  });
});
