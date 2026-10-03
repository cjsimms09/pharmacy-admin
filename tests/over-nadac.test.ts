import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { overNadac, overNadacRows, type BoughtLine, type Offer } from "../src/lib/over-nadac";

const A = "00000000001"; // bought over NADAC at McKesson, cheaper at IPC
const B = "00000000002"; // bought under NADAC
const C = "00000000003"; // no NADAC
const D = "00000000004"; // no pack size
const nadac = new Map([
  [A, { unitMicros: 100_000, effectiveOn: "2026-09-02", description: "DRUG A" }],
  [B, { unitMicros: 100_000, effectiveOn: "2026-09-02", description: "DRUG B" }],
  [D, { unitMicros: 100_000, effectiveOn: "2026-09-02", description: "DRUG D" }],
]);
const line = (over: Partial<BoughtLine>): BoughtLine => ({ ndc11: A, supplier: "McKesson", description: "DRUG A 100 CT", itemNumber: "M1", invoiceDate: "2026-09-03", packs: 1, packCostCents: 1_200, rebated: false, ...over });
const offers: Offer[] = [
  { ndc11: A, supplier: "McKesson", effectiveUnitMicros: 120_000, itemNumber: "M1", shortDated: false },
  { ndc11: A, supplier: "IPC", effectiveUnitMicros: 90_000, itemNumber: "I1", shortDated: false },
  { ndc11: A, supplier: "IPD", effectiveUnitMicros: 80_000, itemNumber: "D1", shortDated: true },
];
const base = { packQtyOf: (n: string) => (n === D ? null : 100), nadac, rateOf: () => null, offers, lawUnitsOf: (n: string) => (n === A ? 150 : 0), from: "2026-09-01", to: "2026-09-07" };

describe("bought over NADAC", () => {
  test("one row per NDC per supplier, the gap per unit and in dollars over the window, and where it is cheaper", () => {
    const o = overNadac({ ...base, lines: [line({}), line({ packs: 2, invoiceDate: "2026-09-05", packCostCents: 1_300 }), line({ ndc11: B, packCostCents: 900 })] });
    assert.equal(o.rows.length, 1);
    const [r] = o.rows;
    assert.equal(r.packs, 3);
    assert.equal(r.units, 300);
    assert.equal(r.lastInvoice, "2026-09-05");
    assert.equal(r.invoiceUnitMicros, 130_000, "the latest line's price is the price");
    assert.equal(r.overMicros, 30_000);
    assert.equal(r.overPercent, 30);
    assert.equal(r.overCents, 900, "three cents a unit on 300 units");
    assert.deepEqual(r.elsewhere, { supplier: "IPC", effectiveUnitMicros: 90_000, itemNumber: "I1", underNadac: true }, "the short-dated IPD offer is not the answer");
    assert.equal(r.lawUnits, 150);
    assert.equal(r.lawLossCents, 450, "the gap on the 150 units that went out on plans paying NADAC by law");
    assert.deepEqual(o.underOrAt, { lines: 1, units: 100 });
    assert.equal(o.totals.overCents, 900);
  });

  test("the rebate comes off first, and a rebated line with no rate is compared gross and says so", () => {
    // $1.20 a pack, rebated at 20%: 9.6 cents a unit, under the 10-cent NADAC.
    const o = overNadac({ ...base, rateOf: (s) => (s === "McKesson" ? 0.2 : null), lines: [line({ rebated: true })] });
    assert.equal(o.rows.length, 0);
    assert.equal(o.underOrAt.lines, 1);
    const o2 = overNadac({ ...base, lines: [line({ rebated: true })] });
    assert.equal(o2.rows[0].rebateRateMissing, true);
    assert.equal(o2.rows[0].overCents, 200);
  });

  test("lines outside the window, with no NADAC, or with no pack size are left out and the last two are named", () => {
    const o = overNadac({ ...base, lines: [line({ invoiceDate: "2026-08-20" }), line({ ndc11: C }), line({ ndc11: D })] });
    assert.equal(o.rows.length, 0);
    assert.deepEqual(o.excluded.map((e) => [e.ndc11, e.reason.slice(0, 12)]), [[C, "no NADAC is "], [D, "no catalogue"]]);
  });

  test("the file carries the arithmetic a wholesaler can check", () => {
    const rows = overNadacRows(overNadac({ ...base, lines: [line({})] }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]["Invoice price per unit"], "0.1200");
    assert.equal(rows[0]["NADAC per unit"], "0.1000");
    assert.equal(rows[0]["Dollars over, window"], "2.00");
    assert.equal(rows[0]["Cheaper elsewhere"], "IPC 0.0900 (under NADAC)");
    assert.equal(rows[0]["Rebate"], "none");
  });
});
