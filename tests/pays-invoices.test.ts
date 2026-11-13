import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { invoicesPaidBy, LAG_DAYS, type PayableInvoice } from "../src/lib/pays-invoices";

const inv = (number: string, on: string, cents: number): PayableInvoice => ({ id: `id-${number}`, number, on, cents });

describe("a debit that settles a set of invoices", () => {
  /*
   * The two that matched on his own statement, before this was written.
   *
   * IPC drew $1,171.46 on 9 September and it is exactly two of their invoices. A matcher that only
   * accepted ONE invoice equalling the debit could never place it, and IPC bills twice a day.
   */
  test("two invoices adding to the debit are found and named", () => {
    const r = invoicesPaidBy(117146, "2026-09-09", [inv("11486822", "2026-09-02", 58573), inv("11486823", "2026-09-02", 58573)]);
    assert.equal(r.kind, "settles");
    if (r.kind !== "settles") return;
    assert.equal(r.invoices.length, 2);
    assert.match(r.says, /\$1,171\.46 is exactly these 2 invoices/);
  });

  test("a single invoice still settles, and says so in the singular", () => {
    const r = invoicesPaidBy(48222, "2026-09-10", [inv("11488865", "2026-09-03", 48222)]);
    assert.equal(r.kind, "settles");
    if (r.kind !== "settles") return;
    assert.match(r.says, /is exactly this invoice/);
  });

  /*
   * A credit note is negative and belongs in the sum.
   *
   * IPC's CM107761 is −$199.00. A search that pruned as soon as the remainder went below zero would
   * refuse every payment containing one — which is the payment hardest to check by hand.
   */
  test("a credit note inside the payment does not defeat it", () => {
    const r = invoicesPaidBy(
      100234 + 7424 - 19900,
      "2026-09-12",
      [inv("11495629", "2026-09-09", 100234), inv("11495630", "2026-09-09", 7424), inv("CM107761", "2026-09-09", -19900)],
    );
    assert.equal(r.kind, "settles");
    if (r.kind !== "settles") return;
    assert.equal(r.invoices.length, 3);
    assert.match(r.says, /CM107761 \(\$199\.00 credit\)/);
  });

  test("the invoices come back in date order, so the same input always reads the same", () => {
    const r = invoicesPaidBy(300, "2026-09-10", [inv("b", "2026-09-05", 100), inv("a", "2026-09-01", 200)]);
    assert.equal(r.kind, "settles");
    if (r.kind !== "settles") return;
    assert.deepEqual(r.invoices.map((i) => i.number), ["a", "b"]);
  });
});

describe("what it refuses, which is what makes it safe to act on", () => {
  /*
   * Ambiguity refuses. Two sets adding to one figure is a coin toss, and a payment allocated to the
   * wrong invoices marks the wrong bills settled and hides the ones still owed — worse than leaving
   * it alone, because it looks finished.
   */
  test("two different sets adding to the same figure is refused, not guessed", () => {
    const r = invoicesPaidBy(1000, "2026-09-10", [inv("a", "2026-09-01", 1000), inv("b", "2026-09-02", 600), inv("c", "2026-09-03", 400)]);
    assert.equal(r.kind, "ambiguous");
    if (r.kind !== "ambiguous") return;
    assert.match(r.says, /cannot be told from the amount/);
    assert.match(r.says, /hides the ones still owed/);
  });

  test("nothing adding to it says how many were considered", () => {
    const r = invoicesPaidBy(999999, "2026-09-10", [inv("a", "2026-09-01", 1000), inv("b", "2026-09-02", 600)]);
    assert.equal(r.kind, "none");
    if (r.kind !== "none") return;
    assert.equal(r.considered, 2);
    assert.match(r.says, /No combination of the 2 invoices/);
  });

  test("an invoice dated after the debit was never settled by it", () => {
    const r = invoicesPaidBy(1000, "2026-09-10", [inv("later", "2026-09-11", 1000)]);
    assert.equal(r.kind, "none");
    if (r.kind !== "none") return;
    assert.equal(r.considered, 0);
  });

  test("an invoice older than the lag window is out of reach", () => {
    const r = invoicesPaidBy(1000, "2026-09-10", [inv("ancient", "2026-06-01", 1000)]);
    assert.equal(r.kind, "none");
    if (r.kind !== "none") return;
    assert.match(r.says, new RegExp(`${LAG_DAYS} days before`));
  });

  test("no invoices at all is said as that, not as a failure to add up", () => {
    const r = invoicesPaidBy(1000, "2026-09-10", []);
    assert.equal(r.kind, "none");
    if (r.kind !== "none") return;
    assert.match(r.says, /nothing for it to have settled/);
  });

  /*
   * The August boundary, which is most of why his early-September debits do not place.
   *
   * The books start on 1 September by his instruction, so a debit on the 1st is paying invoices this
   * site has never held. Saying "no invoice in the window" is the truthful answer; inventing one
   * from the days that are on file would be worse than silence.
   */
  test("a debit paying a month the books do not hold finds nothing, and that is correct", () => {
    const r = invoicesPaidBy(164577, "2026-09-01", [inv("11490216", "2026-09-04", 153089)]);
    assert.equal(r.kind, "none");
  });
});

/**
 * Once the cadence says which days a draw is for, this stops searching and starts stating.
 *
 * The owner: "the next thing to learn about suppliers isn't just when they bill but what dates is
 * that payment for, we should be able to figure that out."
 */
describe("a draw whose period is known", () => {
  test("the days the cadence names, added up and equal, settle it and say which days", () => {
    const r = invoicesPaidBy(
      117146,
      "2026-09-09",
      [inv("11486822", "2026-09-02", 105841), inv("11486823", "2026-09-02", 11305), inv("later", "2026-09-05", 9999)],
      ["2026-09-02"],
    );
    assert.equal(r.kind, "settles");
    if (r.kind !== "settles") return;
    assert.equal(r.invoices.length, 2, "the invoice outside the period is not in the draw");
    assert.match(r.says, /is the billing of 2026-09-02/);
    assert.match(r.says, /cadence says a draw on 2026-09-09 is for/);
  });

  test("a period that does not add up names the shortfall instead of hunting for a set that fits", () => {
    const r = invoicesPaidBy(200000, "2026-09-09", [inv("a", "2026-09-02", 150000)], ["2026-09-02"]);
    assert.equal(r.kind, "period_disagrees");
    if (r.kind !== "period_disagrees") return;
    assert.equal(r.expectedCents, 150000);
    assert.equal(r.drawCents, 200000);
    assert.match(r.says, /\$500\.00 more than the site holds, so an invoice for that period never arrived/);
  });

  test("a draw smaller than the period says a credit is missing, which is the other direction", () => {
    const r = invoicesPaidBy(100000, "2026-09-09", [inv("a", "2026-09-02", 150000)], ["2026-09-02"]);
    assert.equal(r.kind, "period_disagrees");
    if (r.kind !== "period_disagrees") return;
    assert.match(r.says, /less than the site holds, so a credit was applied that did not/);
  });

  test("nothing on file for the named period falls back to searching rather than asserting a gap", () => {
    const r = invoicesPaidBy(105841, "2026-09-09", [inv("a", "2026-09-05", 105841)], ["2026-09-02"]);
    assert.equal(r.kind, "settles");
  });
});
