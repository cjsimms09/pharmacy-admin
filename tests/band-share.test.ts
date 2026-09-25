import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { contractShareAtPrimary, bandChargeFor, type OfferForShare, type LineForShare } from "../src/lib/band-share";

/*
 * The band guard charges a basket bought elsewhere against the primary's compliance ratio. What it
 * may charge is the part the primary would have invoiced as a contract generic — and the flag that
 * decides that is the primary's, not the secondary's.
 *
 * Round figures: a $1.00 unit at the primary is 1,000,000 micros, and 10,000 thousandths is ten
 * units, so a line is $10.00.
 */

const TEN_UNITS = 10_000;
const at = (ndc11: string, unitCostMicros: number, rebated: boolean | null): OfferForShare => ({ ndc11, supplier: "McKesson", unitCostMicros, rebated });
const line = (ndc11: string, costCents: number): LineForShare => ({ ndc11, unitsThousandths: TEN_UNITS, costCents });

const primary = new Map<string, OfferForShare>([
  ["1", at("1", 1_000_000, true)],   // $1.00 a unit, a contract line → $10.00 counts
  ["2", at("2", 2_000_000, false)],  // $2.00 a unit, not on contract  → $20.00 cannot
  ["3", at("3", 3_000_000, null)],   // $3.00 a unit, no flag at all   → $30.00 unknown
]);

describe("what a basket would have counted toward the primary's ratio", () => {
  test("only the primary's contract lines count, at the primary's own price", () => {
    const s = contractShareAtPrimary([line("1", 8_00), line("2", 15_00)], primary);
    assert.equal(s.contractCents, 10_00, "the primary's $1.00 a unit, not the $0.80 the basket paid");
    assert.equal(s.nonContractCents, 20_00);
    assert.equal(s.unknownShare, 0);
    assert.equal(bandChargeFor(s).chargeCents, 10_00);
    assert.equal(bandChargeFor(s).confident, true);
  });

  test("the secondary's own flags decide nothing, which is the way to get this wrong", () => {
    /*
     * Every secondary in this pharmacy's catalogue is 100% "not rebated". Read that as the contract
     * share and every basket charges nought, the guard switches off, and orders go to secondaries
     * where a band really is at stake — a worse error than the conservative one, and opposite.
     */
    const secondaryFlags = new Map<string, OfferForShare>([
      ["1", { ndc11: "1", supplier: "TopRx", unitCostMicros: 800_000, rebated: false }],
      ["2", { ndc11: "2", supplier: "TopRx", unitCostMicros: 1_500_000, rebated: false }],
    ]);
    const wrong = contractShareAtPrimary([line("1", 8_00), line("2", 15_00)], secondaryFlags);
    assert.equal(wrong.contractCents, 0, "which is what reading the wrong side produces");
    const right = contractShareAtPrimary([line("1", 8_00), line("2", 15_00)], primary);
    assert.equal(right.contractCents, 10_00);
  });

  test("a line the primary does not stock is not a contract line and is not pretended to be", () => {
    const s = contractShareAtPrimary([line("9", 42_00)], primary);
    assert.equal(s.contractCents, 0);
    assert.equal(s.notStockedCents, 42_00, "at what the basket actually paid, since the primary has no price");
    assert.equal(s.unknownShare, 1);
  });

  test("an unflagged line is unknown, not nought and not contract", () => {
    const s = contractShareAtPrimary([line("1", 8_00), line("3", 25_00)], primary);
    assert.equal(s.contractCents, 10_00);
    assert.equal(s.unflaggedCents, 30_00);
    assert.equal(s.nonContractCents, 0);
    assert.equal(s.unknownShare, 0.75);
  });

  test("the charge includes the unknown and says so, because the safe direction is the dear one", () => {
    // A band lost costs several hundred dollars months later on a report nobody connects to the
    // decision. An upper bound that declares itself beats a precise-looking figure built on a guess.
    const s = contractShareAtPrimary([line("1", 8_00), line("3", 25_00)], primary);
    const c = bandChargeFor(s);
    assert.equal(c.chargeCents, 40_00);
    assert.equal(c.confident, false);
    assert.match(c.says, /Between \$10\.00 and \$40\.00/);
    assert.match(c.says, /the most this can cost and not what it will/);
    assert.match(c.says, /75%/);
  });

  test("the whole basket is only charged where the whole basket really is contract", () => {
    // Which is what the guard assumes today, for every basket, with no flag consulted at all.
    const allContract = contractShareAtPrimary([line("1", 8_00)], primary);
    assert.equal(bandChargeFor(allContract).chargeCents, allContract.atPrimaryCents);
    const noneContract = contractShareAtPrimary([line("2", 15_00)], primary);
    assert.equal(bandChargeFor(noneContract).chargeCents, 0);
    assert.equal(bandChargeFor(noneContract).confident, true);
  });

  test("what it says is readable by somebody deciding whether to place the order", () => {
    const s = contractShareAtPrimary([line("1", 8_00), line("2", 15_00), line("3", 25_00), line("9", 42_00)], primary);
    assert.match(s.says, /\$10\.00 of this basket is a contract line at the primary/);
    assert.match(s.says, /\$20\.00 is stocked there and not on contract/);
    assert.match(s.says, /carries no flag/);
    assert.match(s.says, /the primary does not stock/);
  });

  test("an empty basket says so rather than reporting nought as a fact", () => {
    const s = contractShareAtPrimary([], primary);
    assert.equal(s.unknownShare, 0);
    assert.match(s.says, /Nothing in this basket could be priced/);
  });
});
