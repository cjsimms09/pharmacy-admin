import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DECISIONS } from "../src/lib/practice-decisions";
import { policies } from "../src/lib/manual";

/*
 * The vaccine cold chain policy, and the two facts it rests on.
 *
 * The owner, 16 September 2026: "Review vaccine storage: logger calibration, temperature records
 * and the excursion plan ... and write and implement our policy for this." Measured first: the
 * temperature records were in good order — two loggers, four readings a day each, every
 * out-of-range reading already explained — and the other two limbs had nothing behind them.
 * Nothing in the system held a calibration certificate, and the manual said how an excursion is
 * recorded without saying what is done about one.
 *
 * A manual is a standard the pharmacy is held to, not a description of what it would be nice to do,
 * so these cases guard the two ways that goes wrong: promising more than is performed, and naming
 * a person in a file that lives in a public repository.
 */

const text = () => policies("Test Pharmacy").find((p) => p.key === "temperatures")!.text.join(" ");

describe("what the cold chain policy commits the pharmacy to", () => {
  test("the logger's certificate is held, with the interval the certificate itself names", () => {
    const t = text();
    assert.match(t, /certificate of calibration testing traceable to a recognised standard/);
    assert.match(t, /the expiry the certificate itself names are recorded/);
    /* No interval is invented: the certificate says how long it is good for, not this manual. */
    assert.doesNotMatch(t, /every (one|two|1|2) years?/i);
  });

  test("an excursion is quarantined and not discarded, which is the step that protects a patient", () => {
    const t = text();
    assert.match(t, /labelled DO NOT USE/);
    assert.match(t, /It is not discarded and it is not administered/);
    assert.match(t, /contacts the manufacturer of each affected product for a determination/);
    assert.match(t, /returns to use only on the manufacturer's determination/);
  });

  test("the act and the record are both required, and the record alone is not the plan", () => {
    const t = text();
    /* The rule that was already there: an excursion must be explained before a month can close. */
    assert.match(t, /A month cannot be signed off while any excursion in it is unexplained/);
    /* And the one that was not: how long it was out of range, and who was spoken to. */
    assert.match(t, /how long the unit was out of range and the temperatures it reached/);
    assert.match(t, /who was spoken to and when/);
  });

  test("REGRESSION: no person is named in the policy text, because this repository is public", () => {
    const whole = policies("Test Pharmacy")
      .map((p) => `${p.title} ${p.text.join(" ")}`)
      .join(" ");
    assert.match(text(), /vaccine coordinator/, "the policy names the role");
    assert.doesNotMatch(whole, /\b(Cory|Simms|Darrah)\b/i, "and never the person: names are data, and data does not go in git");
  });
});

describe("the two facts the policy rests on are asked, not assumed", () => {
  const stock = DECISIONS.find((d) => d.key === "vaccine_stock")!;
  const who = DECISIONS.find((d) => d.key === "vaccine_coordinators")!;

  test("whether the stock is private or VFC, because the standards differ", () => {
    assert.ok(stock, "the question exists");
    assert.deepEqual(stock.choices.map((c) => c.value), ["private", "vfc", "both", "none"]);
    /* VFC is the stricter standard and its answer must say so plainly. */
    assert.match(stock.choices.find((c) => c.value === "vfc")!.sentence, /twice each working day/);
    assert.match(stock.choices.find((c) => c.value === "vfc")!.sentence, /three years/);
    /* Private stock must not be made to promise the VFC rules. */
    assert.doesNotMatch(stock.choices.find((c) => c.value === "private")!.sentence, /twice each working day/);
    assert.match(stock.choices.find((c) => c.value === "private")!.sentence, /not enrolled in that programme/);
  });

  test("holding both is held to the stricter of the two, not the easier", () => {
    assert.match(stock.choices.find((c) => c.value === "both")!.sentence, /twice each working day/);
  });

  test("REGRESSION: the coordinators are a free-text question, since two names were never a radio button", () => {
    assert.ok(who.freeText, "it takes words");
    assert.equal(who.choices.length, 0);
    const sentence = who.freeText!.sentence("Jane Smith, with Alex Brown as backup");
    assert.match(sentence, /^Jane Smith, with Alex Brown as backup/);
    assert.match(sentence, /quarantining stock affected by a temperature excursion/);
    assert.match(sentence, /obtaining the manufacturer's determination/);
  });

  test("every decision either offers choices or takes words — none can be defined unanswerable", () => {
    for (const d of DECISIONS) {
      assert.ok(d.choices.length > 0 || d.freeText, `${d.key} can be answered`);
    }
  });
});
