import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { wholePackage } from "../src/lib/catalogue-cache";
import { packQtyOf } from "../src/lib/product-ledger";

/*
 * The pack an appeal divides an invoice price by.
 *
 * `appeals.ts invoicesFor` turns the invoice's per-package price into the per-unit acquisition cost
 * the pharmacy submits to a PBM. It read `supplier_items.pack_size` straight out of the table and
 * handed it to `packQtyOf`, and `packQtyOf` drops the bracket. On a multi-pack — McKesson, ANDA and
 * ParMed write them as "(5) 1 ML" — that states an acquisition cost five times what was paid, in a
 * document whose whole purpose is to say what the drug cost.
 *
 * Neither function is wrong on its own. `packQtyOf` is right about a levelled row, where there is
 * no bracket left to drop. The fault was composing them in the wrong order, and that is what these
 * tests hold: what the catalogue levels is safe to divide by, and what it could not level must not
 * be divided by at all.
 *
 * Same shape of fault as the one the catalogue proof turned up on 9 September in `minimum-store.ts`,
 * and the same fix — read the levelled catalogue, like the shelf and the buy list do.
 */

const row = (a: Partial<Parameters<typeof wholePackage>[0]> = {}) => ({
  ndc11: "76204001155", supplier: "McKesson", description: "Albuterol", productKey: null,
  packSize: "(5) 1 ML", unitCostMicros: 6_250_000, packCostCents: 1_875, awpCents: null,
  contractFlag: null, availability: null, pricedOn: null, ...a,
});

/** What the appeal page now refuses. Kept here so the test and the guard say the same thing. */
const BRACKETED = /\(\d+\)\s*[\d.]+\s*(?:EA|ML|GM)\b/i;

describe("the pack an appeal divides by", () => {
  test("the raw table is refused now, and the fault it used to cause was five times over", () => {
    const raw = row().packSize;
    assert.equal(packQtyOf(raw), null, "a multi-pack bracket means this was never levelled");

    /*
     * What the old answer cost, kept as arithmetic so the size of it is on the record.
     *
     * $18.75 for the box. Levelled it is 5 mL at $3.75. `packQtyOf` used to drop the bracket and
     * answer 1, so the same box priced as 1 mL at $18.75 — and that figure went into an appeal as
     * what the drug cost the pharmacy.
     */
    const perPackageCents = 1_875;
    const wasAnswered = 1;
    const wrong = Math.round((perPackageCents * 10_000) / wasAnswered);
    const right = Math.round((perPackageCents * 10_000) / packQtyOf(wholePackage(row()).packSize)!);
    assert.equal(right, 3_750_000, "$18.75 over 5 mL is $3.75");
    assert.equal(wrong, 18_750_000);
    assert.equal(wrong / right, 5, "the appeal would have claimed five times what the pharmacy paid");
  });

  test("levelled first, the same two functions agree with the invoice", () => {
    const levelled = wholePackage(row());
    assert.equal(levelled.packSize, "5 ML");
    assert.equal(packQtyOf(levelled.packSize), 5);
  });

  test("a row without a bracket was already whole and is unchanged either way", () => {
    const plain = row({ packSize: "30 EA", packCostCents: 3_000 });
    assert.equal(packQtyOf(wholePackage(plain).packSize), 30);
    assert.equal(packQtyOf(plain.packSize), 30);
  });

  test("a levelled row can still carry a bracket, and that one is refused too", () => {
    /*
     * The residual case, and the reason the refusal lives in `packQtyOf` rather than in a check the
     * appeal page makes on its own. A listing that prints no pack total gives `wholePackage` nothing
     * to divide, so it returns the row exactly as it came — bracket and all — and reading the
     * levelled catalogue is not on its own enough to be safe.
     */
    const unsettled = wholePackage(row({ packCostCents: null }));
    assert.equal(unsettled.packSize, "(5) 1 ML", "nothing to divide, so nothing is changed");
    assert.match(unsettled.packSize!, BRACKETED);
    assert.equal(packQtyOf(unsettled.packSize), null, "so it is refused, not answered with the vial");
  });

  test("a bracket of one is not a multi-pack and is answered normally", () => {
    /*
     * One carton of a hundred is a hundred, and the printed unit cost is per that hundred. There
     * was nothing to settle, so `wholePackage` leaves the row alone and the bracket survives —
     * refusing it would throw away a pack size the site can state perfectly well.
     */
    const one = wholePackage(row({ packSize: "(1) 100 EA", packCostCents: 5_000 }));
    assert.equal(one.packSize, "(1) 100 EA");
    assert.equal(packQtyOf(one.packSize), 100);
  });
});
