import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fillsFromClaimRows, reconcileClaims, type PioneerClaimRow, type ClaimSide } from "../src/lib/pioneer-claims";

/**
 * One fill, two payers, and the money has to land exactly once.
 *
 * The owner: "We need to make sure we really understand secondaries and how to reconcile. How much
 * to expect from each payer. Math has to be perfect and logic has to be sound."
 *
 * The figures below are September's, real: 1,654 fills with a paid claim, 37 of them with two
 * payers, $136,104.14 of insurance money and $36,104.02 owed by patients.
 */

const claim = (over: Partial<PioneerClaimRow> = {}): PioneerClaimRow => ({
  rxNumber: "1000001",
  fillNumber: 0,
  primaryClaimId: null,
  bin: "610455",
  pcn: "BCBSKS",
  groupNumber: "KS1",
  networkId: "N1",
  planId: "P1",
  contractId: "C1",
  netPaidCents: 8_000,
  patientPayCents: 1_000,
  otherPayerCents: null,
  itemName: "ATORVASTATIN 20 MG TABLET",
  ndc11: "00093505698",
  gcn: "1234",
  quantityThousandths: 30_000,
  daysSupply: 30,
  basisOfReimbursement: "03",
  basisOfCostDetermination: "07",
  dispensingFeeCents: 100,
  dirFeeCents: null,
  evoucherCents: null,
  acquisitionCents: 4_000,
  filledOn: "2026-09-03",
  soldOn: "2026-09-03",
  fillTotalPriceCents: 9_000,
  ...over,
});

describe("a fill with one payer", () => {
  test("the payer is the primary and there is no secondary", () => {
    const r = fillsFromClaimRows([claim()]);
    assert.equal(r.fills.length, 1);
    assert.equal(r.fills[0].secondary, null);
    assert.equal(r.fills[0].insuranceCents, 8_000);
    assert.equal(r.fills[0].patientCents, 1_000);
    assert.deepEqual(r.payerCounts, { onePayer: 1, twoPayers: 0, more: 0 });
    assert.deepEqual(r.disagree, []);
    assert.deepEqual(r.problems, []);
  });
});

describe("a fill with two payers", () => {
  /*
   * How PioneerRx really states it, checked on all 37 of September's two-payer fills: the primary
   * pays its share and carries no patient balance at all, and the whole remaining patient
   * responsibility sits on the secondary. The primaries carried $0.00 of patient pay between them.
   */
  const primary = claim({ netPaidCents: 6_000, patientPayCents: 0 });
  const secondary = claim({
    primaryClaimId: "the-primary-claim",
    bin: "004336",
    pcn: "ADV",
    netPaidCents: 2_500,
    patientPayCents: 500,
    otherPayerCents: 6_000,
  });

  test("one fill, not two — the script count must not double", () => {
    const r = fillsFromClaimRows([primary, secondary]);
    assert.equal(r.fills.length, 1, "same prescription, same fill, two payers");
    assert.deepEqual(r.payerCounts, { onePayer: 0, twoPayers: 1, more: 0 });
  });

  test("the money adds across the payers and the patient is counted once", () => {
    const r = fillsFromClaimRows([primary, secondary]);
    const f = r.fills[0];
    assert.equal(f.insuranceCents, 8_500, "$60.00 from the first payer and $25.00 from the second");
    assert.equal(f.patientCents, 500, "the balance after the secondary, not the balance before it");
    assert.equal(f.insuranceCents + f.patientCents, f.fillTotalPriceCents, "the identity that makes it checkable");
    assert.deepEqual(r.disagree, []);
  });

  test("each payer keeps its own plan, network and contract", () => {
    const r = fillsFromClaimRows([primary, secondary]);
    const f = r.fills[0];
    assert.equal(f.primary.bin, "610455");
    assert.equal(f.secondary?.bin, "004336");
    assert.equal(f.primary.remitCents, 6_000);
    assert.equal(f.secondary?.remitCents, 2_500);
  });

  /*
   * The bug this module was written to end. The reader it replaces put the first row it saw into
   * the primary slot whatever the row said it was, then let a later primary overwrite it — so a
   * secondary that came back first was lost twice over, and every run reported "0 secondary claims"
   * while 37 fills had one. Position comes from `primaryClaimId` and from nothing else.
   */
  test("the order the rows arrive in changes nothing", () => {
    const forwards = fillsFromClaimRows([primary, secondary]);
    const backwards = fillsFromClaimRows([secondary, primary]);
    assert.deepEqual(backwards.fills, forwards.fills, "secondary first must give the same fill");
    assert.equal(backwards.fills[0].primary.bin, "610455");
    assert.equal(backwards.fills[0].secondary?.bin, "004336");
  });
});

describe("what must never pass in silence", () => {
  test("a fill whose payers and patient do not add up to its price is named", () => {
    const r = fillsFromClaimRows([claim({ netPaidCents: 8_000, patientPayCents: 1_000, fillTotalPriceCents: 12_000 })]);
    assert.equal(r.disagree.length, 1);
    assert.deepEqual(r.disagree[0], { rxNumber: "1000001", fillNumber: 0, addsToCents: 9_000, fillSaysCents: 12_000 });
  });

  test("a penny of rounding per payer is allowed and not reported", () => {
    const r = fillsFromClaimRows([
      claim({ netPaidCents: 6_000, patientPayCents: 0, fillTotalPriceCents: 8_501 }),
      claim({ primaryClaimId: "p", netPaidCents: 2_000, patientPayCents: 500, fillTotalPriceCents: 8_501 }),
    ]);
    assert.deepEqual(r.disagree, [], "two payers, two pennies of tolerance");
  });

  test("a third payer's money is still counted and the shortage of room is said out loud", () => {
    const r = fillsFromClaimRows([
      claim({ netPaidCents: 5_000, patientPayCents: 0, fillTotalPriceCents: 9_000 }),
      claim({ primaryClaimId: "p", bin: "004336", netPaidCents: 3_000, patientPayCents: 0, fillTotalPriceCents: 9_000 }),
      claim({ primaryClaimId: "p", bin: "610502", netPaidCents: 800, patientPayCents: 200, fillTotalPriceCents: 9_000 }),
    ]);
    const f = r.fills[0];
    assert.equal(f.insuranceCents, 8_800, "every payer counted, including the one with nowhere to sit");
    assert.equal(f.patientCents, 200);
    assert.equal(f.furtherPayers.length, 1);
    assert.equal(f.furtherPayers[0].bin, "610502");
    assert.deepEqual(r.payerCounts, { onePayer: 0, twoPayers: 0, more: 1 });
    assert.match(r.problems.join(" "), /has 3 payers/);
    assert.deepEqual(r.disagree, [], "and it still adds up");
  });

  test("a later payer with no first payer is counted and reported, not dropped", () => {
    const r = fillsFromClaimRows([claim({ primaryClaimId: "gone", netPaidCents: 2_000, patientPayCents: 7_000 })]);
    assert.equal(r.fills.length, 1);
    assert.equal(r.fills[0].insuranceCents, 2_000);
    assert.match(r.problems.join(" "), /no first one/);
  });

  test("two claims both claiming to be the first payer are reported", () => {
    const r = fillsFromClaimRows([claim({ netPaidCents: 4_000, patientPayCents: 0 }), claim({ bin: "004336", netPaidCents: 4_000, patientPayCents: 1_000 })]);
    assert.match(r.problems.join(" "), /each say they are the fill's first payer/);
    assert.equal(r.fills[0].insuranceCents, 8_000, "the money is still counted");
  });
});

describe("fills are kept apart", () => {
  test("two refills of one prescription are two fills", () => {
    const r = fillsFromClaimRows([claim({ fillNumber: 0 }), claim({ fillNumber: 1 })]);
    assert.equal(r.fills.length, 2);
    assert.deepEqual(r.payerCounts, { onePayer: 2, twoPayers: 0, more: 0 });
  });

  test("two prescriptions are two fills", () => {
    const r = fillsFromClaimRows([claim({ rxNumber: "1000001" }), claim({ rxNumber: "1000002" })]);
    assert.equal(r.fills.length, 2);
  });
});

/**
 * The copy is a day behind, and a comparison that forgets it says the opposite of the truth.
 *
 * The figures here are 11 September's, rounded to the fills that matter. PioneerRx's copy stopped
 * on the 9th; the site had the 10th from the nightly transaction report. The old comparison set
 * everything the site held against everything PioneerRx held and announced the site was "over" by
 * roughly the 10th's billing — while inside the window they both covered, the site was short.
 */
describe("reconciling the claims against a day-old copy", () => {
  const f = (rx: string, day: string, cents: number): ClaimSide => ({ rxNumber: rx, fillNumber: 0, filledOn: day, insuranceCents: cents, patientCents: 0 });

  /* PioneerRx stops on the 9th. Four fills, one of which the site never received. */
  const pioneer = [f("1", "2026-09-08", 10_000), f("2", "2026-09-09", 20_000), f("3", "2026-09-09", 5_000), f("4", "2026-09-09", 1_500)];
  /* The site has three of those, and a whole day the copy has not reached. */
  const site = [f("1", "2026-09-08", 10_000), f("2", "2026-09-09", 20_000), f("3", "2026-09-09", 5_000), f("9", "2026-09-10", 90_000)];

  test("the window closes at the newest fill PioneerRx returned", () => {
    assert.equal(reconcileClaims(pioneer, site).coverTo, "2026-09-09");
  });

  test("the day the copy has not reached is not a discrepancy", () => {
    const r = reconcileClaims(pioneer, site);
    assert.deepEqual(r.aheadOfTheCopy, { fills: 1, cents: 90_000 });
    assert.equal(r.onlyOnSite.fills, 0);
  });

  test("the site reads short, not over, once the windows match", () => {
    const r = reconcileClaims(pioneer, site);
    /* $365.00 against $350.00 inside the window: short by the one fill it never got. */
    assert.equal(r.gapCents, 1_500);
    assert.deepEqual(r.missingTotal, { fills: 1, cents: 1_500 });
    assert.match(r.says, /short/);
    assert.doesNotMatch(r.says, /\$900\.00 (short|more)/);
  });

  test("the missing fill is named by its day, so it is a job rather than a hunt", () => {
    assert.deepEqual(reconcileClaims(pioneer, site).missingFromSite, [{ day: "2026-09-09", fills: 1, cents: 1_500 }]);
  });

  test("a claim the site holds that PioneerRx has dropped inside the window is the opposite error", () => {
    const reversed = [...site.slice(0, 3), f("8", "2026-09-09", 4_000), f("9", "2026-09-10", 90_000)];
    const r = reconcileClaims(pioneer, reversed);
    assert.deepEqual(r.onlyOnSite, { fills: 1, cents: 4_000 });
    assert.deepEqual(r.aheadOfTheCopy, { fills: 1, cents: 90_000 });
  });

  test("two sides holding the same days agree", () => {
    const r = reconcileClaims(pioneer, pioneer);
    assert.equal(r.gapCents, 0);
    assert.equal(r.missingTotal.fills, 0);
    assert.match(r.says, /which agrees/);
  });

  test("a coordinated fill is one fill on both sides, however the caller holds it", () => {
    /*
     * The site's claims table is one row per claim, so a fill billed to two payers is two rows.
     * PioneerRx's side is already one entry a fill. Counting rows against fills made the site
     * appear to hold more fills than PioneerRx while also missing some of them.
     */
    const twoRows = [f("5", "2026-09-09", 6_000), f("5", "2026-09-09", 2_000)];
    const oneFill = [f("5", "2026-09-09", 8_000)];
    const r = reconcileClaims(oneFill, twoRows);
    assert.equal(r.site.fills, 1);
    assert.equal(r.site.remitCents, 8_000);
    assert.equal(r.gapCents, 0);
    assert.equal(r.missingTotal.fills, 0);
    assert.equal(r.onlyOnSite.fills, 0);
  });

  test("an empty copy compares nothing rather than declaring everything missing", () => {
    const r = reconcileClaims([], site);
    assert.equal(r.coverTo, null);
    assert.equal(r.missingTotal.fills, 0);
    assert.equal(r.site.fills, 4);
  });
});
