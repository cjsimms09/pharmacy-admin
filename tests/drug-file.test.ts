import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { packReadings, packDisagreement, reimbursementFrom, marginOf, buildDrugRow, type SupplierOffer } from "../src/lib/drug-file";

const offer = (supplier: string, packSize: string | null, a: Partial<SupplierOffer> = {}): SupplierOffer => ({
  supplier, packSize, packUnits: null, unitCostMicros: null, packCostCents: null, awpCents: null,
  contractFlag: null, pricedOn: null, availability: null, corrected: false, problems: [], ...a,
});

describe("the two ways a pack size can be written", () => {
  test("a bracket is cartons: the package is the two multiplied", () => {
    assert.deepEqual(packReadings("(3) 30 ML"), { inner: 30, whole: 90 });
    assert.deepEqual(packReadings("(6) 28 EA"), { inner: 28, whole: 168 });
  });

  test("without a bracket the two readings are the same number", () => {
    assert.deepEqual(packReadings("180 EA"), { inner: 180, whole: 180 });
  });

  test("anything that gives no number gives neither reading", () => {
    for (const p of [null, "", "Package", "0 EA"]) assert.deepEqual(packReadings(p), { inner: null, whole: null });
  });
});

describe("when suppliers really disagree about a package", () => {
  test("the same package written two ways is not a disagreement", () => {
    // McKesson writes the carton, ABC writes it out. 3 x 30 = 90. Reporting this would bury the
    // 656 real ones under 539 that are only notation.
    assert.equal(packDisagreement([offer("McKesson", "(3) 30 ML"), offer("ABC", "90 ML")], null), null);
    assert.equal(packDisagreement([offer("McKesson", "(6) 28 EA"), offer("Smith Drug", "168 EA")], null), null);
  });

  test("a different number is a disagreement, and names who says what", () => {
    // The real albuterol inhaler: three wholesalers say 6.7 GM and one says 6.
    const d = packDisagreement([offer("McKesson", "6.7 GM"), offer("ABC", "6 GM"), offer("ParMed", "6.7 GM")], null);
    assert.ok(d);
    assert.match(d.text, /McKesson says 6.7 GM/);
    assert.match(d.text, /ABC says 6 GM/);
  });

  test("the shelf counts as a source, and its notation is reconciled the same way", () => {
    // PioneerRx counts dispensing units, so it reports the inner figure where a wholesaler reports
    // the carton. 25 x 3 = 75, and the shelf's 3 ML is the same package.
    assert.equal(packDisagreement([offer("McKesson", "(25) 3 ML")], { packQty: 3 }), null);
    // But a shelf that says something neither reading allows is a genuine disagreement.
    assert.ok(packDisagreement([offer("McKesson", "(25) 3 ML")], { packQty: 40 }));
  });

  test("one source alone can never disagree with anything", () => {
    assert.equal(packDisagreement([offer("McKesson", "180 EA")], null), null);
    assert.equal(packDisagreement([], { packQty: 30 }), null);
  });

  test("a source with no readable pack size is left out rather than counted as a difference", () => {
    // That is its own fault, reported as pack_size_unreadable, not as a disagreement.
    assert.equal(packDisagreement([offer("McKesson", "180 EA"), offer("ABC", "Package")], null), null);
  });
});

describe("what a drug actually reimburses", () => {
  const fill = (a: Partial<{ quantityThousandths: number | null; remitCents: number; revenueCents: number; dateFilled: string; cashPlan: boolean }> = {}) =>
    ({ quantityThousandths: 30_000 as number | null, remitCents: 1_200, revenueCents: 1_500, dateFilled: "2026-09-01", cashPlan: false, ...a });

  test("per unit is the remit over the quantity, with thousandths carried out", () => {
    const r = reimbursementFrom([fill(), fill({ quantityThousandths: 90_000, remitCents: 3_600 })]);
    assert.ok(r);
    assert.equal(r.fills, 2);
    // $48.00 across 120 units is 40 cents a unit.
    assert.equal(r.perUnitCents, 40);
    assert.equal(r.perFillCents, 2_400);
  });

  test("the pharmacy's own cash price is kept out of it", () => {
    // A cash fill is a price set, not a rate paid. Averaged in it moves a figure whose whole
    // purpose is to say what plans reimburse.
    const r = reimbursementFrom([fill(), fill({ cashPlan: true, remitCents: 0, revenueCents: 9_000 })]);
    assert.ok(r);
    assert.equal(r.fills, 1, "only the plan-paid fill counts toward the rate");
    assert.equal(r.perUnitCents, 40);
    assert.equal(r.cashFills, 1);
    assert.equal(r.cashRevenueCents, 9_000);
  });

  test("a drug with no quantity reimburses per fill but not per unit", () => {
    const r = reimbursementFrom([fill({ quantityThousandths: null })]);
    assert.ok(r);
    assert.equal(r.perUnitCents, null);
    assert.equal(r.perFillCents, 1_200);
  });

  test("nothing dispensed says nothing", () => {
    assert.equal(reimbursementFrom([]), null);
  });

  test("the newest fill date is kept, for a row that has to say how current this is", () => {
    const r = reimbursementFrom([fill({ dateFilled: "2026-08-01" }), fill({ dateFilled: "2026-09-04" })]);
    assert.equal(r?.lastFilledOn, "2026-09-04");
  });
});

describe("what a drug earns against what it costs", () => {
  test("margin is the reimbursement less the cheapest unit cost anyone offers", () => {
    const row = buildDrugRow({
      ndc11: "68462043518", name: "Acamprosate", nadacUnitMicros: null, nadacPricingUnit: null, packFix: null, shelf: null,
      offers: [offer("McKesson", "180 EA", { unitCostMicros: 620_000 }), offer("ABC", "180 EA", { unitCostMicros: 500_000 })],
      reimbursement: reimbursementFrom([{ quantityThousandths: 1_000, remitCents: 100, revenueCents: 100, dateFilled: "2026-09-01", cashPlan: false }]),
    });
    const m = marginOf(row);
    assert.ok(m);
    // $1.00 a unit reimbursed against ABC's 50 cents.
    assert.equal(m.perUnitCents, 50);
    assert.equal(m.percent, 0.5);
  });

  test("no reimbursement or no cost means no margin, rather than a made-up one", () => {
    const bare = { ndc11: "x", name: null, nadacUnitMicros: null, nadacPricingUnit: null, packFix: null, shelf: null };
    assert.equal(marginOf(buildDrugRow({ ...bare, offers: [offer("McKesson", "1 EA", { unitCostMicros: 1 })], reimbursement: null })), null);
    assert.equal(
      marginOf(buildDrugRow({ ...bare, offers: [offer("McKesson", "1 EA")], reimbursement: reimbursementFrom([{ quantityThousandths: 1_000, remitCents: 100, revenueCents: 100, dateFilled: "2026-09-01", cashPlan: false }]) })),
      null,
    );
  });
});

describe("the drug row itself", () => {
  test("a settled pack size silences the disagreement it was settled to answer", () => {
    const row = buildDrugRow({
      ndc11: "69097014260", name: "Albuterol", nadacUnitMicros: null, nadacPricingUnit: null, shelf: null, reimbursement: null,
      offers: [offer("McKesson", "6.7 GM"), offer("ABC", "6 GM")],
      packFix: { packSize: "6.7 GM", note: "the canister", correctedBy: "Cory Simms", correctedAt: "2026-09-07" },
    });
    assert.ok(row.packDisagreement, "the sources still disagree, and the row still says so");
    assert.equal(row.problems.length, 0, "but it is no longer a problem, because it has been answered");
  });

  test("an unanswered disagreement is a fault worth a pack of the drug", () => {
    const row = buildDrugRow({
      ndc11: "69097014260", name: "Albuterol", nadacUnitMicros: null, nadacPricingUnit: null, shelf: null, reimbursement: null, packFix: null,
      offers: [offer("McKesson", "6.7 GM", { packCostCents: 4_200 }), offer("ABC", "6 GM", { packCostCents: 3_900 })],
    });
    assert.equal(row.problems.length, 1);
    assert.equal(row.problems[0].level, "wrong");
    assert.equal(row.problems[0].costCents, 3_900, "the cheapest pack, which is what one wrong buy costs");
    assert.equal(row.bestPackCostCents, 3_900);
  });
});

describe("a package described from two heights", () => {
  test("carton, bottle and shelf count are one package, not three answers", () => {
    // The real albuterol: McKesson writes the 25-vial carton, API writes the 75 mL it adds up to,
    // and PioneerRx counts single 3 mL vials off the shelf. Nobody is wrong.
    assert.equal(
      packDisagreement(
        [offer("McKesson", "(25) 3 ML"), offer("API", "75 ML"), offer("Smith Drug", "(25) 3 ML")],
        { packQty: 3 },
      ),
      null,
    );
  });

  test("three different numbers cannot be two heights of one package", () => {
    // 6.7, 6 and 7 GM are three answers to one question, whatever height you read them at.
    const d = packDisagreement([offer("McKesson", "6.7 GM"), offer("ParMed", "6 GM"), offer("API", "7 GM")], null);
    assert.ok(d);
  });

  test("a wholesaler calling a 168-tablet pack one each is still caught", () => {
    // ABC really does list APRI 6x28 as "1 EA". That is not a level of anything.
    const d = packDisagreement(
      [offer("McKesson", "(6) 28 EA"), offer("Smith Drug", "168 EA"), offer("ABC (Cencora)", "1 EA")],
      null,
    );
    assert.ok(d);
    assert.match(d.text, /ABC \(Cencora\) says 1 EA/);
  });
});
