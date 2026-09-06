import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildLedger } from "../src/lib/product-ledger";
import { underNadac } from "../src/lib/under-nadac";
import { recommendations } from "../src/lib/recommendations";
import { tierEffect, type Band, type Position } from "../src/lib/ratio-effect";
import { groupIntoFills } from "../src/lib/fills";
import { parseRxTransactions, planTransactions } from "../src/lib/rx-transactions";

/**
 * The double-application traps in docs/reference/data-dictionary.md §8, proved across module
 * boundaries rather than inside one. Each figure is worked by hand in the comment and the chain
 * of modules must reproduce it to the cent; a rebate taken twice, a coordinated fill counted twice
 * or a band value folded into a line price would fail here and nowhere else.
 */

describe("the rebate comes off once, from the invoice to the recommendation", () => {
  // Invoice: $100.00 a package of 100 EA, marked rebated at McKesson, tier rate 30%.
  //   gross per unit   = $1.00        = 1,000,000 micros
  //   effective        = $0.70        =   700,000 micros
  // NADAC $1.20 a unit = 1,200,000 micros → gap = 500,000 micros = $0.50 a unit.
  // 1,000 units dispensed over 30 days → $500.00 → $500.00 a month.
  const rows = buildLedger({
    invoiceLines: [{ ndc11: "A", supplier: "McKesson", description: "X 10MG TAB", unitCostCents: 10_000, rebated: true, invoiceDate: "2026-09-01" }],
    catalogue: [{ ndc11: "A", supplier: "pack only", description: null, unitCostMicros: null, packQty: 100, contractFlag: null, pricedOn: null, availability: null }],
    nadac: [{ ndc11: "A", unitMicros: 1_200_000, effectiveOn: "2026-08-26", description: "X 10MG TAB" }],
    claims: [{ ndc11: "A", itemName: null, quantityThousandths: 1_000_000, remitCents: 150_000, copayCents: 0, status: "paid" }],
    contract: { bySupplier: { mckesson: 0.3 }, genericRebateRate: null },
    materialityCents: 500,
  });
  const r = rows[0];

  test("the ledger applies the rate to the per-unit price exactly once", () => {
    assert.equal(r.paid?.unitCostMicros, 1_000_000);
    assert.equal(r.paid?.effectiveUnitMicros, 700_000);
    assert.equal(r.vsNadacMicros, 700_000 - 1_200_000);
  });

  test("the buy list reads the effective price as it is and does not touch the rate again", () => {
    const u = underNadac(rows, () => null);
    assert.equal(u.rows[0].underNadacMicros, 500_000);
    assert.ok(u.rows[0].rebateApplied);
    assert.equal(u.rows[0].worthCents, 50_000);
  });

  test("a second NDC of the same product is compared on effective prices, and the gain is the difference of gaps on the product's units", () => {
    // NDC B: IPC, $0.90 a unit, not rebated, NADAC $1.50 → gap $0.60; A's gap $0.50; A dispensed 1,000.
    // gain = ($0.60 − $0.50) × 1,000 = $100.00, over 30 days → $100.00 a month.
    const rows2 = buildLedger({
      invoiceLines: [{ ndc11: "A", supplier: "McKesson", description: "X 10MG TAB", unitCostCents: 10_000, rebated: true, invoiceDate: "2026-09-01" }],
      catalogue: [
        { ndc11: "A", supplier: "pack only", description: null, unitCostMicros: null, packQty: 100, contractFlag: null, pricedOn: null, availability: null },
        { ndc11: "B", supplier: "IPC", description: "X 10MG TAB", unitCostMicros: 900_000, packQty: 100, contractFlag: "not rebated", pricedOn: "2026-09-01", availability: null },
      ],
      nadac: [
        { ndc11: "A", unitMicros: 1_200_000, effectiveOn: "2026-08-26", description: "X 10MG TAB" },
        { ndc11: "B", unitMicros: 1_500_000, effectiveOn: "2026-08-26", description: "X 10MG TAB" },
      ],
      claims: [{ ndc11: "A", itemName: null, quantityThousandths: 1_000_000, remitCents: 150_000, copayCents: 0, status: "paid" }],
      contract: { bySupplier: { mckesson: 0.3 }, genericRebateRate: null },
      materialityCents: 500,
    });
    const u = underNadac(rows2, () => "X 10MG");
    const x = u.products[0];
    assert.equal(x.pick.ndc11, "B");
    assert.equal(x.current?.ndc11, "A");
    assert.equal(x.gainCents, 10_000);
    const rec = recommendations({ under: u, periodDays: 30 });
    assert.equal(rec.rows[0].amountCents, 10_000);
    // IPC's line carries no rate, so nothing was taken off it: 900,000 stays 900,000.
    assert.equal(x.pick.buy.effectiveUnitMicros, 900_000);
    assert.ok(!x.pick.rebateRateMissing);
  });
});

describe("the band value is an order-level figure and never enters a line price", () => {
  test("changing the band changes bandDeltaCents and nothing per unit", () => {
    const LADDER: Band[] = [{ thresholdPercent: 0, rebatePercent: 15 }, { thresholdPercent: 20, rebatePercent: 25 }];
    const p: Position = { ratioPercent: 20.2, denominatorCents: 4_000_000, definition: "generics_over_rx", scrub: "statement" };
    const e = tierEffect(p, LADDER, [{ cents: 300_000, atPrimary: true, kind: "brand" }], 600_000);
    assert.equal(e.after?.rebatePercent, 15);
    assert.equal(e.bandDeltaCents, -60_000); // (25% − 15%) × $6,000, on the base, not on the $3,000 line
    // The line's own price is untouched by this module: it has no per-unit output at all.
    assert.ok(!("effectiveUnitMicros" in e));
  });
});

describe("a coordinated fill is one bottle", () => {
  // The real shape: a primary that paid nothing and assessed nothing, then a card that paid $46.25
  // and left the patient $115.57; the bottle cost $128.68 on the dispensing row and $0 on the other.
  const base = { fillNumber: 2, dateFilled: "2026-08-31", ndc11: "00074662490", itemName: null, pbmName: null, quantityThousandths: 90_000, status: "paid" };
  const rows = [
    { id: "1", rxNumber: "305766", bin: "610455", payerLabel: "BCBSKS", remitCents: 0, copayCents: 0, patientTotalCents: 0, acquisitionCents: 12_868, ...base },
    { id: "2", rxNumber: "305766", bin: "601341", payerLabel: "OHCP", remitCents: 4_625, copayCents: 11_557, patientTotalCents: 11_557, acquisitionCents: 0, ...base },
  ];
  const [f] = groupIntoFills(rows);

  test("revenue is what the payers remitted plus what the patient was left; cost and quantity are taken once", () => {
    assert.ok(f.coordinated);
    assert.equal(f.remitCents, 4_625);
    assert.equal(f.patientPaidCents, 11_557);
    assert.equal(f.revenueCents, 16_182);
    assert.equal(f.quantityThousandths, 90_000);
  });
});

describe("the daily report: a fill transmitted, reversed and re-billed is one paid claim", () => {
  const HEAD = [
    "Rx Transaction Details By Submission Type (BETA)", "West Wichita Family Pharmacy",
    " Uses invoice cost based on cost for profit settings. Includes columns for estimated rebates and estimated dir fees.Based on claims transmitted/processed from ",
    "9/5/2026 12:00:00 AM, to ,9/6/2026 12:00:00 AM", "Third Party,Script", "Dispensing Fee,Completed Date",
    "Rx Number,Status,Amount,Group,Ntw Reim. Id,Copay,Total,Date Filled,BIN,Tax,QTY,Acq. Inv. Cost,PCN,NDC,GrossProfit", "Transmitted",
  ];
  const text = [
    ...HEAD,
    "Third Party:,003858 (MA) - 003858",
    "400003-1,P,$8.61,2XYA,EN45,$0.00,$10.50,$0.00,,09/05/26,003858,30.0000,$0.70,MA,68180051903,$8.10",
    "400003-1,A,($8.61),2XYA,,$0.00,$0.00,$0.00,,09/05/26,003858,-30.0000,($0.70),MA,68180051903,($8.10)",
    "400003-1,P,$8.61,2XYA,EN45,$0.00,$10.50,$0.00,,09/05/26,003858,30.0000,$0.70,MA,68180051903,$8.10",
    "9/5/2026 1:51 PM,*Evoucher Paid is a portion of the third party total.,Page 1 of 1",
  ].join("\r\n");
  const plan = planTransactions(parseRxTransactions(text).rows, { keys: new Set(), paid: [] });

  test("one paid stands, one is stored reversed with its reversal, nothing is unmatched, and the ingredient identity holds", () => {
    assert.equal(plan.insertPaid.length, 1);
    assert.equal(plan.insertReversedPaid.length, 1);
    assert.equal(plan.insertUnmatchedReversal.length, 0);
    const t = plan.insertPaid[0];
    assert.equal(t.ingredientPaidCents, 861 + 0 - 1050); // Amount + Total − fee: a negative ingredient cost is what a fee-only claim looks like
    assert.equal(t.completedAt, null);
  });
});
