import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readTotals } from "../src/lib/invoice-price-check";

/*
 * What a difference between an invoice total and a delivery total is.
 *
 * On 15 September the invoices screen told the owner "$6.40 of the difference is money billed for
 * goods that were not booked in", as a blocking alert. It was about two ParMed invoices and it was
 * false on both: every item matched what PioneerRx booked in to the cent, and the $1.57 and $4.83
 * sat on the invoice total and on no line. A freight charge, read as goods that never arrived —
 * which would have sent him after a wholesaler for stock he had received.
 */

describe("the two invoices behind the false alert", () => {
  test("ParMed 7491405516: every good matches, so the $1.57 is a charge", () => {
    // Item lines $123.36 against PioneerRx $123.36; invoice total $124.93.
    const r = readTotals(12_493, 12_336, [12_336], [12_336]);
    assert.equal(r.kind, "charge");
    assert.equal(r.kind === "charge" && r.cents, 157);
  });

  test("ParMed 7491384103: every good matches, so the $4.83 is a charge", () => {
    // Item lines $722.34 against PioneerRx $722.34; invoice total $727.17.
    const r = readTotals(72_717, 72_234, [40_000, 32_234], [72_234]);
    assert.equal(r.kind, "charge");
    assert.equal(r.kind === "charge" && r.cents, 483);
  });

  test("goods are compared as a sum, not line by line, so a split line is not a disagreement", () => {
    // The invoice prints two lines where the delivery booked one; the goods are still the same money.
    assert.equal(readTotals(72_717, 72_234, [40_000, 32_234], [72_234]).kind, "charge");
  });
});

describe("what is not a charge", () => {
  test("goods that disagree make it a difference, not a charge", () => {
    // The invoice lines come to more than was booked in: that is not freight.
    const r = readTotals(13_000, 12_336, [13_000], [12_336]);
    assert.equal(r.kind, "differ");
    assert.equal(r.kind === "differ" && r.goodsCompared, true);
  });

  test("no lines on either side means it cannot be told, and says so rather than choosing", () => {
    /*
     * Three states. A difference with no lines behind it could be goods or a charge, and calling
     * it either would be a guess about money.
     */
    const noInvoiceLines = readTotals(12_493, 12_336, [], [12_336]);
    assert.equal(noInvoiceLines.kind, "differ");
    assert.equal(noInvoiceLines.kind === "differ" && noInvoiceLines.goodsCompared, false);

    const noDeliveryLines = readTotals(12_493, 12_336, [12_336], []);
    assert.equal(noDeliveryLines.kind === "differ" && noDeliveryLines.goodsCompared, false);
  });

  test("totals that agree within rounding are agreement, whatever the lines say", () => {
    assert.equal(readTotals(12_337, 12_336, [], []).kind, "agree");
    assert.equal(readTotals(12_336, 12_336, [1], [2]).kind, "agree");
  });

  test("a total nobody read is not a disagreement", () => {
    // Never measured is not measured and different.
    assert.equal(readTotals(null, 12_336, [12_336], [12_336]).kind, "agree");
    assert.equal(readTotals(12_493, null, [12_336], [12_336]).kind, "agree");
  });
});

describe("the direction is kept", () => {
  test("a delivery total above the invoice is a negative difference, not dropped", () => {
    // Credit or a charge the other way round. The sign is the fact, so it is not flattened.
    const r = readTotals(12_336, 12_493, [12_336], [12_336]);
    assert.equal(r.kind, "charge");
    assert.equal(r.kind === "charge" && r.cents, -157);
  });

  test("rounding of up to two cents on the goods still counts as agreeing goods", () => {
    assert.equal(readTotals(12_493, 12_336, [12_338], [12_336]).kind, "charge");
    assert.equal(readTotals(12_493, 12_336, [12_339], [12_336]).kind, "differ");
  });
});
