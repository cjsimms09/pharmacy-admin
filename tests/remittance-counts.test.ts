import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { remittanceKindsSay, type RemittanceKinds } from "../src/lib/remittance-counts";

const kinds = (k: Partial<RemittanceKinds>): RemittanceKinds => ({ matched: 0, beforeTheStart: 0, unmatched: 0, paidAReversedFill: 0, ambiguous: 0, ...k });

describe("what the payments of one remittance are, on the lines that say so", () => {
  test("every kind is said in its own words and in one order", () => {
    assert.equal(
      remittanceKindsSay(kinds({ matched: 80, beforeTheStart: 2000, unmatched: 52, paidAReversedFill: 3, ambiguous: 2 })),
      "80 matched to a claim, 2,000 for fills from before this site's records begin, 52 tied to no claim, 3 paid against a fill this pharmacy had reversed, 2 that fit two or more claims equally",
    );
  });

  test("a kind with none is not said, but 'matched' always is: none matched is information", () => {
    assert.equal(remittanceKindsSay(kinds({})), "0 matched to a claim");
    assert.equal(remittanceKindsSay(kinds({ matched: 12 })), "12 matched to a claim");
  });

  test("one payment that fits two claims says 'fits'", () => {
    assert.equal(remittanceKindsSay(kinds({ matched: 1, ambiguous: 1 })), "1 matched to a claim, 1 that fits two or more claims equally");
  });

  test("the numbers spoken add to the payments, so nothing is left unsaid", () => {
    const cases = [kinds({}), kinds({ matched: 7, unmatched: 1 }), kinds({ matched: 2196, beforeTheStart: 13352, unmatched: 161, paidAReversedFill: 9, ambiguous: 4 }), kinds({ beforeTheStart: 5 })];
    for (const k of cases) {
      const said = remittanceKindsSay(k).split(", ").map((part) => Number(part.split(" ")[0].replace(/,/g, "")));
      assert.equal(said.reduce((a, b) => a + b, 0), k.matched + k.beforeTheStart + k.unmatched + k.paidAReversedFill + k.ambiguous);
    }
  });

  test("it never says a payment is waiting for a claim, which only the matcher can know", () => {
    assert.doesNotMatch(remittanceKindsSay(kinds({ matched: 1, beforeTheStart: 1, unmatched: 1, paidAReversedFill: 1, ambiguous: 1 })), /wait|yet|fault/i);
  });
});
