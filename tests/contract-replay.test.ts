import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { replayContracts, headToHead, type ReplayContract } from "../src/lib/contract-replay";
import type { RebateTermsT } from "../src/lib/supplier-terms";

/**
 * A year of dispensing replayed through two wholesalers' contracts, worked by hand.
 *
 * Two products: amlodipine (generic, three NDCs) and a brand. McKesson sells amlodipine at $0.10
 * and $0.12 a tablet and flags the $0.10 one OneStop; IPC sells one NDC at $0.09 and does not
 * sell the brand. McKesson pays a 4% ladder at 20% compliance and 7% at 30%; IPC pays 3% flat on
 * generics.
 */
const ladder = (over: Partial<RebateTermsT> = {}): RebateTermsT => ({
  kind: "tiered_ratio",
  period: "month",
  eligibility: "catalog_rebate_flag",
  ratioMeasure: "generic_compliance",
  ratioDefinition: null,
  tiers: [
    { thresholdPercent: 0, rebatePercent: 0 },
    { thresholdPercent: 20, rebatePercent: 4 },
    { thresholdPercent: 30, rebatePercent: 7 },
  ],
  paidAs: null,
  notes: null,
  ...over,
});

const contracts: ReplayContract[] = [
  { supplier: "McKesson", supplierId: "m", programmes: [{ name: "OneStop", terms: ladder() }] },
  { supplier: "IPC", supplierId: "i", programmes: [{ name: "Generic flat", terms: ladder({ kind: "flat_percent", eligibility: "all_generics", tiers: [{ thresholdPercent: 0, rebatePercent: 3 }] }) }] },
  { supplier: "NoTerms", supplierId: "n", programmes: [] },
];

const products = [
  { ndc11: "10000000001", groupKey: "AMLODIPINE 5MG TAB|G|EA|RX", classification: "G" as const },
  { ndc11: "10000000002", groupKey: "AMLODIPINE 5MG TAB|G|EA|RX", classification: "G" as const },
  { ndc11: "10000000003", groupKey: "AMLODIPINE 5MG TAB|G|EA|RX", classification: "G" as const },
  { ndc11: "20000000001", groupKey: "BRANDX 10MG TAB|B|EA|RX", classification: "B" as const },
  { ndc11: "30000000001", groupKey: null, classification: null },
];

const offers = [
  { supplier: "McKesson", ndc11: "10000000001", unitCostMicros: 100_000, rebated: true, description: "AMLODIPINE 5MG TAB" },
  { supplier: "McKesson", ndc11: "10000000002", unitCostMicros: 120_000, rebated: false },
  { supplier: "McKesson", ndc11: "20000000001", unitCostMicros: 3_000_000, rebated: false, description: "BRANDX 10MG TAB" },
  { supplier: "IPC", ndc11: "10000000003", unitCostMicros: 90_000, rebated: null },
  { supplier: "NoTerms", ndc11: "10000000002", unitCostMicros: 110_000, rebated: null },
  { supplier: "NoTerms", ndc11: "20000000001", unitCostMicros: 2_900_000, rebated: null },
];

// January: 1,000 amlodipine tablets (dispensed as NDC ...002, which McKesson would replace with ...001), and 100 brand tablets.
const fills = [
  { dateFilled: "2026-01-05", ndc11: "10000000002", quantityThousandths: 600_000 },
  { dateFilled: "2026-01-20", ndc11: "10000000002", quantityThousandths: 400_000 },
  { dateFilled: "2026-01-12", ndc11: "20000000001", quantityThousandths: 100_000 },
  { dateFilled: "2026-01-15", ndc11: "30000000001", quantityThousandths: 30_000 },
];

describe("replaying a year of dispensing through each contract", () => {
  const r = replayContracts({ fills, products, offers, contracts, minCoverage: 0.9 });

  test("each fill is priced at the supplier's cheapest equivalent, not the NDC dispensed", () => {
    const mck = r.suppliers.find((s) => s.supplier === "McKesson")!;
    // 1,000 tablets at $0.10 (the OneStop NDC, not the $0.12 one dispensed) = $100; 100 brand at $3 = $300.
    assert.equal(mck.grossCents, 10_000 + 30_000);
    const jan = mck.months[0];
    assert.equal(jan.genericCents, 10_000);
    assert.equal(jan.brandCents, 30_000);
    assert.equal(jan.flaggedCents, 10_000);
    assert.equal(mck.coverage.matched, 3);
    assert.equal(r.unplaceable, 1, "the NDC with no product key is in nobody's figures");
  });

  test("the ladder is measured on the replayed month and paid on what the programme calls eligible", () => {
    const mck = r.suppliers.find((s) => s.supplier === "McKesson")!;
    const p = mck.months[0].programmes[0];
    // Compliance = flagged $100 over gross $400 = 25% → the 4% tier, on the $100 flagged.
    assert.equal(p.ratioPercent, 25);
    assert.equal(p.tierPercent, 4);
    assert.equal(p.rebateCents, 400);
    assert.equal(mck.netCents, 40_000 - 400);
  });

  test("a flat programme pays its rate on the eligible spend; no terms means no rebate, and says so", () => {
    const ipc = r.suppliers.find((s) => s.supplier === "IPC")!;
    assert.equal(ipc.grossCents, 9_000, "1,000 tablets at $0.09; the brand is unmatched");
    assert.equal(ipc.rebateCents, 270);
    assert.equal(ipc.unmatched.fills, 1);
    assert.equal(ipc.coverage.share, 2 / 3);
    const none = r.suppliers.find((s) => s.supplier === "NoTerms")!;
    assert.equal(none.rebateCents, 0);
    assert.equal(none.netCents, 11_000 + 29_000);
    assert.match(none.says, /no rebate terms on file/);
  });

  test("the ranking is among suppliers covering enough of the fills, cheapest net first", () => {
    assert.deepEqual(r.ranking.map((x) => `${x.supplier}:${x.eligible}`), ["McKesson:true", "NoTerms:true", "IPC:false"]);
    assert.match(r.says, /McKesson is cheapest at \$396 net/);
    assert.match(r.says, /NoTerms would cost \$4 more/);
  });

  test("head to head compares only the products both can supply", () => {
    const h = headToHead(r, "McKesson", "IPC")!;
    assert.equal(h.products.length, 1);
    assert.equal(h.aCents, 10_000);
    assert.equal(h.bCents, 9_000);
  });
});
