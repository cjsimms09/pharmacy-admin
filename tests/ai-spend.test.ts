import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { costOf, dollars, AUDIT_TOKENS, DRAFT_TOKENS, DEFAULT_RATE_IN, DEFAULT_RATE_OUT } from "../src/lib/ai-spend";

/**
 * What the buttons cost.
 *
 * This pharmacy pays its own API bill, and the question asked was how much one press of "Put it
 * right" comes to. A button that spends money without saying how much is one nobody should press,
 * so the figure has to be right — and an estimate that comes in low is worse than useless on a
 * question about money.
 */
const opus = { in: DEFAULT_RATE_IN, out: DEFAULT_RATE_OUT, model: "claude-opus-5" };
const sonnet = { in: 3, out: 15, model: "claude-sonnet-5" };

describe("what a call costs", () => {
  test("input and output are charged at their own rates", () => {
    // A million of each, so the arithmetic is inspectable by eye.
    assert.equal(costOf(1_000_000, 0, opus), 15);
    assert.equal(costOf(0, 1_000_000, opus), 75);
    assert.equal(costOf(1_000_000, 1_000_000, opus), 90);
  });

  test("reading one section of the manual is pennies", () => {
    const c = costOf(AUDIT_TOKENS.in, AUDIT_TOKENS.out, opus);
    assert.ok(c > 0.05 && c < 0.07, `${c} is not about six cents`);
  });

  test("writing a policy costs more than reading one, because the answer is longer", () => {
    assert.ok(
      costOf(DRAFT_TOKENS.in, DRAFT_TOKENS.out, opus) > costOf(AUDIT_TOKENS.in, AUDIT_TOKENS.out, opus),
    );
  });

  test("a whole manual read once is tens of dollars at most, not hundreds", () => {
    // 150 sections is a large manual. This is the number that decides whether the feature is
    // usable at all, so it is asserted rather than assumed.
    const whole = costOf(150 * AUDIT_TOKENS.in, 150 * AUDIT_TOKENS.out, opus);
    assert.ok(whole > 5 && whole < 15, `${whole} for 150 sections`);
  });

  test("a cheaper model is the lever, and it is a large one", () => {
    const a = costOf(150 * AUDIT_TOKENS.in, 150 * AUDIT_TOKENS.out, opus);
    const b = costOf(150 * AUDIT_TOKENS.in, 150 * AUDIT_TOKENS.out, sonnet);
    assert.ok(b < a / 4, `${b} is not meaningfully cheaper than ${a}`);
  });

  test("a rate of nothing costs nothing rather than producing a NaN on the screen", () => {
    assert.equal(costOf(5000, 5000, { in: 0, out: 0, model: "x" }), 0);
  });
});

describe("writing an amount somebody reads", () => {
  test("dollars and cents", () => {
    assert.equal(dollars(8.5), "$8.50");
    assert.equal(dollars(1234.5), "$1,234.50");
  });

  test("a fraction of a cent says so rather than rounding to nothing", () => {
    // "$0.00" next to a button reads as free, which would be a lie.
    assert.equal(dollars(0.004), "under a cent");
    assert.equal(dollars(0), "$0.00");
  });
});
