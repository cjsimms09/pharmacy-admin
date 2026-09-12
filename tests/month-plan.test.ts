import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { monthPlan, planAtBand, type MonthPlanInput, type Product } from "../src/lib/month-plan";

/**
 * The month decided with every variable at once. The case that matters is the one where the
 * separate answers disagree: line by line the secondary is cheaper on the generics, but moving
 * them off McKesson drops a band that pays more on the whole OneStop base than the lines save.
 * The joint plan keeps them at McKesson; the naive plan does not.
 */
const LADDER = {
  gcr: [{ thresholdPercent: 0, rebatePercent: 15 }, { thresholdPercent: 20, rebatePercent: 25 }, { thresholdPercent: 24, rebatePercent: 29 }],
  gpr: [{ thresholdPercent: 0, rebatePercent: 0 }, { thresholdPercent: 75, rebatePercent: 1 }],
  brand: [{ thresholdPercent: 0, rebatePercent: 0 }, { thresholdPercent: 20, rebatePercent: 0.5 }],
};
const floor = (units: number) => [{ planKey: "medicaid", units, basis: "floor" as const, ratioToNadac: 1, paidPerUnitMicros: null }];

// Position so far: $8,000 generic (all OneStop), $30,000 brand at McKesson: 21.05%, in the 20% band.
const position = { genericCents: 800_000, brandCents: 3_000_000, oneStopCents: 800_000, totalGenericCents: 800_000 };
const suppliers = [{ name: "McKesson", primary: true, minimumCents: 0 }, { name: "IPC", primary: false, minimumCents: 0 }];

// A generic, $1.00 at McKesson OneStop, $0.80 at IPC, NADAC $1.50, 2,000 units this month.
const generic = (key: string): Product => ({
  key, name: key, demandUnits: 2000, onHandUnits: 0, unitsPerDay: 70, mix: floor(2000),
  ndcs: [{ ndc11: key, classification: "G", nadacMicros: 1_500_000, packUnits: 100, offers: [
    { supplier: "McKesson", grossMicros: 1_000_000, earns: "onestop", returnable: true },
    { supplier: "IPC", grossMicros: 800_000, earns: "none", returnable: true },
  ] }],
});

describe("the coupling the separate answers miss", () => {
  const input: MonthPlanInput = { products: [generic("G1"), generic("G2")], ladder: LADDER, position, suppliers };

  test("assuming the 20% band, McKesson's effective price beats IPC, the generics stay, and the ratio lands higher", () => {
    const at20 = planAtBand(structuredClone(input), LADDER.gcr[1], null);
    assert.ok(at20.feasible);
    // At 25%, McKesson effective = $0.75 < IPC $0.80: they stay at McKesson and lift the ratio to 28.6%.
    assert.ok(at20.lines.every((l) => l.supplier === "McKesson"));
    assert.equal(at20.gcrBand?.thresholdPercent, 24);
  });

  test("assuming the bottom band, IPC is cheaper, the generics leave, and the ratio drops with them", () => {
    const at0 = planAtBand(structuredClone(input), LADDER.gcr[0], null);
    // At 15%, McKesson effective = $0.85 > IPC $0.80 → IPC. Ratio: 8,000 / 38,000 = 21.05%: the 20% band,
    // above the assumed 0%, so feasible — and worth less than the plan that keeps them at McKesson.
    assert.ok(at0.lines.every((l) => l.supplier === "IPC"));
    assert.ok(at0.feasible);
    assert.equal(at0.gcrBand?.thresholdPercent, 20);
  });

  test("the joint plan picks the band with the largest total, and says what the next best would have made", () => {
    const plan = monthPlan(input);
    assert.ok(plan.best);
    assert.equal(plan.best.gcrBand?.thresholdPercent, 24);
    // Buying both generics at McKesson: G = 8,000 + 4,000 = 12,000; D = 42,000 → 28.6%: the 24% band.
    assert.ok(plan.best.lines.every((l) => l.supplier === "McKesson"));
    // Rebate at 29% on $12,000 of OneStop = $3,480; GPR at 1% (OS/Gx 100%) on the same = $120; brand factor 0.5% on $30,000 = $150.
    assert.equal(plan.best.rebateCents, 348_000 + 12_000 + 15_000);
    // And it beats buying the generics at IPC: $0.20 a unit saved on 4,000 units is $800, against the band.
    const atIpc = plan.outcomes.find((o) => o.lines.every((l) => l.supplier === "IPC"))!;
    assert.ok(plan.best.totalCents > atIpc.totalCents);
    assert.match(plan.says, /At the 24% band/);
  });
});

describe("the secondary's minimum inside the same plan", () => {
  test("a minimum met by pulling a fast mover forward, or by sending lines back, whichever costs less", () => {
    // One generic where IPC is cheaper even at 29% (McKesson effective $0.71 vs IPC $0.60), IPC minimum $2,500.
    // 2,000 units needed is $1,200 at IPC; $1,300 more is 22 packs, 2,200 units, 21 days of stock at 200 a day.
    const p = generic("G3");
    p.ndcs[0].offers[1].grossMicros = 600_000;
    p.unitsPerDay = 200;
    const input: MonthPlanInput = { products: [p], ladder: LADDER, position, suppliers: [suppliers[0], { name: "IPC", primary: false, minimumCents: 250_000 }], maxPullForwardDays: 30 };
    const plan = monthPlan(input);
    assert.ok(plan.best);
    const ipc = plan.best.lines.filter((l) => l.supplier === "IPC");
    assert.ok(ipc.reduce((n, l) => n + l.grossCents, 0) >= 250_000, plan.best.moves.join(" | "));
    assert.ok(plan.best.moves.some((m) => /pulled forward/.test(m)), plan.best.moves.join(" | "));
  });

  test("a minimum that cannot be met inside the days cap sends the lines back to McKesson and says so", () => {
    const p = generic("G4");
    p.ndcs[0].offers[1].grossMicros = 600_000;
    p.unitsPerDay = 5; // a pack is 20 days; nothing can be pulled inside 7
    p.demandUnits = 100;
    const input: MonthPlanInput = { products: [p], ladder: LADDER, position, suppliers: [suppliers[0], { name: "IPC", primary: false, minimumCents: 500_000 }], maxPullForwardDays: 7 };
    const plan = monthPlan(input);
    assert.ok(plan.best);
    assert.ok(plan.best.lines.every((l) => l.supplier === "McKesson"));
    assert.ok(plan.best.moves.some((m) => /could not be met inside 7 days/.test(m)), plan.best.moves.join(" | "));
  });
});

describe("what it will not guess", () => {
  test("a product whose plans cannot be priced is left out and named; no on-hand is said", () => {
    const p = generic("G5");
    p.mix = [{ planKey: "?", units: 2000, basis: "unknown", ratioToNadac: null, paidPerUnitMicros: null }];
    const plan = monthPlan({ products: [p], ladder: LADDER, position, suppliers });
    assert.ok(plan.blocked.some((b) => /1 product left out/.test(b)));
    assert.ok(plan.blocked.some((b) => /No on-hand quantities/.test(b)));
  });
});
