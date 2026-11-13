import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { isGlp1 } from "../src/lib/scrubbed-products";

describe("which products McKesson leaves out of the purchases its brand factor is paid on", () => {
  test("a GLP-1 is recognised by brand or by generic name, in any case", () => {
    for (const d of ["OZEMPIC 1 MG/DOSE PEN", "wegovy 2.4mg", "MOUNJARO 5MG/0.5ML", "Zepbound", "semaglutide inj", "TIRZEPATIDE"]) assert.equal(isGlp1(d), true, d);
  });
  test("ordinary brand and generic lines are not", () => {
    for (const d of ["ATORVASTATIN 20MG TAB", "ELIQUIS 5MG TAB", "LANTUS SOLOSTAR PEN", "", null, undefined]) assert.equal(isGlp1(d as string | null | undefined), false, String(d));
  });
});

describe("the brand purchases a month's rebate is estimated on", () => {
  let cleanup: () => void;
  before(async () => {
    const { useScratchDb } = await import("./support/scratch-db");
    cleanup = await useScratchDb();
    const { db, schema } = await import("../src/db");
    await db.insert(schema.suppliers).values({ id: "mck", name: "Mckesson" });
    await db.insert(schema.supplierInvoices).values({ id: "inv-1", documentId: "doc-1", supplier: "Mckesson", invoiceNumber: "TEST-1", invoiceDate: "2026-09-15", totalCents: 250_000, supplierId: "mck" });
    const line = (i: number, description: string, extendedCents: number, rebated: boolean) =>
      db.insert(schema.invoiceLines).values({ id: `l-${i}`, invoiceId: "inv-1", supplier: "Mckesson", supplierId: "mck", invoiceDate: "2026-09-15", description, quantity: 1, unitCostCents: extendedCents, extendedCents, itemClass: "R", rebated });
    await line(1, "ATORVASTATIN 20MG TAB", 30_000, true);
    await line(2, "ELIQUIS 5MG TAB", 50_000, false);
    await line(3, "OZEMPIC 1 MG/DOSE PEN", 200_000, false);
  });
  after(() => cleanup?.());

  test("GLP-1 lines are counted apart and are not part of the brand figure", async () => {
    const { earningSoFar } = await import("../src/lib/rebate-rates");
    const e = await earningSoFar("mck", "2026-09");
    assert.ok(e);
    assert.equal(e.contractPurchasedCents, 30_000);
    assert.equal(e.brandPurchasedCents, 50_000);
    assert.equal(e.glp1ExcludedCents, 200_000);
    assert.equal(e.totalPurchasedCents, 280_000, "everything bought is still in the total; only the brand base leaves the GLP-1s out");
  });
});
