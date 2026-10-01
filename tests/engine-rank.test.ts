import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rankForAlertKey, rankForMoney, compareLines } from "../src/lib/engine/rank";

describe("where a line sits on Today", () => {
  test("the board and DEA outrank money, and a temperature excursion outranks the board", () => {
    assert.equal(rankForAlertKey("temps-excursion"), 1);
    assert.equal(rankForAlertKey("cqi-summary-due"), 2);
    assert.equal(rankForAlertKey("cs-inventory"), 2);
    assert.equal(rankForAlertKey("manual-ack"), 2);
    assert.equal(rankForAlertKey("backup-failed"), 2);
    assert.equal(rankForAlertKey("reports-refused"), 3);
    assert.equal(rankForAlertKey("payments-stranded"), 3);
    assert.equal(rankForAlertKey("something-new"), 4);
    assert.equal(rankForAlertKey("supplies-count"), 5);
    assert.equal(rankForAlertKey("updates"), 5);
  });

  test("a five-figure bank line is a payer or wholesaler matter before it is bookkeeping", () => {
    assert.equal(rankForMoney(-12_199_741), 3);
    assert.equal(rankForMoney(5_879), 4);
  });

  test("equal ranks: the dearest first, then the oldest", () => {
    const lines = [
      { id: "a", rank: 4, amountCents: -5_879, firstSeen: "2026-10-01" },
      { id: "b", rank: 2, amountCents: null, firstSeen: "2026-10-02" },
      { id: "c", rank: 4, amountCents: -580_000, firstSeen: "2026-10-02" },
      { id: "d", rank: 4, amountCents: -5_879, firstSeen: "2026-09-30" },
    ];
    assert.deepEqual([...lines].sort(compareLines).map((l) => l.id), ["b", "c", "d", "a"]);
  });
});
