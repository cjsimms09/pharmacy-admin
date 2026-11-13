import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { judgeClose, type CloseCheck } from "../src/lib/month-close";

const doc = (key: string, done: boolean, extra: Partial<CloseCheck> = {}): CloseCheck => ({ key, name: key, done, says: `${key} says`, gate: "document", ...extra });

describe("a month with only an estimate outstanding", () => {
  test("is not waiting on documents, and is closed on an estimate that the closing line names", () => {
    const m = judgeClose({ month: "2026-10", today: "2026-11-06", checks: [doc("bank", true), doc("rebate", false, { estimated: true })] });
    assert.equal(m.state, "closed");
    assert.equal(m.documentsOutstanding, 0);
    assert.match(m.says, /closed on an estimate/);
    assert.match(m.says, /rebate says/);
  });
  test("a real missing document still blocks, estimate or not", () => {
    const m = judgeClose({ month: "2026-10", today: "2026-11-06", checks: [doc("bank", false), doc("rebate", false, { estimated: true })] });
    assert.equal(m.state, "waiting_on_documents");
    assert.equal(m.documentsOutstanding, 1);
    assert.doesNotMatch(m.says, /rebate/);
  });
  test("with nothing estimated it says plain 'is closed', as before", () => {
    const m = judgeClose({ month: "2026-10", today: "2026-11-06", checks: [doc("bank", true), doc("rebate", true)] });
    assert.match(m.says, /is closed\. Every document is on file/);
  });
});
