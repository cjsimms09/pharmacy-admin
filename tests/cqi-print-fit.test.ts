import { test } from "node:test";
import assert from "node:assert/strict";
import { fitRcaCap } from "../src/lib/cqi-print";

test("short analysis prints at normal size on the form", () => {
  assert.deepEqual(fitRcaCap("a".repeat(500), "b".repeat(500)), { cls: "text-[11px]", attach: false });
  assert.equal(fitRcaCap(null, null).attach, false);
});
test("a longer analysis steps the type down and stays on the form", () => {
  const r = fitRcaCap("a".repeat(2000), "b".repeat(1500));
  assert.equal(r.attach, false);
  assert.match(r.cls, /9\.5px/);
});
test("a very long one goes to an attached sheet, and line breaks count", () => {
  assert.equal(fitRcaCap("a".repeat(3000), "b".repeat(2000)).attach, true);
  assert.equal(fitRcaCap("x\n".repeat(30), "y\n".repeat(30)).attach, true);
});
