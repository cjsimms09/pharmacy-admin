import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { underNadac, buyRowOf, switchNdc, notYetBought } from "../src/lib/under-nadac";
import type { Buy, LedgerRow } from "../src/lib/product-ledger";

/**
 * Which NDCs to buy: furthest under NADAC after the rebate, not cheapest. Two NDCs of one
 * generic: the cheap one with the low NADAC and the dear one with the high NADAC. Under a
 * NADAC-based reimbursement the dear one earns more, and that is the order the list must come in.
 */
const buy = (o: Partial<Buy> = {}): Buy => ({
  supplier: "McKesson", unitCostMicros: 100_000, effectiveUnitMicros: 70_000, rebated: true, source: "invoice", on: "2026-09-01", shortDated: null, ...o,
});
const row = (o: Partial<LedgerRow> = {}): LedgerRow => ({
  ndc11: "A", name: "X 10MG TAB", buys: [], paid: null, best: null, nadacMicros: 120_000, nadacOn: "2026-08-26",
  unitsDispensed: 0, receivedCents: 0, claims: 0, vsNadacMicros: null, switchSavingCents: null, flags: [], ...o,
});
const groups: Record<string, string> = { A: "X 10MG", B: "X 10MG", C: "Y 5MG" };
const groupOf = (n: string) => groups[n] ?? null;

describe("one NDC's gap", () => {
  test("NADAC less the effective cost, with the rebate already off, and the rate applied is said", () => {
    const r = buyRowOf(row({ buys: [buy()], paid: buy(), unitsDispensed: 100 }), null);
    assert.ok("row" in r);
    assert.equal(r.row.underNadacMicros, 50_000);
    assert.equal(r.row.underNadacPercent, 41.7);
    assert.ok(r.row.rebateApplied);
    assert.equal(r.row.worthCents, 500); // $0.05 × 100
    assert.equal(r.row.paidUnderNadacMicros, 50_000);
  });

  test("a rebated line with no rate on file is compared gross and says so", () => {
    const r = buyRowOf(row({ buys: [buy({ effectiveUnitMicros: 100_000 })] }), null);
    assert.ok("row" in r);
    assert.equal(r.row.underNadacMicros, 20_000);
    assert.ok(r.row.rebateRateMissing);
    assert.ok(!r.row.rebateApplied);
  });

  test("the cheapest effective source that is not short-dated is the one to buy", () => {
    const r = buyRowOf(row({ buys: [buy({ supplier: "IPC", effectiveUnitMicros: 60_000, unitCostMicros: 60_000, rebated: false, shortDated: "short-dated only" }), buy({ supplier: "IPD", effectiveUnitMicros: 80_000, unitCostMicros: 80_000, rebated: false }), buy()] }), null);
    assert.ok("row" in r);
    assert.equal(r.row.buy.supplier, "McKesson");
  });

  test("no NADAC, no per-unit price, or only short-dated stock is refused with the reason", () => {
    const a = buyRowOf(row({ nadacMicros: null, buys: [buy()] }), null);
    assert.ok("excluded" in a && /no NADAC/.test(a.excluded.reason));
    const b = buyRowOf(row({ buys: [buy()], flags: ["pack_size_unknown"] }), null);
    assert.ok("excluded" in b && /pack size/.test(b.excluded.reason));
    const c = buyRowOf(row({ buys: [buy({ shortDated: "short-dated only" })] }), null);
    assert.ok("excluded" in c && /short-dated/.test(c.excluded.reason));
    const d = buyRowOf(row(), null);
    assert.ok("excluded" in d && /no price/.test(d.excluded.reason));
  });
});

describe("the list", () => {
  const cheap = row({ ndc11: "A", nadacMicros: 80_000, buys: [buy({ supplier: "IPC", unitCostMicros: 50_000, effectiveUnitMicros: 50_000, rebated: false })], paid: buy({ supplier: "IPC", unitCostMicros: 50_000, effectiveUnitMicros: 50_000, rebated: false }), unitsDispensed: 900, claims: 30 });
  const dear = row({ ndc11: "B", nadacMicros: 200_000, buys: [buy({ unitCostMicros: 128_571, effectiveUnitMicros: 90_000 })], unitsDispensed: 100, claims: 3 });
  const other = row({ ndc11: "C", name: "Y 5MG TAB", nadacMicros: 30_000, buys: [buy({ unitCostMicros: 40_000, effectiveUnitMicros: 28_000 })], paid: buy({ unitCostMicros: 40_000, effectiveUnitMicros: 28_000 }), unitsDispensed: 5000, claims: 200 });
  const u = underNadac([cheap, dear, other], groupOf);

  test("ordered by the gap, not the price: the dear NDC with the high NADAC leads", () => {
    assert.deepEqual(u.rows.map((r) => r.ndc11), ["B", "A", "C"]);
    assert.equal(u.rows[0].underNadacMicros, 110_000);
  });

  test("within a product the widest gap is the pick, and the gain is over the NDC dispensed most, on the product's units", () => {
    const x = u.products.find((p) => p.groupKey === "X 10MG")!;
    assert.equal(x.pick.ndc11, "B");
    assert.equal(x.current?.ndc11, "A");
    assert.equal(x.units, 1000);
    // (110,000 − 30,000) micros × 1,000 units = $80.00
    assert.equal(x.gainCents, 8000);
    assert.equal(x.worthOnProductCents, 11_000);
    assert.match(x.says, /buy B from McKesson .* instead of A/);
  });

  test("products rank by what the pick is worth on their own volume", () => {
    // Y: $0.002 × 5,000 = $10; X: $110 on 1,000 units.
    assert.deepEqual(u.products.map((p) => p.groupKey), ["X 10MG", "Y 5MG"]);
    assert.equal(u.products[1].gainCents, 0);
    assert.match(u.products[1].says, /worth \$10\.00 on 5,000 units/);
  });

  test("the switch list holds only products where a different NDC clears the line", () => {
    assert.deepEqual(switchNdc(u).map((p) => p.groupKey), ["X 10MG"]);
    assert.deepEqual(switchNdc(u, 10_000), []);
  });

  test("what is not stocked: offered well under NADAC, never bought, never dispensed", () => {
    const shelf = row({ ndc11: "D", name: "Z", nadacMicros: 100_000, buys: [buy({ supplier: "IPD", unitCostMicros: 40_000, effectiveUnitMicros: 40_000, rebated: false, source: "catalogue" })] });
    const u2 = underNadac([cheap, shelf], groupOf);
    assert.deepEqual(notYetBought(u2).map((r) => r.ndc11), ["D"]);
    assert.match(u2.products.find((p) => p.groupKey === "ndc:D")!.says, /not dispensed in the period/);
  });

  test("the refused are named, never silently dropped", () => {
    const u3 = underNadac([cheap, row({ ndc11: "E", nadacMicros: null, buys: [buy()] })], groupOf);
    assert.equal(u3.excluded.length, 1);
    assert.equal(u3.excluded[0].ndc11, "E");
  });
});
