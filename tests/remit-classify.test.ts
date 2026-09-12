import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyAdjustment, classifyRemittance, EMPTY_DICTIONARY, type Adjustment, type Dictionary } from "../src/lib/remit-classify";

/**
 * Where an adjustment belongs, and — more importantly — saying so when it belongs nowhere yet.
 *
 * The line these tests exist to hold is which decisions this module may make. The five CAS groups
 * are structural to the 835 and may be decided here. CARC, RARC and the PLB reasons are republished
 * three times a year and may not: they arrive as data, and until they do the honest answer is that
 * the code is not known. A dictionary that quietly maps an unknown code to a heading is worse than
 * no dictionary, because it turns a gap into a figure somebody will trust.
 */

const cas = (groupCode: string, reasonCode: string, amountCents: number): Adjustment => ({ level: "claim", groupCode, reasonCode, amountCents });
const plb = (reasonCode: string, amountCents: number): Adjustment => ({ level: "provider", reasonCode, amountCents });

const dict = (entries: Dictionary["entries"]): Dictionary => ({ entries, loadedOn: "2026-09-10" });
const source = { list: "X12 CARC", version: "2026-07-01", loadedOn: "2026-09-10" };

describe("the group places the money, with no code list at all", () => {
  test("a contractual obligation is a write-off and was never revenue", () => {
    const c = classifyAdjustment(cas("CO", "45", 4_500), EMPTY_DICTIONARY);
    assert.equal(c.heading, "contractual_writeoff");
    assert.equal(c.certainty, "settled");
    assert.equal(c.unplaced, false);
    assert.ok(c.neverUseFor.some((s) => /revenue/.test(s)));
  });

  test("the patient's share is placed, and warns about the double count first", () => {
    const c = classifyAdjustment(cas("PR", "3", 1_000), EMPTY_DICTIONARY);
    assert.equal(c.heading, "patient_responsibility");
    assert.equal(c.certainty, "settled");
    // The e-voucher's shape: money already on the claim, which adding would invent.
    assert.match(c.neverUseFor[0], /already carries this as `patientTotalCents`/);
  });

  test("a payer-initiated reduction is placed but says it wants the reason code", () => {
    const c = classifyAdjustment(cas("PI", "A1", 2_000), EMPTY_DICTIONARY);
    assert.equal(c.heading, "payer_reduction");
    assert.equal(c.certainty, "unknown");
    assert.ok(c.neverUseFor.some((s) => /not a write-off the pharmacy signed up to/.test(s)));
  });

  test("'other' is genuinely other: it stays unplaced and is counted", () => {
    const c = classifyAdjustment(cas("OA", "23", 700), EMPTY_DICTIONARY);
    assert.equal(c.heading, "unknown");
    assert.equal(c.unplaced, true);
  });
});

describe("a sixth group means the file was misread", () => {
  test("an unknown group is refused rather than called 'other'", () => {
    const c = classifyAdjustment(cas("ZZ", "45", 100), EMPTY_DICTIONARY);
    assert.equal(c.heading, "unknown");
    assert.equal(c.unplaced, true);
    assert.match(c.why, /not one of the five adjustment groups/);
    assert.ok(c.neverUseFor.some((s) => /misread/.test(s)));
  });

  test("no group at all is the same answer", () => {
    const c = classifyAdjustment({ level: "claim", groupCode: null, reasonCode: "45", amountCents: 100 });
    assert.equal(c.unplaced, true);
    assert.match(c.why, /carries no group code/);
  });
});

describe("provider-level money has no group to fall back on", () => {
  test("without the code list it is unplaced, and says exactly that", () => {
    const c = classifyAdjustment(plb("WO", 5_750), EMPTY_DICTIONARY);
    assert.equal(c.heading, "unknown");
    assert.equal(c.unplaced, true);
    assert.match(c.why, /no list has been loaded/);
    assert.match(c.neverUseFor[0], /goes missing between the claims and the bank/);
  });

  test("with the list loaded it is placed, and the entry's provenance is quoted", () => {
    const d = dict([{ code: "WO", kind: "plb", meaning: "Overpayment recovery", heading: "recoupment", source }]);
    const c = classifyAdjustment(plb("WO", 5_750), d);
    assert.equal(c.heading, "recoupment");
    assert.equal(c.certainty, "settled");
    assert.equal(c.unplaced, false);
    assert.match(c.why, /X12 CARC 2026-07-01/);
    assert.ok(c.neverUseFor.some((s) => /takes back an earlier month/.test(s)));
  });

  test("a claim-level entry does not answer a provider-level code", () => {
    // Same string, different code set. Mixing them is how a fee becomes a write-off.
    const d = dict([{ code: "WO", kind: "cas", meaning: "not this one", heading: "fee", source }]);
    assert.equal(classifyAdjustment(plb("WO", 100), d).unplaced, true);
  });
});

describe("unknown is an answer, and it is counted", () => {
  test("a remittance names what it could not place, in money", () => {
    const r = classifyRemittance([cas("CO", "45", 10_000), cas("PR", "3", 2_000), plb("L6", 1_250), plb("WO", 5_750)], EMPTY_DICTIONARY);
    assert.equal(r.unplacedCount, 2);
    assert.equal(r.unplacedCents, 7_000);
    assert.match(r.says, /\$70\.00 across 2 adjustments could not be placed/);
    assert.match(r.says, /money this remittance moved and the books cannot name/);
  });

  test("and stops saying it once the list is loaded", () => {
    const d = dict([
      { code: "L6", kind: "plb", meaning: "Interest owed", heading: "interest", source },
      { code: "WO", kind: "plb", meaning: "Overpayment recovery", heading: "recoupment", source },
    ]);
    const r = classifyRemittance([cas("CO", "45", 10_000), plb("L6", 1_250), plb("WO", 5_750)], d);
    assert.equal(r.unplacedCount, 0);
    assert.match(r.says, /^Every adjustment on this remittance is under a heading/);
  });

  test("no adjustments at all is not the same sentence as nothing unplaced", () => {
    assert.match(classifyRemittance([]).says, /every claim was paid as charged/);
  });

  test("headings are totalled separately, because they are not interchangeable", () => {
    const r = classifyRemittance([cas("CO", "45", 10_000), cas("CO", "45", 5_000), cas("PR", "3", 2_000)]);
    const co = r.byHeading.find((h) => h.heading === "contractual_writeoff");
    assert.deepEqual(co, { heading: "contractual_writeoff", cents: 15_000, count: 2 });
  });
});
