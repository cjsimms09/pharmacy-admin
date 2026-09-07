import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  planOrder, packsFor, packCostCents, offersFor, topUpCandidates, verdictFor,
  type Offer, type Movement, type SupplierTerms,
} from "../src/lib/order-plan";

/*
 * The pharmacy's real shape: McKesson is the primary and takes any order; IPC is the secondary,
 * often cheaper, and will not ship under $500.
 */
const MCK: SupplierTerms = { supplier: "McKesson", minimumCents: null, primary: true, leadTimeDays: 1 };
const IPC: SupplierTerms = { supplier: "IPC", minimumCents: 50_000, leadTimeDays: 2 };

const offer = (o: Partial<Offer> & { ndc11: string; supplier: string; effectiveUnitMicros: number }): Offer => ({
  unitCostMicros: o.effectiveUnitMicros, packQty: 100, ...o,
});

const moves = (ndc11: string, perDayThousandths: number, onHandThousandths = 0, steady = true): Movement =>
  ({ ndc11, perDayThousandths, onHandThousandths, steady });

describe("pack arithmetic", () => {
  test("a need is covered by whole packs, rounded up", () => {
    assert.equal(packsFor(100_000, 100), 1);
    assert.equal(packsFor(101_000, 100), 2);
    assert.equal(packsFor(1, 100), 1, "any need at all is at least one pack");
    assert.equal(packsFor(0, 100), 0);
  });

  test("a pack costs its units at the effective price", () => {
    // 100 tablets at one cent each is a dollar.
    assert.equal(packCostCents(offer({ ndc11: "A", supplier: "IPC", effectiveUnitMicros: 10_000, packQty: 100 }), 1), 100);
    assert.equal(packCostCents(offer({ ndc11: "A", supplier: "IPC", effectiveUnitMicros: 10_000, packQty: 100 }), 3), 300);
  });
});

describe("choosing where a line goes", () => {
  test("the cheapest effective price wins, and it is the effective one", () => {
    const offers = [
      offer({ ndc11: "A", supplier: "McKesson", unitCostMicros: 1_500_000, effectiveUnitMicros: 1_065_000 }),
      offer({ ndc11: "A", supplier: "IPC", unitCostMicros: 1_200_000, effectiveUnitMicros: 1_200_000 }),
    ];
    // IPC is cheaper on the printed price; McKesson is cheaper after the 29% contract rebate.
    assert.equal(offersFor(offers, "A")[0].supplier, "McKesson");
  });

  test("a short-dated lot never wins a comparison on price alone", () => {
    const offers = [
      offer({ ndc11: "A", supplier: "IPC", effectiveUnitMicros: 4_000, shortDated: "07/26" }),
      offer({ ndc11: "A", supplier: "McKesson", effectiveUnitMicros: 18_000 }),
    ];
    assert.equal(offersFor(offers, "A")[0].supplier, "McKesson");
  });

  test("an offer with no pack size cannot be ordered and is not a price", () => {
    assert.deepEqual(offersFor([offer({ ndc11: "A", supplier: "IPC", effectiveUnitMicros: 1, packQty: null })], "A"), []);
  });

  test("a need nobody prices is reported, not dropped", () => {
    const plan = planOrder({
      needs: [{ ndc11: "GHOST", name: "Nothing", needThousandths: 30_000 }],
      offers: [], terms: [MCK, IPC], movement: [], maxDaysOfStock: 14, materialityCents: 100,
    });
    assert.equal(plan.baskets.length, 0);
    assert.equal(plan.unfilled.length, 1);
    assert.match(plan.unfilled[0].why, /No supplier offers this NDC/);
  });
});

describe("reaching a secondary's minimum", () => {
  /*
   * The worked example, checked by hand.
   *
   * Need: 100 units of A. IPC $1.00/unit in packs of 100 → $100. McKesson $1.20 → the same units
   * cost $120 there, so the line saves $20 at IPC. IPC's minimum is $500, so the needed line is
   * $400 short.
   *
   * B moves 10 units a day and IPC is $2.00 against McKesson's $2.50, packs of 50. A fourteen-day
   * cap is 140 units; two whole packs (100 units) fit inside it, costing $200 and saving $50.
   * C moves 5 a day, IPC $5.00 against $5.50, packs of 30. The cap is 70 units; two packs (60)
   * cost $300 and save $30.
   *
   * B saves 25c per dollar committed and C saves 10c, so B is taken first. $100 + $200 + $300 is
   * $600, over the minimum, saving $100 in all.
   */
  const offers: Offer[] = [
    offer({ ndc11: "A", supplier: "IPC", effectiveUnitMicros: 1_000_000, packQty: 100 }),
    offer({ ndc11: "A", supplier: "McKesson", effectiveUnitMicros: 1_200_000, packQty: 100 }),
    offer({ ndc11: "B", supplier: "IPC", effectiveUnitMicros: 2_000_000, packQty: 50 }),
    offer({ ndc11: "B", supplier: "McKesson", effectiveUnitMicros: 2_500_000, packQty: 50 }),
    offer({ ndc11: "C", supplier: "IPC", effectiveUnitMicros: 5_000_000, packQty: 30 }),
    offer({ ndc11: "C", supplier: "McKesson", effectiveUnitMicros: 5_500_000, packQty: 30 }),
  ];
  const movement = [moves("A", 3_000), moves("B", 10_000), moves("C", 5_000)];
  const plan = () =>
    planOrder({
      needs: [{ ndc11: "A", name: "Drug A", needThousandths: 100_000 }],
      offers, terms: [MCK, IPC], movement, maxDaysOfStock: 14, materialityCents: 100,
    });

  test("the needed line goes to IPC and is $400 short of the minimum", () => {
    const b = plan().baskets[0];
    assert.equal(b.supplier, "IPC");
    assert.equal(b.needCents, 10_000);
    assert.equal(b.shortfallCents, 40_000);
  });

  test("top-ups are taken best-value-per-dollar first", () => {
    const b = plan().baskets[0];
    const tops = b.lines.filter((l) => l.reason === "top_up");
    assert.deepEqual(tops.map((l) => l.ndc11), ["B", "C"]);
  });

  test("the arithmetic, to the cent", () => {
    const b = plan().baskets[0];
    const byNdc = new Map(b.lines.map((l) => [l.ndc11, l]));
    assert.equal(byNdc.get("A")?.costCents, 10_000);
    assert.equal(byNdc.get("A")?.savingCents, 2_000);
    assert.equal(byNdc.get("B")?.packs, 2);
    assert.equal(byNdc.get("B")?.costCents, 20_000);
    assert.equal(byNdc.get("B")?.savingCents, 5_000);
    assert.equal(byNdc.get("C")?.packs, 2);
    assert.equal(byNdc.get("C")?.costCents, 30_000);
    assert.equal(byNdc.get("C")?.savingCents, 3_000);
    assert.equal(b.subtotalCents, 60_000);
    assert.equal(b.topUpCents, 50_000);
    assert.equal(b.savingCents, 10_000);
    assert.equal(b.meetsMinimum, true);
    assert.equal(b.verdict, "top_up_to_order");
  });

  test("no top-up leaves more than the cap on the shelf", () => {
    for (const l of plan().baskets[0].lines.filter((x) => x.reason === "top_up")) {
      assert.ok(l.daysOfStockAfter <= 14, `${l.ndc11} left ${l.daysOfStockAfter} days`);
    }
  });

  test("what is already on the shelf reduces the top-up", () => {
    const p = planOrder({
      needs: [{ ndc11: "A", name: "Drug A", needThousandths: 100_000 }],
      offers, terms: [MCK, IPC],
      // 100 units of B already held: the cap is 140, so only 40 units of room — under one pack.
      movement: [moves("A", 3_000), moves("B", 10_000, 100_000), moves("C", 5_000)],
      maxDaysOfStock: 14, materialityCents: 100,
    });
    const b = p.baskets[0];
    assert.deepEqual(b.lines.filter((l) => l.reason === "top_up").map((l) => l.ndc11), ["C"]);
    assert.match(b.refusals.find((r) => r.ndc11 === "B")?.why ?? "", /over the 14-day cap/);
  });
});

describe("what a top-up is refused for", () => {
  const base = {
    supplier: "IPC",
    names: new Map<string, string | null>(),
    alreadyOrdered: new Set<string>(),
    maxDaysOfStock: 14,
    materialityCents: 100,
  };
  const pair = (ndc: string, extra: Partial<Offer> = {}): Offer[] => [
    offer({ ndc11: ndc, supplier: "IPC", effectiveUnitMicros: 1_000_000, packQty: 10, ...extra }),
    offer({ ndc11: ndc, supplier: "McKesson", effectiveUnitMicros: 2_000_000, packQty: 10 }),
  ];

  test("nothing dispensed in the window", () => {
    const r = topUpCandidates({ ...base, offers: pair("X"), movement: [moves("X", 0)] });
    assert.equal(r.ranked.length, 0);
    assert.match(r.refused[0].why, /no velocity is a write-off/);
  });

  test("one big fill is not a rate", () => {
    const r = topUpCandidates({ ...base, offers: pair("X"), movement: [moves("X", 10_000, 0, false)] });
    assert.equal(r.ranked.length, 0);
    assert.match(r.refused[0].why, /one large fill/);
  });

  test("short-dated stock is never a bulk buy", () => {
    const r = topUpCandidates({ ...base, offers: pair("X", { shortDated: "07/26" }), movement: [moves("X", 10_000)] });
    assert.equal(r.ranked.length, 0);
    assert.match(r.refused[0].why, /Short-dated/);
  });

  test("an item only this supplier prices has no saving to bank", () => {
    const only = [offer({ ndc11: "X", supplier: "IPC", effectiveUnitMicros: 1_000_000, packQty: 10 })];
    const r = topUpCandidates({ ...base, offers: only, movement: [moves("X", 10_000)] });
    assert.equal(r.ranked.length, 0);
    assert.match(r.refused[0].why, /no saving to bank/);
  });

  test("an item this supplier is dearer on is passed over without comment", () => {
    const dearer = [
      offer({ ndc11: "X", supplier: "IPC", effectiveUnitMicros: 3_000_000, packQty: 10 }),
      offer({ ndc11: "X", supplier: "McKesson", effectiveUnitMicros: 1_000_000, packQty: 10 }),
    ];
    const r = topUpCandidates({ ...base, offers: dearer, movement: [moves("X", 10_000)] });
    assert.equal(r.ranked.length, 0);
    assert.equal(r.refused.length, 0, "most of the catalogue is dearer here; that is not news");
  });

  test("a saving under the materiality floor is not a reason to buy deep", () => {
    const thin = [
      offer({ ndc11: "X", supplier: "IPC", effectiveUnitMicros: 999_000, packQty: 10 }),
      offer({ ndc11: "X", supplier: "McKesson", effectiveUnitMicros: 1_000_000, packQty: 10 }),
    ];
    // 100 units at a tenth of a cent apart is 10c of saving, under a $1 floor.
    const r = topUpCandidates({ ...base, offers: thin, movement: [moves("X", 10_000)] });
    assert.equal(r.ranked.length, 0);
  });

  test("something already in the order is not topped up again", () => {
    const r = topUpCandidates({ ...base, alreadyOrdered: new Set(["X"]), offers: pair("X"), movement: [moves("X", 10_000)] });
    assert.equal(r.ranked.length, 0);
    assert.equal(r.refused.length, 0);
  });
});

describe("the rebate band overrules the invoice", () => {
  test("a saving that costs a band is sent back to the primary", () => {
    const offers = [
      offer({ ndc11: "A", supplier: "IPC", effectiveUnitMicros: 1_000_000, packQty: 100 }),
      offer({ ndc11: "A", supplier: "McKesson", effectiveUnitMicros: 1_200_000, packQty: 100 }),
    ];
    const plan = planOrder({
      needs: [{ ndc11: "A", name: "Drug A", needThousandths: 100_000 }],
      offers, terms: [MCK, { ...IPC, minimumCents: null }], movement: [moves("A", 3_000)],
      maxDaysOfStock: 14, materialityCents: 100,
      // Saves $20 on the invoice, drops the band and loses $336 on the month's contract generics.
      bandDelta: () => -33_600,
    });
    const b = plan.baskets[0];
    assert.equal(b.verdict, "move_to_primary");
    assert.match(b.why, /costs \$336\.00 in rebate band/);
    assert.equal(plan.totalSavingCents, 2_000 - 33_600);
  });

  test("a band gained is kept", () => {
    const { verdict } = verdictFor({
      meets: true, shortfall: 0, shortfallAfter: 0, topUpCents: 0, saving: 2_000,
      bandDeltaCents: 5_000, materialityCents: 100, primary: false,
    });
    assert.equal(verdict, "order");
  });
});

describe("when the minimum cannot honestly be met", () => {
  test("it holds and says why, rather than inventing a basket", () => {
    const offers = [
      offer({ ndc11: "A", supplier: "IPC", effectiveUnitMicros: 1_000_000, packQty: 100 }),
      offer({ ndc11: "A", supplier: "McKesson", effectiveUnitMicros: 1_200_000, packQty: 100 }),
      // The only other thing IPC is cheaper on has not been dispensed at all.
      offer({ ndc11: "DEAD", supplier: "IPC", effectiveUnitMicros: 1_000_000, packQty: 100 }),
      offer({ ndc11: "DEAD", supplier: "McKesson", effectiveUnitMicros: 9_000_000, packQty: 100 }),
    ];
    const plan = planOrder({
      needs: [{ ndc11: "A", name: "Drug A", needThousandths: 100_000 }],
      offers, terms: [MCK, IPC], movement: [moves("A", 3_000), moves("DEAD", 0)],
      maxDaysOfStock: 14, materialityCents: 100,
    });
    const b = plan.baskets[0];
    assert.equal(b.meetsMinimum, false);
    assert.equal(b.verdict, "hold");
    assert.equal(b.shortfallAfterTopUpsCents, 40_000);
    assert.match(b.why, /Short of the minimum by \$400\.00/);
    assert.equal(b.topUpCents, 0, "nothing was bought to make the number");
  });

  test("a supplier with no minimum simply orders", () => {
    const offers = [offer({ ndc11: "A", supplier: "McKesson", effectiveUnitMicros: 1_000_000, packQty: 100 })];
    const b = planOrder({
      needs: [{ ndc11: "A", name: "Drug A", needThousandths: 100_000 }],
      offers, terms: [MCK], movement: [moves("A", 3_000)], maxDaysOfStock: 14, materialityCents: 100,
    }).baskets[0];
    assert.equal(b.verdict, "order");
    assert.equal(b.shortfallCents, 0);
  });
});

describe("pack rounding is stated, never sold as a saving", () => {
  test("the overage on a needed line is reported separately", () => {
    const offers = [offer({ ndc11: "A", supplier: "McKesson", effectiveUnitMicros: 1_000_000, packQty: 100 })];
    const line = planOrder({
      needs: [{ ndc11: "A", name: "Drug A", needThousandths: 101_000 }],
      offers, terms: [MCK], movement: [moves("A", 3_000)], maxDaysOfStock: 14, materialityCents: 100,
    }).baskets[0].lines[0];
    assert.equal(line.packs, 2);
    assert.equal(line.unitsThousandths, 200_000);
    assert.equal(line.packOverageThousandths, 99_000);
    assert.equal(line.reason, "need", "nobody chose the extra 99 units; it is not a top-up");
  });
});

describe("freight", () => {
  test("freight below the free threshold comes off the saving", () => {
    const offers = [
      offer({ ndc11: "A", supplier: "IPC", effectiveUnitMicros: 1_000_000, packQty: 100 }),
      offer({ ndc11: "A", supplier: "McKesson", effectiveUnitMicros: 1_200_000, packQty: 100 }),
    ];
    const b = planOrder({
      needs: [{ ndc11: "A", name: "Drug A", needThousandths: 100_000 }],
      offers,
      terms: [MCK, { supplier: "IPC", minimumCents: null, freeFreightCents: 25_000, freightCents: 1_500 }],
      movement: [moves("A", 3_000)], maxDaysOfStock: 14, materialityCents: 100,
    }).baskets[0];
    assert.equal(b.freightCents, 1_500);
    assert.equal(b.savingCents, 2_000 - 1_500);
  });
});

describe("why a line is for the quantity it is", () => {
  /*
   * The phentermine case. Thirty units short, the smallest pack is a thousand, and the shelf runs
   * on fourteen days. Every row on the buy list read "Short of the target", which is true of every
   * row and explains none of them — the quantity is decided by the pack, not by the shortfall.
   */
  const plan = (packQty: number, extra: Offer[] = []) =>
    planOrder({
      needs: [{ ndc11: "PHEN", name: "Phentermine 37.5mg", needThousandths: 30_000 }],
      offers: [offer({ ndc11: "PHEN", supplier: "McKesson", effectiveUnitMicros: 20_000, packQty }), ...extra],
      terms: [MCK, IPC],
      movement: [moves("PHEN", 7_000, 0)],
      maxDaysOfStock: 14,
      materialityCents: 500,
    });

  test("the reason names the pack, not the shortfall", () => {
    const line = plan(1000).baskets[0].lines[0];
    assert.equal(line.packs, 1);
    assert.match(line.why, /Short 30/);
    assert.match(line.why, /smallest pack here is 1000/);
    assert.match(line.why, /970 more than the need/);
  });

  test("a need over the shelf ceiling says so, with the days", () => {
    const line = plan(1000).baskets[0].lines[0];
    // 1,000 units at 7 a day is about 143 days.
    assert.ok(line.overCap, "a need that carries the shelf past the cap must say so");
    assert.equal(line.overCap!.cap, 14);
    assert.ok(line.overCap!.days > 140, String(line.overCap!.days));
  });

  test("where another supplier ships it smaller, that is the way out and it is named", () => {
    const line = plan(1000, [offer({ ndc11: "PHEN", supplier: "IPC", effectiveUnitMicros: 30_000, packQty: 100 })]).baskets[0].lines[0];
    assert.equal(line.overCap?.smallerPack?.supplier, "IPC");
    assert.equal(line.overCap?.smallerPack?.packQty, 100);
    // 100 units at 7 a day is about 14 days, and 100 units at 3 cents is $3.00.
    assert.equal(line.overCap?.smallerPack?.costCents, 300);
  });

  test("where nobody ships it smaller, it says that instead of implying a choice", () => {
    const line = plan(1000).baskets[0].lines[0];
    assert.equal(line.overCap?.smallerPack, null);
  });

  test("a need the pack covers exactly is not flagged, and says so plainly", () => {
    const line = plan(30).baskets[0].lines[0];
    assert.equal(line.overCap, null);
    assert.match(line.why, /exactly the need/);
  });

  test("a drug that does not move is never over the ceiling, because there is no ceiling to be over", () => {
    const line = planOrder({
      needs: [{ ndc11: "PHEN", name: "Phentermine", needThousandths: 30_000 }],
      offers: [offer({ ndc11: "PHEN", supplier: "McKesson", effectiveUnitMicros: 20_000, packQty: 1000 })],
      terms: [MCK],
      movement: [moves("PHEN", 0, 0)],
      maxDaysOfStock: 14,
      materialityCents: 500,
    }).baskets[0].lines[0];
    assert.equal(line.overCap, null);
  });
});
