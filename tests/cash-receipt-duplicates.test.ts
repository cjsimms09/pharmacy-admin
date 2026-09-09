import { test, describe } from "node:test";
import assert from "node:assert/strict";

/*
 * The rule `addCashReceipt` enforces, tested as arithmetic rather than against the database.
 *
 * The owner, 9 September: "we need to make sure we are using this data to make our money tracking
 * even more correct but also make sure we arent duplicating things!" Three feeds see the same
 * deposit — the payer payment report lists it by payment number, an 835 carries it with a trace
 * number, a copay statement settles a slice of it — and before this they would all have banked it.
 */
type Receipt = { amountCents: number; receivedOn: string | null; payer: string | null; sourceKey: string | null; reference?: string | null };

const head = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);

/** The same two gates, in the same order, that expenses.ts applies. */
function wouldBank(held: Receipt[], incoming: Receipt): boolean {
  if (incoming.sourceKey && held.some((h) => h.sourceKey === incoming.sourceKey)) return false;
  if (incoming.sourceKey && incoming.receivedOn) {
    const clash = held.find(
      (h) => h.receivedOn === incoming.receivedOn && h.amountCents === incoming.amountCents && (!incoming.payer || !h.payer || head(h.payer) === head(incoming.payer)),
    );
    if (clash) return false;
  }
  return true;
}

describe("banking the same money twice", () => {
  const fromReport: Receipt = { amountCents: 3_790_927, receivedOn: "2026-09-08", payer: "Health Mart Atlas", sourceKey: "payer-payment|health mart atlas|EFT-31434994", reference: "EFT-31434994" };

  test("the same statement read twice banks once", () => {
    assert.equal(wouldBank([], fromReport), true);
    assert.equal(wouldBank([fromReport], { ...fromReport }), false);
  });

  test("an 835 for a deposit the payment report already banked is recognised", () => {
    // Same money, same day, different feed and a different identifier on it.
    const from835: Receipt = { amountCents: 3_790_927, receivedOn: "2026-09-08", payer: "HEALTH MART ATLAS", sourceKey: "835|health mart atlas|TRACE99|2026-09-08" };
    assert.equal(wouldBank([fromReport], from835), false);
  });

  test("a different amount, a different day or a different payer all still bank", () => {
    assert.equal(wouldBank([fromReport], { ...fromReport, amountCents: 3_790_928, sourceKey: "835|a|b|c" }), true);
    assert.equal(wouldBank([fromReport], { ...fromReport, receivedOn: "2026-09-09", sourceKey: "835|a|b|d" }), true);
    assert.equal(wouldBank([fromReport], { ...fromReport, payer: "Express Scripts", sourceKey: "835|a|b|e" }), true);
  });

  test("money typed in from a bank statement is never refused", () => {
    // The bank is the record. Two real deposits of one amount on one day happen, and a reader that
    // overruled the statement it exists to agree with would be worse than the duplicate.
    const byHand: Receipt = { amountCents: 3_790_927, receivedOn: "2026-09-08", payer: "Health Mart Atlas", sourceKey: null };
    assert.equal(wouldBank([fromReport], byHand), true);
    assert.equal(wouldBank([fromReport, byHand], { ...byHand }), true);
  });
});
