import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/*
 * Which suppliers a price file is expected from.
 *
 * Two faults found together on 16 September 2026, while counting what the site asks the owner for.
 * Eighteen rows said "No price file has arrived for this supplier".
 *
 * The costly one: the lookup used `catalogName ?? name` — one name, chosen — and McKesson's row
 * carries the catalogue name "Mck" while the importer files its rows under "McKesson". The primary
 * wholesaler's catalogue, 44,306 items imported three times, was reported as never having arrived.
 *
 * The noisy one: a row existed for every supplier on the register, including seven retired from it
 * and ten he had already said he buys from on their PioneerRx receipt. No catalogue was ever coming
 * from any of them.
 *
 * Every name and number here is invented.
 */
let feedsNow: typeof import("../src/lib/feeds").feedsNow;
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;
let cleanUpDb: (() => void) | null = null;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanUpDb = await useScratchDb();
  ({ feedsNow } = await import("../src/lib/feeds"));
  ({ db, schema } = await import("../src/db"));

  await db.insert(schema.suppliers).values([
    /* The primary, whose catalogue name and importer name disagree — the McKesson shape. */
    { id: "s-prime", name: "Bigco", catalogName: "Big", active: true, primarySupplier: true },
    /* Sends one, under its own name. */
    { id: "s-sends", name: "Sendsco", active: true },
    /* Active, but no catalogue has ever come and it is not primary. */
    { id: "s-quiet", name: "Quietco", active: true, invoiceFromPioneer: true },
    /* Retired from the register entirely. */
    { id: "s-gone", name: "Goneco", active: false },
  ] as never);
  await db.insert(schema.supplierImports).values([
    { id: "imp-1", supplier: "Bigco", fileName: "big.csv", createdBy: "test", createdAt: "2026-09-14T10:00:00.000Z" },
    { id: "imp-2", supplier: "Sendsco", fileName: "sends.csv", createdBy: "test", createdAt: "2026-09-14T10:00:00.000Z" },
  ] as never);
});

after(() => cleanUpDb?.());

const catalogues = async () => (await feedsNow()).feeds.filter((f) => f.key.startsWith("catalogue:"));

describe("a price file is expected from the primary wholesaler and from whoever has sent one", () => {
  test("REGRESSION: the primary's file is found under either of its names", async () => {
    const rows = await catalogues();
    const prime = rows.find((f) => f.label.startsWith("Bigco"));
    assert.ok(prime, "the primary wholesaler has a row");
    assert.notEqual(prime.state, "never", "its file has arrived and must not be reported as never arriving");
    assert.equal(prime.lastAt, "2026-09-14T10:00:00.000Z");
  });

  test("a supplier that sends one is listed", async () => {
    assert.ok((await catalogues()).some((f) => f.label.startsWith("Sendsco")));
  });

  test("REGRESSION: a supplier nobody expects a file from gets no row of its own", async () => {
    const rows = await catalogues();
    assert.equal(rows.some((f) => f.label.startsWith("Quietco")), false, "no catalogue was ever coming from them");
    assert.equal(rows.some((f) => f.label.startsWith("Goneco")), false, "and they are off the register entirely");
  });

  test("but they are counted out loud rather than disappearing", async () => {
    const summary = (await catalogues()).find((f) => f.key === "catalogue:not-expected");
    assert.ok(summary, "a row says how many are not asked after");
    /*
     * One, not two. Quietco is on the register and sends no catalogue, which is the thing being
     * counted; Goneco is retired and is not a supplier of this pharmacy at all, so counting it
     * would be reporting a decision that was made long ago as though it were news.
     */
    assert.match(summary.detail, /1 supplier sends no price file/);
    assert.equal(summary.informational, true, "it reports a state of affairs, so it is not a setup task");
  });

  test("nothing says 'never arrived' any more, because nothing is waiting", async () => {
    assert.equal((await catalogues()).filter((f) => f.state === "never").length, 0);
  });
});
