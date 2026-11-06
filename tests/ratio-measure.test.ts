import test from "node:test";
import assert from "node:assert/strict";
import { whyTermsCannotBeSaved } from "../src/lib/supplier-terms";
import { unstatedMeasureSays } from "../src/lib/rebate-rates";
import type { RebateTermsT } from "../src/lib/supplier-terms";

/*
 * A ladder selected by a ratio has to say which ratio.
 *
 * All three McKesson programmes were stored with no measure. `figuresFor` had nothing to read, no
 * band was ever chosen, and 7,165 contract generics were priced at roughly 30% above what the
 * pharmacy actually pays — while the ladders sat on file looking correct.
 */

const ladder = (over: Partial<RebateTermsT> = {}): RebateTermsT =>
  ({
    kind: "tiered_ratio", period: "month", eligibility: "catalog_rebate_flag",
    ratioMeasure: "generic_compliance", ratioDefinition: null,
    tiers: [{ thresholdPercent: 0, rebatePercent: 0 }, { thresholdPercent: 90, rebatePercent: 30 }],
    paidAs: null, notes: null, ...over,
  }) as RebateTermsT;

test("a ratio ladder with no measure cannot be filed, and the refusal says what to do", () => {
  const why = whyTermsCannotBeSaved(ladder({ ratioMeasure: null }));
  assert.ok(why);
  assert.match(why, /which ratio picks the band/i);
  assert.match(why, /generic compliance|generic purchase ratio/i);
  // The consequence, not just the rule: this is what it costs.
  assert.match(why, /printed cost/i);
});

test("a ratio ladder that names its measure files", () => {
  assert.equal(whyTermsCannotBeSaved(ladder({ ratioMeasure: "generic_compliance" })), null);
  assert.equal(whyTermsCannotBeSaved(ladder({ ratioMeasure: "generic_purchase_ratio" })), null);
});

test("a flat percentage needs no measure — there is no band to pick", () => {
  assert.equal(whyTermsCannotBeSaved(ladder({ kind: "flat_percent", ratioMeasure: null })), null);
});

/*
 * The diagnosis. `ratioSource` is computed from whether a scrubbed figure has been read at all and
 * knows nothing about `ratioMeasure`, so a supplier with a drill-down on file and no measure stated
 * fell past every branch and was told "the band it lands in pays nothing on contract generics
 * today". Both halves were false: no band was chosen, and the ladder had not landed anywhere.
 */
test("the diagnosis blames the unstated measure, never the band", () => {
  const says = unstatedMeasureSays("McKesson", ["Generic Compliance Rebate"]);
  assert.match(says, /does not say which ratio picks the band/i);
  assert.doesNotMatch(says, /pays nothing/i, "the band must not be blamed for a measure nobody stated");
  assert.match(says, /terms page/i, "and it has to say where to fix it");
});

test("the diagnosis names every programme that is missing its measure", () => {
  const says = unstatedMeasureSays("McKesson", ["Generic Compliance", "Generic Purchase Ratio", "Brand Factor"]);
  assert.match(says, /these programmes/);
  assert.match(says, /do not say/);
  for (const n of ["Generic Compliance", "Generic Purchase Ratio", "Brand Factor"]) assert.ok(says.includes(n));
});
