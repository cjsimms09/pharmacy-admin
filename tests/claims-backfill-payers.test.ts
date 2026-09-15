import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * A two-payer fill written in from PioneerRx is two claims, one per payer, as the daily report would have sent them.
 *
 * Before 15 September the backfill wrote one row per fill with both plans' money summed under the first plan's BIN
 * (30 September rows at the time). The second plan then owed nothing anybody could see, and a payment from it had no
 * claim to settle. Nothing is imported at the top: the database is fixed on first import (see tests/support/scratch-db.ts).
 */
let backfill: typeof import("../src/lib/claims-backfill").backfillClaimsFromPioneer;
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let cleanUpDb: (() => void) | null = null;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ({ backfillClaimsFromPioneer: backfill } = await import("../src/lib/claims-backfill"));
  ({ db, schema } = await import("../src/db"));
});

after(() => cleanUpDb?.());

const fill = {
  rxNumber: "900300",
  fillNumber: 0,
  filledOn: "2026-09-08",
  soldOn: "2026-09-08",
  ndc11: "00093505698",
  itemName: "EXAMPLE 10 MG TABLET",
  bin: "610097",
  pcn: "EX",
  groupNumber: "G1",
  networkId: "N1",
  quantityThousandths: 30_000,
  daysSupply: 30,
  insuranceCents: 18_914 + 5_961,
  patientCents: 500,
  acquisitionCents: 12_000,
  dispensingFeeCents: 150,
  fillTotalPriceCents: 18_914 + 5_961 + 500,
  payers: [
    { position: "primary" as const, bin: "610097", pcn: "EX", groupNumber: "G1", networkId: "N1", remitCents: 18_914, patientCents: 0, evoucherCents: null, dirFeeCents: null },
    { position: "secondary" as const, bin: "610097", pcn: "EX", groupNumber: "G1", networkId: "N1", remitCents: 5_961, patientCents: 500, evoucherCents: null, dirFeeCents: null },
  ],
};

describe("a fill the report never sent, written from PioneerRx", () => {
  test("one row per payer, each with its own money and position; the fill's cost and price on the primary only", async () => {
    const r = await backfill([fill], "2026-09-01", "the test");
    assert.equal(r.written, 1, "one fill written");
    const rows = await db.select().from(schema.claims);
    const mine = rows.filter((c) => c.rxNumber === "900300").sort((a, b) => (a.payerPosition ?? "").localeCompare(b.payerPosition ?? ""));
    assert.deepEqual(
      mine.map((c) => [c.payerPosition, c.remitCents, c.copayCents, c.acquisitionCents, c.fillTotalPriceCents]),
      [
        ["primary", 18_914, 0, 12_000, 25_375],
        ["secondary", 5_961, 500, null, null],
      ],
    );
    const sum = (k: "remitCents" | "copayCents" | "acquisitionCents") => mine.reduce((n, c) => n + (c[k] ?? 0), 0);
    assert.equal(sum("remitCents") + sum("copayCents"), fill.fillTotalPriceCents, "the rows add to the fill's price");
    assert.equal(sum("acquisitionCents"), 12_000, "the bottle is costed once");
  });

  test("the same fill again writes nothing", async () => {
    const r = await backfill([fill], "2026-09-01", "the test");
    assert.equal(r.written, 0);
    assert.equal(r.alreadyHeld, 1);
  });
});
