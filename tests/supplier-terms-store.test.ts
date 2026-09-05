import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * Two rebate programmes, one supplier, one date.
 *
 * McKesson pays on two ladders at once: a generic compliance rate and a generic purchase ratio,
 * both effective the same month. A version was identified by its supplier and its date alone, so
 * filing the second silently replaced the first — and the one lost was the compliance ladder, the
 * only one that actually pays. Nothing said so; the supplier's card simply showed one programme
 * where there should have been two. These tests run against the real store because that is where
 * the bug was: the shape was right, the key was wrong.
 */
const tiers = (a: number, b: number) => ({
  kind: "tiered_ratio" as const,
  period: "month" as const,
  eligibility: "catalog_rebate_flag" as const,
  ratioDefinition: null,
  tiers: [{ thresholdPercent: a, rebatePercent: b }],
  paidAs: null,
  notes: null,
});

let supplierId = "";
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let store: typeof import("../src/lib/supplier-terms-store");

before(async () => {
  ({ db, schema } = await import("../src/db"));
  store = await import("../src/lib/supplier-terms-store");
  const { newId } = await import("../src/lib/crypto");
  supplierId = newId();
  await db.insert(schema.suppliers).values({ id: supplierId, name: `Test wholesaler ${supplierId.slice(0, 6)}` });
});

after(async () => {
  const { eq } = await import("drizzle-orm");
  await db.delete(schema.supplierRebatePrograms).where(eq(schema.supplierRebatePrograms.supplierId, supplierId));
  await db.delete(schema.suppliers).where(eq(schema.suppliers.id, supplierId));
});

describe("more than one rebate programme for one supplier", () => {
  test("two programmes effective the same day both survive", async () => {
    await store.saveRebateProgram(supplierId, { name: "Compliance ladder", effectiveFrom: "2025-05-01" }, tiers(0, 15), { name: "test" });
    await store.saveRebateProgram(supplierId, { name: "Purchase ratio ladder", effectiveFrom: "2025-05-01" }, tiers(75, 1), { name: "test" });

    const rows = await store.rebateProgramsFor(supplierId);
    assert.equal(rows.length, 2, "the second must not replace the first");
    assert.deepEqual(rows.map((r) => r.name).sort(), ["Compliance ladder", "Purchase ratio ladder"]);
  });

  test("the same programme filed again on the same date is a correction, not a second copy", async () => {
    await store.saveRebateProgram(supplierId, { name: "Compliance ladder", effectiveFrom: "2025-05-01" }, tiers(0, 16), { name: "test" });
    const rows = await store.rebateProgramsFor(supplierId);
    assert.equal(rows.length, 2, "still two programmes");
    const { readRebateTerms } = await import("../src/lib/supplier-terms");
    const compliance = rows.find((r) => r.name === "Compliance ladder")!;
    assert.equal(readRebateTerms(compliance.termsJson)!.tiers[0].rebatePercent, 16, "corrected in place");
  });

  test("a new month closes only the earlier version of that same programme", async () => {
    await store.saveRebateProgram(supplierId, { name: "Compliance ladder", effectiveFrom: "2025-06-01" }, tiers(0, 17), { name: "test" });
    const rows = await store.rebateProgramsFor(supplierId);
    const compliance = rows.filter((r) => r.name === "Compliance ladder");
    const ratio = rows.filter((r) => r.name === "Purchase ratio ladder");
    assert.equal(compliance.length, 2, "May and June");
    assert.equal(compliance.find((r) => r.effectiveFrom === "2025-05-01")!.effectiveTo, "2025-05-31", "May closed the day before June");
    // The other programme is untouched: it did not change, so it is still in force.
    assert.equal(ratio.length, 1);
    assert.equal(ratio[0].effectiveTo, null, "the purchase-ratio ladder must not be closed by a change to the other one");
  });

  test("the one that prices a purchase is the one that says which purchases it applies to", async () => {
    // Both ladders are in force. Only the compliance one names the items it pays on — the
    // catalogue's own contract flag — so it is the one that can price a line. Returning the other
    // would price a generic against a ladder paying nothing below a 75% ratio.
    await store.saveRebateProgram(
      supplierId,
      { name: "Purchase ratio ladder", effectiveFrom: "2025-06-01" },
      { ...tiers(75, 1), eligibility: "all_generics" as const },
      { name: "test" },
    );
    const june = await store.currentRebateProgram(supplierId, "2025-06-15");
    assert.ok(june);
    assert.equal(june!.row.name, "Compliance ladder");
    assert.equal(june!.terms.tiers[0].rebatePercent, 17);

    const all = await store.rebateProgramsInForce(supplierId, "2025-06-15");
    assert.equal(all.length, 2, "both are still in force and both can be listed");
  });
});
