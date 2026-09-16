import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ratesLookWrong, costOf, DEFAULT_RATE_OUT } from "../src/lib/ai-spend";

/**
 * A total that counts the cheap half and calls itself the total.
 *
 * Found 16 September 2026 while working out what reading the remaining contracts would cost.
 * `ai_price_out` on this pharmacy's settings is the string "0", which the rate reader honours on
 * purpose — an explicit zero is a decision, and only a typed figure may set a rate to zero. But no
 * model gives its output away, and output is the dearer half.
 */
describe("a rate that cannot be true", () => {
  test("output priced at nothing is reported as unbelievable, with the size of what it hides", () => {
    const r = ratesLookWrong({ in: 5, out: 0, model: "claude-opus-5" }, 3_480_000);
    assert.equal(r.wrong, true);
    assert.match(r.says ?? "", /\$87\.00|\$87\.04|\$87/, "it says what the free half would come to");
    assert.match(r.says ?? "", /Anthropic invoice/, "and where the true figure lives, since it is not in this building");
  });

  test("a real rate is left alone", () => {
    assert.equal(ratesLookWrong({ in: 5, out: DEFAULT_RATE_OUT, model: "claude-opus-5" }, 3_480_000).wrong, false);
  });

  test("the month this was found in: $58.65 reported against $145.65 at the published rate", () => {
    /* 11.73M in, 3.48M out over thirty-one days, measured from the audit log. */
    const asSet = costOf(11_730_000, 3_480_000, { in: 5, out: 0, model: "claude-opus-5" });
    const published = costOf(11_730_000, 3_480_000, { in: 5, out: DEFAULT_RATE_OUT, model: "claude-opus-5" });
    assert.equal(asSet.toFixed(2), "58.65");
    assert.equal(published.toFixed(2), "145.65");
    assert.ok(published > asSet * 2, "the reported figure is less than half the real one");
  });
});
