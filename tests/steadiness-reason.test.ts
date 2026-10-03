import test from "node:test";
import assert from "node:assert/strict";
import { whyNotSteady, STEADY } from "../src/lib/usage";

/*
 * `steady` is three tests wearing one boolean, and every refusal downstream printed the same
 * sentence: "The rate is one large fill, not a rate." On the pharmacy's own data that sentence was
 * printed 103 times out of 103 — and it was usually the wrong one. A hundred and three identical
 * refusals is not a filter reporting; it is a filter with nothing to say.
 */

const v = (o: Partial<Parameters<typeof whyNotSteady>[0]>) =>
  ({ activeDays: 5, prescriptions: 3, concentration: 0.2, windowDays: 90, ...o });

test("too few days says so, and says it is history rather than a bad drug", () => {
  const why = whyNotSteady(v({ activeDays: 2 }));
  assert.ok(why);
  assert.match(why, /2 days in the 90 days held/);
  assert.match(why, /Not enough history/);
  assert.doesNotMatch(why, /one large fill/i, "this is the sentence that was wrong 103 times");
});

test("too few prescriptions is a different fact with a different remedy", () => {
  const why = whyNotSteady(v({ prescriptions: 1 }));
  assert.ok(why);
  assert.match(why, /Only 1 prescription/);
  assert.match(why, /One patient's repeat/);
});

test("one fill dominating is the only case that is actually one large fill", () => {
  const why = whyNotSteady(v({ concentration: 0.9 }));
  assert.ok(why);
  assert.match(why, /One fill is 90% of everything dispensed/);
});

test("a steady drug has no reason at all", () => {
  assert.equal(whyNotSteady(v({})), null);
});

test("the tests are reported in the order they are applied, so the first failure is named", () => {
  // Fails all three. The scarcest evidence is the honest thing to report.
  const why = whyNotSteady(v({ activeDays: 1, prescriptions: 1, concentration: 1 }));
  assert.match(why!, /1 day in the 90 days held/);
});

test("the thresholds reported are the ones actually in force", () => {
  const why = whyNotSteady(v({ activeDays: STEADY.minActiveDays - 1 }));
  assert.match(why!, new RegExp(`${STEADY.minActiveDays} are wanted`));
});
