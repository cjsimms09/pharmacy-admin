import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planBatches, estimateCost, pdfPageCount, BATCH_BYTES_LIMIT, BATCH_REQUEST_LIMIT } from "../src/lib/contract-run";

/** The run's arithmetic: what fits in a batch, what a read costs, how long a document is. */
describe("batches under the limits", () => {
  test("requests are grouped in order, breaking on bytes and on count, never leaving one behind", () => {
    const items = Array.from({ length: 250 }, (_, i) => ({ item: i, bytes: 1_000_000 }));
    const groups = planBatches(items);
    assert.equal(groups.flat().length, 250);
    assert.deepEqual(groups.map((g) => g.length), [100, 100, 50]);
    assert.deepEqual(groups[0].slice(0, 3), [0, 1, 2]);
    const big = [{ item: "a", bytes: BATCH_BYTES_LIMIT - 1 }, { item: "b", bytes: 2 }, { item: "c", bytes: 1 }];
    assert.deepEqual(planBatches(big), [["a"], ["b", "c"]]);
    assert.equal(BATCH_REQUEST_LIMIT, 100);
  });
  test("a single request larger than a whole batch still goes, alone", () => {
    assert.deepEqual(planBatches([{ item: "x", bytes: BATCH_BYTES_LIMIT * 2 }, { item: "y", bytes: 1 }]), [["x"], ["y"]]);
  });
  test("nothing in, nothing out", () => {
    assert.deepEqual(planBatches([]), []);
  });
});

describe("the estimate", () => {
  test("uses the rates typed in settings, halved for the batch, and grows with pages", () => {
    // 120 pages at $15/$75 per million, halved for the batch: in 180k–360k tokens → $1.35–$2.70;
    // out 10 documents × 4k–8k tokens → $1.50–$3.00. Low $2.85, high $5.70.
    const e = estimateCost(120, "claude-opus-5", { in: 15, out: 75 });
    assert.ok(Math.abs(e.low - 2.85) < 0.01, String(e.low));
    assert.ok(Math.abs(e.high - 5.7) < 0.01, String(e.high));
    assert.ok(estimateCost(240, "claude-opus-5", { in: 15, out: 75 }).high > e.high);
    assert.ok(estimateCost(120, "claude-sonnet-5").high < e.high);
  });
});

describe("the page count", () => {
  test("counts page objects and never says zero", () => {
    assert.equal(pdfPageCount({ toString: () => "/Type /Page\n/Type /Pages\n/Type /Page\n" }), 2);
    assert.equal(pdfPageCount({ toString: () => "nothing" }), 1);
  });
});
