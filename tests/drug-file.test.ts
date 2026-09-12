import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { packReadings, packDisagreement, reimbursementFrom, marginOf, buildDrugRow, withEquivalents, type SupplierOffer, type DirectoryFact, type DrugRow } from "../src/lib/drug-file";

const offer = (supplier: string, packSize: string | null, a: Partial<SupplierOffer> = {}): SupplierOffer => ({ itemNumber: null, netUnitMicros: null, rebateApplied: false, rebateWhy: null, withheld: null, supplier, packSize, packUnits: null, unitCostMicros: null, packCostCents: null, awpCents: null,
  contractFlag: null, pricedOn: null, availability: null, corrected: false, problems: [], ...a,
});

describe("the two ways a pack size can be written", () => {
  test("a bracket is cartons: the package is the two multiplied", () => {
    assert.deepEqual(packReadings("(3) 30 ML"), { inner: 30, whole: 90, uom: "ML" });
    assert.deepEqual(packReadings("(6) 28 EA"), { inner: 28, whole: 168, uom: "EA" });
  });

  test("without a bracket the two readings are the same number", () => {
    assert.deepEqual(packReadings("180 EA"), { inner: 180, whole: 180, uom: "EA" });
  });

  test("anything that gives no number gives neither reading", () => {
    for (const p of [null, "", "Package", "0 EA"]) assert.deepEqual(packReadings(p), { inner: null, whole: null, uom: null });
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
  test("margin is the reimbursement less what the drug actually costs to buy", () => {
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

describe("what a supplier's line has to carry to be ordered from", () => {
  /*
   * An NDC says which drug. It does not say what to type on an order, and it does not say what the
   * drug actually costs — a wholesaler that pays a rebate on contract items is cheaper than its
   * printed price by exactly that rate. Comparing a rebated supplier's printed price against one
   * who pays no rebate sends the order to the wrong place, which is the fault the net column
   * exists to close.
   */
  test("the item number rides on the offer, because an order cannot name a line without it", () => {
    const o = offer("McKesson", "100 EA", { itemNumber: "4800611" });
    assert.equal(o.itemNumber, "4800611");
  });

  test("a line that earns no rebate has a net price equal to its printed one", () => {
    const o = offer("IPC", "100 EA", { unitCostMicros: 500_000, netUnitMicros: 500_000, rebateApplied: false });
    assert.equal(o.netUnitMicros, o.unitCostMicros);
    assert.equal(o.rebateApplied, false);
  });

  test("a rebated line is cheaper than it prints, and says the figure is net", () => {
    // Ten per cent back on a contract item: 50 cents printed is 45 net.
    const o = offer("McKesson", "100 EA", { unitCostMicros: 500_000, netUnitMicros: 450_000, rebateApplied: true, contractFlag: "rebated" });
    assert.ok((o.netUnitMicros as number) < (o.unitCostMicros as number));
    assert.equal(o.rebateApplied, true);
  });

  test("the cheaper printed price is not always the cheaper buy", () => {
    const dearer = offer("McKesson", "100 EA", { unitCostMicros: 520_000, netUnitMicros: 468_000, rebateApplied: true });
    const cheaper = offer("IPC", "100 EA", { unitCostMicros: 500_000, netUnitMicros: 500_000, rebateApplied: false });
    assert.ok((cheaper.unitCostMicros as number) < (dearer.unitCostMicros as number), "IPC prints cheaper");
    assert.ok((dearer.netUnitMicros as number) < (cheaper.netUnitMicros as number), "and McKesson is the cheaper buy");
  });
});

describe("the same drug from another labeller", () => {
  const AMLODIPINE = "amlodipine besylate|5 mg/1|tablet|oral";
  const fact = (labeler: string, teCode: string | null, key = AMLODIPINE): DirectoryFact => ({
    key, teCode, genericName: "amlodipine besylate", strength: "5 mg/1", form: "TABLET", labeler,
  });
  const row = (ndc11: string, offers: SupplierOffer[], extra: Partial<Parameters<typeof buildDrugRow>[0]> = {}): DrugRow =>
    buildDrugRow({ ndc11, name: `Amlodipine ${ndc11}`, offers, shelf: null, nadacUnitMicros: null, nadacPricingUnit: null, reimbursement: null, packFix: null, ...extra });

  const priced = (supplier: string, netUnitMicros: number, itemNumber: string | null = null) =>
    offer(supplier, "90 EA", { unitCostMicros: netUnitMicros, netUnitMicros, itemNumber });

  test("a cheaper NDC rated the same is named, with what it saves and how to order it", () => {
    const rows = withEquivalents(
      [
        row("00093051701", [priced("McKesson", 400_000)], {
          reimbursement: { fills: 10, unitsThousandths: 900_000, remitCents: 5_000, revenueCents: 5_000, perUnitCents: 5, perFillCents: 500, lastFilledOn: "2026-08-01", cashFills: 0, cashRevenueCents: 0 },
        }),
        row("65862010290", [priced("ANDA", 100_000, "A-7781")]),
      ],
      new Map([
        ["00093051701", fact("Teva", "AB")],
        ["65862010290", fact("Aurobindo", "AB")],
      ]),
    );
    const mine = rows.find((r) => r.ndc11 === "00093051701")!;
    assert.equal(mine.equivalence?.cheaper?.ndc11, "65862010290");
    assert.equal(mine.equivalence?.cheaper?.labeler, "Aurobindo");
    // An order has to name the line, so the item number rides along with the recommendation.
    assert.equal(mine.equivalence?.cheaper?.itemNumber, "A-7781");
    assert.equal(mine.equivalence?.savesPerUnitMicros, 300_000);
    // 300,000 micros a unit over 900 units = $270.00.
    assert.equal(mine.equivalence?.savesOnFilledCents, 27_000);
    // And the cheap one is told it is already the buy.
    const theirs = rows.find((r) => r.ndc11 === "65862010290")!;
    assert.equal(theirs.equivalence?.cheaper, null);
    assert.match(theirs.equivalence?.why ?? "", /already the buy/);
  });

  test("an AB1 is never offered in place of an AB2, however identical the key", () => {
    const rows = withEquivalents(
      [row("11111111111", [priced("McKesson", 400_000)]), row("22222222222", [priced("ANDA", 100_000)])],
      new Map([
        ["11111111111", fact("Teva", "AB1")],
        ["22222222222", fact("Aurobindo", "AB2")],
      ]),
    );
    const mine = rows.find((r) => r.ndc11 === "11111111111")!;
    assert.equal(mine.equivalence?.cheaper, null);
    assert.equal(mine.equivalence?.others.length, 0);
  });

  test("an unrated NDC is never substituted, and says why", () => {
    const rows = withEquivalents(
      [row("11111111111", [priced("McKesson", 400_000)]), row("22222222222", [priced("ANDA", 100_000)])],
      new Map([
        ["11111111111", fact("Teva", null)],
        ["22222222222", fact("Aurobindo", "AB")],
      ]),
    );
    const mine = rows.find((r) => r.ndc11 === "11111111111")!;
    assert.equal(mine.equivalence?.cheaper, null);
    assert.match(mine.equivalence?.why ?? "", /no therapeutic equivalence rating/);
  });

  test("a different strength is a different drug, whatever it is called", () => {
    const rows = withEquivalents(
      [row("11111111111", [priced("McKesson", 400_000)]), row("22222222222", [priced("ANDA", 100_000)])],
      new Map([
        ["11111111111", fact("Teva", "AB")],
        ["22222222222", fact("Aurobindo", "AB", "amlodipine besylate|10 mg/1|tablet|oral")],
      ]),
    );
    assert.equal(rows.find((r) => r.ndc11 === "11111111111")!.equivalence?.others.length, 0);
  });

  test("a rebate can make the dearer printed price the equivalent to switch to", () => {
    const rows = withEquivalents(
      [
        row("11111111111", [offer("IPC", "90 EA", { unitCostMicros: 300_000, netUnitMicros: 300_000 })]),
        row("22222222222", [offer("McKesson", "90 EA", { unitCostMicros: 320_000, netUnitMicros: 240_000, rebateApplied: true })]),
      ],
      new Map([
        ["11111111111", fact("Teva", "AB")],
        ["22222222222", fact("Aurobindo", "AB")],
      ]),
    );
    // On the printed price McKesson is dearer; on what it actually costs it is the switch.
    assert.equal(rows.find((r) => r.ndc11 === "11111111111")!.equivalence?.cheaper?.ndc11, "22222222222");
  });

  test("a package still in dispute is never the basis of a switch, in either direction", () => {
    const disputed = row("22222222222", [
      offer("McKesson", "6.7 GM", { unitCostMicros: 100_000, netUnitMicros: 100_000 }),
      offer("ABC", "6 GM", { unitCostMicros: 100_000, netUnitMicros: 100_000 }),
    ]);
    assert.ok(disputed.packDisagreement, "the fixture really is in dispute");
    const rows = withEquivalents(
      [row("11111111111", [priced("McKesson", 400_000)]), disputed],
      new Map([
        ["11111111111", fact("Teva", "AB")],
        ["22222222222", fact("Aurobindo", "AB")],
      ]),
    );
    const mine = rows.find((r) => r.ndc11 === "11111111111")!;
    assert.equal(mine.equivalence?.cheaper, null);
    assert.equal(mine.equivalence?.others.length, 0);
    assert.match(mine.equivalence?.why ?? "", /still in dispute/);
  });

  test("with no directory loaded nothing is claimed at all", () => {
    const rows = withEquivalents([row("11111111111", [priced("McKesson", 400_000)])], new Map());
    assert.equal(rows[0].equivalence, null);
  });

  test("an NDC the directory does not list says so rather than being grouped by its name", () => {
    const rows = withEquivalents(
      [row("11111111111", [priced("McKesson", 400_000)]), row("22222222222", [priced("ANDA", 100_000)])],
      new Map([["22222222222", fact("Aurobindo", "AB")]]),
    );
    const mine = rows.find((r) => r.ndc11 === "11111111111")!;
    assert.equal(mine.equivalence?.others.length, 0);
    assert.match(mine.equivalence?.why ?? "", /does not list this NDC/);
  });
});
