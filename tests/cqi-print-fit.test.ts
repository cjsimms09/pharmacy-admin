import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fitRcaCap, linesNeeded, boxCapacity } from "../src/lib/cqi-print";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}. A short line.`).join("\n");

describe("what fits in the C-650's two boxes, and at what size", () => {
  test("a short analysis prints at the form's own size", () => {
    assert.match(fitRcaCap(lines(5), lines(5)).cls, /text-\[11px\]/);
    assert.equal(fitRcaCap(null, null).attach, false);
  });

  test("the type steps down until both boxes fit, and the longer of the two decides", () => {
    assert.match(fitRcaCap(lines(boxCapacity(11) + 1), lines(3)).cls, /9\.5px/);
    assert.match(fitRcaCap(lines(3), lines(boxCapacity(9.5) + 1)).cls, /8\.5px/);
    assert.equal(fitRcaCap(lines(boxCapacity(8.5)), lines(boxCapacity(8.5))).attach, false);
  });

  test("past the smallest size it goes to an attached sheet, and nothing is cut", () => {
    assert.equal(fitRcaCap(lines(boxCapacity(8.5) + 1), lines(3)).attach, true);
    assert.equal(fitRcaCap(lines(3), lines(boxCapacity(8.5) + 1)).attach, true);
  });

  test("a blank line between paragraphs costs a line, and a long paragraph costs as many lines as it wraps to", () => {
    assert.equal(linesNeeded("one\n\ntwo", 11), 3);
    assert.ok(linesNeeded("x".repeat(1000), 11) >= 8);
    assert.equal(linesNeeded(null, 11), 0);
  });

  test("a smaller size holds more lines, and more of each line", () => {
    assert.ok(boxCapacity(8.5) > boxCapacity(11));
    assert.ok(linesNeeded("x".repeat(600), 8.5) <= linesNeeded("x".repeat(600), 11));
  });
});
