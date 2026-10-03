import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { priceMoves, priceAlerts, type PricePoint, type NdcUsage } from "../src/lib/price-moves";

/**
 * What moved this week, on this pharmacy's own units. Round figures, checked by hand:
 * micros are dollars × 1,000,000; a month is thirty days.
 */
const P = (ndc11: string, supplier: string, on: string, dollars: number, extra: Partial<PricePoint> = {}): PricePoint => ({ ndc11, supplier, on, unitMicros: Math.round(dollars * 1_000_000), ...extra });
const U = (ndc11: string, unitsPerDay: number, floorShare: number | null = 0.5, groupKey: string | null = "atorva-20"): NdcUsage => ({ ndc11, name: `Drug ${ndc11}`, unitsPerDay, floorShare, groupKey });

describe("the moves themselves", () => {
  test("the last two prices at a supplier are the move; same-day duplicates and unchanged prices are not", () => {
    const moves = priceMoves([
      P("A", "McKesson", "2026-08-24", 1.0), P("A", "McKesson", "2026-08-31", 1.0), P("A", "McKesson", "2026-09-07", 1.2),
      P("A", "McKesson", "2026-09-07", 1.25), // a re-import the same day: the later wins
      P("B", "McKesson", "2026-08-31", 2.0), P("B", "McKesson", "2026-09-07", 2.0), // unchanged
      P("C", "IPC", "2026-09-07", 3.0), // one point: no move
    ]);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].ndc11, "A");
    assert.equal(moves[0].from.unitMicros, 1_000_000);
    assert.equal(moves[0].to.unitMicros, 1_250_000);
    assert.equal(moves[0].percent, 25);
  });

  test("a short-dated offer is not a price", () => {
    const moves = priceMoves([P("A", "IPC", "2026-08-31", 1.0), P("A", "IPC", "2026-09-07", 0.5, { shortDated: true })]);
    assert.equal(moves.length, 0);
  });

  test("the rebate comes off once: the effective price is the move where it is given", () => {
    const [m] = priceMoves([P("A", "McKesson", "2026-08-31", 1.0, { effectiveUnitMicros: 750_000 }), P("A", "McKesson", "2026-09-07", 1.0, { effectiveUnitMicros: 800_000 })]);
    assert.equal(m.deltaMicros, 50_000);
  });
});

describe("a rise in what the pharmacy would pay", () => {
  test("costed on the cheapest source before and after, on this pharmacy's units, for a month", () => {
    // Cheapest was McKesson $1.00; now McKesson $1.20 and IPC $1.10, so the pharmacy's cost rose $0.10.
    // 100 units a day × $0.10 × 30 = $300.
    const { rows } = priceAlerts({
      history: [P("A", "McKesson", "2026-08-31", 1.0), P("A", "IPC", "2026-08-31", 1.1), P("A", "McKesson", "2026-09-07", 1.2), P("A", "IPC", "2026-09-07", 1.1)],
      usage: [U("A", 100)],
      minMonthlyCents: 100,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, "price-up:A");
    assert.equal(rows[0].amountCents, 30_000);
    assert.equal(rows[0].cadence, "recurring_monthly");
    assert.match(rows[0].says, /\$300\.00 a month more/);
    assert.match(rows[0].says, /IPC at \$1\.1000 a unit from 2026-09-07, against \$1\.0000 at McKesson on 2026-08-31/);
    assert.match(rows[0].basis, /100\.0 units a day/);
  });

  test("a rise at one supplier while another still lists the old price costs nothing", () => {
    const { rows, quiet } = priceAlerts({
      history: [P("A", "McKesson", "2026-08-31", 1.0), P("A", "IPC", "2026-08-31", 1.0), P("A", "McKesson", "2026-09-07", 1.5), P("A", "IPC", "2026-09-07", 1.0)],
      usage: [U("A", 100)],
    });
    assert.equal(rows.length, 0);
    assert.equal(quiet.length, 0);
  });

  test("the instruction names a cheaper NDC of the same product, with what it gets back", () => {
    // Cost rose to $1.20; NDC B of the same product is $0.90 at IPD: 100 units × $0.30 × 30 = $900 back.
    const { rows } = priceAlerts({
      history: [P("A", "McKesson", "2026-08-31", 1.0), P("A", "McKesson", "2026-09-07", 1.2)],
      usage: [U("A", 100)],
      alternatives: [{ ndc11: "B", name: "Drug B", supplier: "IPD", effectiveUnitMicros: 900_000, groupKey: "atorva-20" }, { ndc11: "Z", name: "Other", supplier: "IPD", effectiveUnitMicros: 100_000, groupKey: "other" }],
    });
    assert.match(rows[0].todo, /Buy Drug B from IPD at \$0\.9000 instead: \$900\.00 a month back/);
  });

  test("a product nobody dispenses, a cent of rounding, or a few dollars a month is quiet, and says why", () => {
    const { rows, quiet } = priceAlerts({
      history: [
        P("A", "McKesson", "2026-08-31", 1.0), P("A", "McKesson", "2026-09-07", 1.2), // not dispensed
        P("B", "McKesson", "2026-08-31", 10.0), P("B", "McKesson", "2026-09-07", 10.05), // 0.5%
        P("C", "McKesson", "2026-08-31", 1.0), P("C", "McKesson", "2026-09-07", 1.1), // 1 unit a day: $3 a month
      ],
      usage: [U("B", 100), U("C", 1)],
    });
    assert.equal(rows.length, 0);
    assert.equal(quiet.length, 2);
    assert.match(quiet[0].says, /under the 1% line/);
    assert.match(quiet[1].says, /\$3\.00 a month/);
  });
});

describe("NADAC falling under cost", () => {
  const history = [P("A", "McKesson", "2026-08-31", 1.0), P("A", "McKesson", "2026-09-07", 1.0)];

  test("a transition, costed on the units paid at NADAC where the share is known", () => {
    // NADAC $1.10 → $0.90 against a cost of $1.00: $0.10 under on half of 200 units a day × 30 = $300.
    const { rows } = priceAlerts({
      history,
      nadac: [{ ndc11: "A", on: "2026-08-31", unitMicros: 1_100_000 }, { ndc11: "A", on: "2026-09-07", unitMicros: 900_000 }],
      usage: [U("A", 200, 0.5)],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, "under-cost:A");
    assert.equal(rows[0].amountCents, 30_000);
    assert.equal(rows[0].confidence, "likely");
    assert.match(rows[0].says, /NADAC fell to \$0\.9000 on 2026-09-07 from \$1\.1000/);
    assert.match(rows[0].basis, /100\.0 of 200\.0 units a day/);
  });

  test("with the plans unclassified, every unit is counted and the row says it is a ceiling", () => {
    const { rows } = priceAlerts({
      history,
      nadac: [{ ndc11: "A", on: "2026-08-31", unitMicros: 1_100_000 }, { ndc11: "A", on: "2026-09-07", unitMicros: 900_000 }],
      usage: [U("A", 200, null)],
    });
    assert.equal(rows[0].amountCents, 60_000);
    assert.equal(rows[0].confidence, "worth checking");
    assert.match(rows[0].says, /if every unit is paid at NADAC/);
  });

  test("standing under cost is the buy list's business, not a move", () => {
    const { rows } = priceAlerts({
      history,
      nadac: [{ ndc11: "A", on: "2026-08-31", unitMicros: 800_000 }, { ndc11: "A", on: "2026-09-07", unitMicros: 700_000 }],
      usage: [U("A", 200, 0.5)],
    });
    assert.equal(rows.length, 0);
  });

  test("a cost rise can be the cause as well, and the two rows say they overlap", () => {
    // NADAC steady at $1.05; cost $1.00 → $1.20. Both a rise and a crossing: one problem, two rows, marked.
    const { rows } = priceAlerts({
      history: [P("A", "McKesson", "2026-08-31", 1.0), P("A", "McKesson", "2026-09-07", 1.2)],
      nadac: [{ ndc11: "A", on: "2026-08-31", unitMicros: 1_050_000 }],
      usage: [U("A", 100, 1)],
    });
    assert.equal(rows.length, 2);
    const under = rows.find((r) => r.key === "under-cost:A")!;
    assert.match(under.says, /the cost rose to \$1\.2000 at McKesson/);
    assert.ok(under.overlapsWith?.includes("price-up:A"));
    // $0.15 under × 100 × 30 = $450; the rise row is $0.20 × 100 × 30 = $600.
    assert.equal(under.amountCents, 45_000);
    assert.equal(rows.find((r) => r.key === "price-up:A")!.amountCents, 60_000);
  });

  test("the instruction is a switch when an NDC under the new NADAC exists, otherwise stop or appeal", () => {
    const nadac = [{ ndc11: "A", on: "2026-08-31", unitMicros: 1_100_000 }, { ndc11: "A", on: "2026-09-07", unitMicros: 900_000 }];
    const withAlt = priceAlerts({ history, nadac, usage: [U("A", 200, 1)], alternatives: [{ ndc11: "B", name: "Drug B", supplier: "IPC", effectiveUnitMicros: 850_000, groupKey: "atorva-20" }] });
    assert.match(withAlt.rows[0].todo, /Switch to Drug B from IPC at \$0\.8500/);
    const without = priceAlerts({ history, nadac, usage: [U("A", 200, 1)], alternatives: [{ ndc11: "B", name: "Drug B", supplier: "IPC", effectiveUnitMicros: 950_000, groupKey: "atorva-20" }] });
    assert.match(without.rows[0].todo, /Stop stocking it for floor-plan fills, or appeal/);
  });
});
