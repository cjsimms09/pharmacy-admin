import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tillGate } from "../src/lib/month-close-store";
import { judgeClose } from "../src/lib/month-close";

/*
 * September 2026 read "closed" while the engine's own comparison said the dispensing record was $13,885.14 ahead of the till and the cause
 * was not known. Every value here is invented.
 */
const line = (o: Partial<Parameters<typeof tillGate>[0]> = {}) => ({
  what: "The claims against the till", agrees: false, expected: false, says: "The dispensing record is $100.00 ahead of the till for the fills collected this month. The cause is not yet known.", ...o,
});

describe("the dispensing record against the till as a gate on closing a month", () => {
  test("a gap the engine did not expect holds the month open, and says what it is", () => {
    const g = tillGate(line());
    assert.equal(g.done, false);
    assert.equal(g.gate, "money");
    assert.match(g.says, /\$100\.00 ahead of the till/);
  });

  test("agreeing, an expected difference, or no judgement possible does not hold it", () => {
    assert.equal(tillGate(line({ agrees: true })).done, true);
    assert.equal(tillGate(line({ agrees: false, expected: true })).done, true);
    assert.equal(tillGate(line({ agrees: null })).done, true);
  });

  test("with every document in, an unexplained gap makes the month does-not-tie, and its own words are the reason", () => {
    const docs = [{ key: "d", name: "A document", done: true, says: "in", gate: "document" as const }];
    const m = judgeClose({ month: "2026-09", today: "2026-10-23", checks: [...docs, tillGate(line())] });
    assert.equal(m.state, "money_does_not_tie");
    assert.match(m.says, /\$100\.00 ahead of the till/);
    const ok = judgeClose({ month: "2026-09", today: "2026-10-23", checks: [...docs, tillGate(line({ agrees: true }))] });
    assert.equal(ok.state, "closed");
  });
});
