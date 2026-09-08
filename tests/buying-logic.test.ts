import test from "node:test";
import assert from "node:assert/strict";
import { bestBuy, marginOf, type DrugRow, type SupplierOffer } from "../src/lib/drug-file";
import { problemsWith, packUom } from "../src/lib/catalogue-check";
import { rateForSupplier } from "../src/lib/supplier-match";

/*
 * The buying decision, held to the four things that decide it: the rebate, the expiry date, the
 * pricing unit, and which wholesaler a rate belongs to. Each of these was wrong in a way that
 * pointed an order at the wrong supplier or made a good drug look like a bad one.
 */

const offer = (o: Partial<SupplierOffer> & { supplier: string }): SupplierOffer => ({
  packSize: "100 EA", packUnits: 100, itemNumber: "X1", unitCostMicros: 100_000, netUnitMicros: 100_000,
  rebateApplied: false, rebateWhy: null, packCostCents: 1000, awpCents: 2000, contractFlag: null,
  pricedOn: "2026-09-01", availability: null, corrected: false, withheld: null, problems: [], ...o,
});

const row = (offers: SupplierOffer[], perUnitCents: number | null = null): DrugRow =>
  ({
    ndc11: "00093721698", name: "Amlodipine 10mg", offers, shelf: null,
    nadacUnitMicros: null, nadacPricingUnit: null,
    reimbursement: perUnitCents === null ? null : ({ perUnitCents } as DrugRow["reimbursement"]),
    packFix: null, packDisagreement: null, problems: [], bestPackCostCents: null, equivalence: null,
  }) as DrugRow;

test("the buy is the cheapest net price, not the cheapest printed one", () => {
  // McKesson prints dearer and pays a rebate that makes it the cheaper buy.
  const buy = bestBuy(row([
    offer({ supplier: "McKesson", unitCostMicros: 120_000, netUnitMicros: 90_000, rebateApplied: true }),
    offer({ supplier: "ANDA", unitCostMicros: 100_000, netUnitMicros: 100_000 }),
  ]));
  assert.equal(buy?.supplier, "McKesson");
  assert.equal(buy?.netUnitMicros, 90_000);
});

test("a short-dated lot is never the buy, however cheap", () => {
  const buy = bestBuy(row([
    offer({ supplier: "Smith", netUnitMicros: 40_000, availability: "Short-dated only (exp 09/25)" }),
    offer({ supplier: "ANDA", netUnitMicros: 100_000 }),
  ]));
  // It is stock expiring inside the return window; the ordering side has always refused it.
  assert.equal(buy?.supplier, "ANDA");
});

test("a drug with nothing but short-dated stock has no buy at all, rather than a bad one", () => {
  assert.equal(bestBuy(row([offer({ supplier: "Smith", netUnitMicros: 40_000, availability: "Short-dated only (exp 06/26)" })])), null);
});

test("a withheld price decides nothing", () => {
  // quarantineWrongPrices nulls the price and keeps the row, so the item number survives.
  const buy = bestBuy(row([
    offer({ supplier: "ABC", netUnitMicros: null, unitCostMicros: null, withheld: "listed as 1 EA at $15.39 where four others list 168" }),
    offer({ supplier: "Smith", netUnitMicros: 130_200 }),
  ]));
  assert.equal(buy?.supplier, "Smith");
});

test("the margin is costed at the buy, rebate and all", () => {
  // 30c a unit reimbursed. Printed cheapest is ANDA at 10c; the actual buy is McKesson net at 9c.
  const m = marginOf(row([
    offer({ supplier: "McKesson", unitCostMicros: 120_000, netUnitMicros: 90_000, rebateApplied: true }),
    offer({ supplier: "ANDA", unitCostMicros: 100_000, netUnitMicros: 100_000 }),
  ], 30));
  assert.equal(m?.perUnitCents, 30 - 9);
  assert.equal(m?.percent, (30 - 9) / 30);
});

test("the margin does not quietly cost the drug at a lot that is expiring", () => {
  const m = marginOf(row([
    offer({ supplier: "Smith", netUnitMicros: 40_000, availability: "Short-dated only (exp 09/25)" }),
    offer({ supplier: "ANDA", netUnitMicros: 100_000 }),
  ], 30));
  assert.equal(m?.perUnitCents, 30 - 10);
});

/* ── The benchmark, and the unit it is published in ── */

test("a per-millilitre benchmark is not put beside a per-each price", () => {
  const item = { ndc11: "00093721698", supplier: "Smith", description: "Amoxicillin susp", packSize: "1 EA", unitCostMicros: 8_000_000, packCostCents: 800, awpCents: null, contractFlag: null };
  // NADAC prices this per ML at 2c; the bottle is priced as one each at $8. The ratio is 400x and means nothing.
  const p = problemsWith(item, 20_000, "ML");
  assert.equal(p.some((x) => x.kind === "price_far_from_nadac"), false, "no benchmark fault may be raised across units");
  assert.equal(p.some((x) => x.kind === "nadac_unit_differs"), true, "and the reason is said out loud");
});

test("the benchmark still applies where both are counting the same thing", () => {
  const item = { ndc11: "00093721698", supplier: "Smith", description: "Amlodipine", packSize: "100 EA", unitCostMicros: 8_000_000, packCostCents: 80_000, awpCents: null, contractFlag: null };
  assert.equal(problemsWith(item, 20_000, "EA").some((x) => x.kind === "price_far_from_nadac"), true);
});

test("a pack size that names no unit is not a reason to refuse the benchmark", () => {
  // Nothing to disagree with, so the comparison stands as it always did.
  const item = { ndc11: "00093721698", supplier: "Smith", description: "Amlodipine", packSize: "100", unitCostMicros: 8_000_000, packCostCents: 80_000, awpCents: null, contractFlag: null };
  assert.equal(problemsWith(item, 20_000, "EA").some((x) => x.kind === "price_far_from_nadac"), true);
});

test("the pack's unit is read off the pack size", () => {
  assert.equal(packUom("100 EA"), "EA");
  assert.equal(packUom("(10) 473 ML"), "ML");
  assert.equal(packUom("30 GM"), "GM");
  assert.equal(packUom("100"), null);
  assert.equal(packUom(null), null);
});

/* ── Which wholesaler a rate belongs to ── */

test("the most specific supplier name wins, not the first one recorded", () => {
  // Recorded in the order that used to give the wrong answer.
  const rates = { smith: 0.02, "smith drug co": 0.07 };
  assert.equal(rateForSupplier(rates, "SMITH DRUG CO"), 0.07);
  assert.equal(rateForSupplier(rates, "Smith"), 0.02);
});

test("a two- or three-letter name does not swallow an unrelated wholesaler", () => {
  // "abc" is inside "Fabco Wholesale"; a wrong rate is worse than no rate.
  assert.equal(rateForSupplier({ abc: 0.05 }, "Fabco Wholesale"), null);
  assert.equal(rateForSupplier({ abc: 0.05 }, "ABC"), 0.05, "an exact match is still honoured");
});

test("a wholesaler with no rate on file borrows nobody else's", () => {
  assert.equal(rateForSupplier({ mckesson: 0.06 }, "ANDA"), null);
  assert.equal(rateForSupplier({}, "McKesson"), null);
  assert.equal(rateForSupplier({ mckesson: 0.06 }, null), null);
});

test("spelling differences between the catalogue and the register still match", () => {
  assert.equal(rateForSupplier({ mckesson: 0.06 }, "MCKESSON CONNECT"), 0.06);
  assert.equal(rateForSupplier({ "mckesson corporation": 0.06 }, "McKesson"), 0.06);
});
