import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { nearestBand, summariseEarnings } from "../src/lib/money-position";

/**
 * The three figures the pharmacy is actually run on, and the two pieces of arithmetic behind them
 * that can be wrong quietly.
 *
 * A rebate total is a number somebody prices an order against. Wrong high, it justifies buying from
 * the wrong supplier all month; wrong low, it hides that a band is within reach. Neither announces
 * itself, so both are pinned here by hand.
 */

const earning = (over: Partial<Parameters<typeof summariseEarnings>[0][number]> = {}) => ({
  supplierId: "s1",
  supplierName: "McKesson",
  estimatedRebateCents: 10_000,
  totalPurchasedCents: 100_000,
  unmarkedPurchasedCents: 0,
  unmarkedLines: 0,
  ...over,
});

describe("the nearest band worth chasing", () => {
  test("the closest rung across every ladder, not the first one listed", () => {
    /*
     * McKesson runs several ladders on the same items. The one to put on screen is the one this
     * month's buying can still reach — naming a rung eleven points away when another is half a
     * point away tells the pharmacist to give up on something they could have had.
     */
    const n = nearestBand([
      { fromPercent: 90, rebatePercent: 32, shortByPercent: 11.2, worthCents: 40_000 },
      { fromPercent: 75, rebatePercent: 31, shortByPercent: 0.51, worthCents: 1_200 },
    ]);
    assert.equal(n?.rebatePercent, 31);
    assert.equal(n?.shortByPercent, 0.51);
  });

  test("a ladder already at the top contributes nothing rather than a zero", () => {
    assert.equal(nearestBand([null, null]), null);
    assert.equal(nearestBand([]), null);
  });
});

describe("what this month's buying is earning", () => {
  test("added across the suppliers actually bought from", () => {
    const r = summariseEarnings(
      [
        earning({ supplierId: "mck", supplierName: "McKesson", estimatedRebateCents: 30_000, totalPurchasedCents: 100_000 }),
        earning({ supplierId: "ipc", supplierName: "IPC", estimatedRebateCents: 2_500, totalPurchasedCents: 20_000 }),
      ],
      "2026-09",
    );
    assert.equal(r.estimatedCents, 32_500);
    assert.equal(r.purchasedCents, 120_000);
    assert.equal(r.bySupplier.map((s) => s.supplierName).join(","), "McKesson,IPC", "biggest earner first");
    assert.equal(r.incomplete, false);
  });

  test("a supplier not bought from this month is left off, not shown at zero", () => {
    /*
     * A list of every supplier on file at $0.00 buries the two that matter, which is how a screen
     * meant to show a position turns into a directory.
     */
    const r = summariseEarnings([earning(), earning({ supplierId: "x", supplierName: "Unused", totalPurchasedCents: 0, estimatedRebateCents: 0 })], "2026-09");
    assert.equal(r.bySupplier.length, 1);
    assert.equal(r.bySupplier[0].supplierName, "McKesson");
  });

  test("a supplier whose ladder cannot price the buying makes the total incomplete, and says so", () => {
    /*
     * The dangerous failure. Dropped silently, the total is simply too low and reads as a real
     * figure — so the buying looks less rewarding than it is and nobody ever finds out why.
     */
    const r = summariseEarnings(
      [earning({ estimatedRebateCents: 30_000 }), earning({ supplierId: "new", supplierName: "New wholesaler", estimatedRebateCents: null, totalPurchasedCents: 50_000 })],
      "2026-09",
    );
    assert.equal(r.estimatedCents, 30_000, "nothing is invented for the supplier with no ladder");
    assert.equal(r.purchasedCents, 150_000, "but its buying is still counted, so the gap is visible");
    assert.equal(r.incomplete, true);
  });

  test("lines the invoice never marked earn nothing here, and are counted so they can be chased", () => {
    /*
     * The rebate is paid on the supplier's own marking. A line the invoice did not flag either way
     * is not guessed into a bucket — it contributes nothing and is named, because the fix is to get
     * the marking onto the invoice rather than to estimate around it.
     */
    const r = summariseEarnings([earning({ unmarkedPurchasedCents: 40_000, unmarkedLines: 7 })], "2026-09");
    assert.equal(r.unmarkedCents, 40_000);
    assert.equal(r.unmarkedLines, 7);
  });

  test("a month with no invoices loaded is zero, not an error", () => {
    const r = summariseEarnings([null, null], "2026-09");
    assert.equal(r.estimatedCents, 0);
    assert.equal(r.purchasedCents, 0);
    assert.equal(r.incomplete, false);
    assert.deepEqual(r.bySupplier, []);
  });
});
