import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { costOf, provable, coverage, type InvoiceCost, type ReceiptCost } from "../src/lib/drug-cost-source";

/*
 * What a drug cost, and on whose authority.
 *
 * Invoice coverage is 51%. The other half has no per-drug cost on any screen that prices an order,
 * times a return or backs an appeal, while the figures sit in `pioneer_purchases.itemsJson` one
 * table away. The owner asked for exactly this — the receipt standing in "for a purchase whose
 * invoice never reached the pharmacy" — and in the same breath refused the thing it must not
 * become: "we shouldn't be taking pioneer order receipts as invoices, invoices are mailed to us
 * from suppliers and that's what we have to keep".
 *
 * So what these tests hold is the line between the two: the receipt answers, and never pretends.
 */

const inv = (o: Partial<InvoiceCost> = {}): InvoiceCost => ({
  ndc11: "00093721410", supplier: "McKesson", invoiceNumber: "9890971", invoiceDate: "2026-09-08",
  quantity: 1, unitCostCents: 1_000, extendedCents: 1_000, ...o,
});
const rec = (o: Partial<ReceiptCost> = {}): ReceiptCost => ({
  ndc11: "00093721410", supplier: "ParMed", invoiceNumber: "2057167199", invoiceDate: "2026-09-09",
  quantity: 1, unitCostCents: 900, extendedCents: 900, receiptSettles: false, ...o,
});

describe("the invoice always wins", () => {
  test("an invoice is the authority even where a newer receipt exists", () => {
    // The receipt is a day newer and still loses. The invoice is the document the pharmacy keeps.
    const c = costOf("00093721410", [inv()], [rec()]);
    assert.equal(c.authority, "invoice");
    assert.equal(c.unitCostCents, 1_000);
    assert.match(c.says, /invoice 9890971/);
  });

  test("only an invoice is provable to a payer", () => {
    assert.equal(provable(costOf("00093721410", [inv()], [])), true);
    assert.equal(provable(costOf("00093721410", [], [rec()])), false);
    assert.equal(provable(costOf("00093721410", [], [rec({ receiptSettles: true })])), false);
  });

  test("the newest invoice answers, because this is what it costs today", () => {
    const c = costOf("00093721410", [inv({ invoiceDate: "2026-08-01", unitCostCents: 500 }), inv({ invoiceDate: "2026-09-08" })], []);
    assert.equal(c.unitCostCents, 1_000);
  });

  test("a dated line beats an undated one, whatever order they arrive in", () => {
    // A figure that cannot be placed in time cannot be shown to be current.
    const c = costOf("00093721410", [inv({ invoiceDate: null, unitCostCents: 1 }), inv({ invoiceDate: "2026-09-08" })], []);
    assert.equal(c.unitCostCents, 1_000);
  });
});

describe("one delivery is one cost", () => {
  test("a receipt for a delivery an invoice already bills for is not a second cost", () => {
    /*
     * The fault the separate tables exist to prevent. Matched on the wholesaler's own number, which
     * both systems copy from the same place — the only field on either record not read twice.
     */
    const c = costOf("99999999999", [inv({ ndc11: "99999999999", invoiceNumber: "INV-123" })], [rec({ ndc11: "99999999999", invoiceNumber: "INV-123" })]);
    assert.equal(c.authority, "invoice");
  });

  test("the same number punctuated differently is the same delivery", () => {
    const invoices = [inv({ ndc11: "5", invoiceNumber: "inv 123-4" })];
    const receipts = [rec({ ndc11: "5", invoiceNumber: "INV1234" })];
    // The invoice covers this NDC anyway, so prove it through a second NDC on the same delivery.
    const c = costOf("6", invoices, [...receipts, rec({ ndc11: "6", invoiceNumber: "INV1234" })]);
    assert.equal(c.authority, "neverBought", "the delivery is billed, so its receipt is not a cost of its own");
  });

  test("a receipt for a delivery no invoice covers does answer", () => {
    const c = costOf("00093721410", [inv({ invoiceNumber: "OTHER" })], [rec({ ndc11: "00093721410" })]);
    assert.equal(c.authority, "invoice", "this NDC is on the other invoice");
    const d = costOf("77777777777", [inv({ invoiceNumber: "OTHER" })], [rec({ ndc11: "77777777777" })]);
    assert.equal(d.authority, "notYetArrived");
    assert.equal(d.unitCostCents, 900);
  });
});

describe("the two receipts that give the same figure and are different facts", () => {
  test("a delivery the owner closed on its receipt is not something to chase", () => {
    // Cardinal Health, RrcPharmaSolution and TopRx: no document is coming.
    const c = costOf("00093721410", [], [rec({ receiptSettles: true })]);
    assert.equal(c.authority, "receipt");
    assert.match(c.says, /No invoice is coming for this one/);
    assert.match(c.says, /not a document to produce to a plan/);
  });

  test("a delivery still waiting for paper says so, and the figure is the same", () => {
    const c = costOf("00093721410", [], [rec({ receiptSettles: false })]);
    assert.equal(c.authority, "notYetArrived");
    assert.equal(c.unitCostCents, 900);
    assert.match(c.says, /has not arrived yet/);
    assert.match(c.says, /what was received rather than what was billed/);
  });

  test("a supplier who never sends invoices is not reported as owing one", () => {
    // Otherwise the worklist carries a document nobody will ever produce, and stops being read.
    const c = costOf("00093721410", [], [rec({ supplier: "Cardinal Health" })], (s) => s !== "Cardinal Health");
    assert.equal(c.authority, "receipt");
  });
});

describe("never bought is not missing", () => {
  test("nothing on file about a drug is an absence of the event", () => {
    const c = costOf("11111111111", [inv()], [rec()]);
    assert.equal(c.authority, "neverBought");
    assert.equal(c.unitCostCents, null, "no cost is invented");
    assert.match(c.says, /absence of the event, not a gap in the records/);
  });

  test("the word missing appears nowhere", () => {
    // Rule 5: "Missing" is not a state and must never be reported as one.
    for (const c of [
      costOf("11111111111", [], []),
      costOf("00093721410", [inv()], []),
      costOf("00093721410", [], [rec()]),
      costOf("00093721410", [], [rec({ receiptSettles: true })]),
    ]) {
      assert.doesNotMatch(c.says, /missing/i, `"${c.says}" must not say missing`);
    }
  });
});

describe("how much can be priced, and on what", () => {
  test("coverage counts the three that answer and names the one that does not", () => {
    const costs = [
      costOf("1", [inv({ ndc11: "1" })], []),
      costOf("2", [], [rec({ ndc11: "2", receiptSettles: true })]),
      costOf("3", [], [rec({ ndc11: "3", receiptSettles: false })]),
      costOf("4", [], []),
    ];
    const s = coverage(costs);
    assert.equal(s.fromInvoice, 1);
    assert.equal(s.fromReceipt, 1);
    assert.equal(s.notYetArrived, 1);
    assert.equal(s.neverBought, 1);
    assert.match(s.says, /^3 of 4 drugs have a cost the site can state/);
  });

  test("counted in drugs rather than dollars, so one expensive drug hides nothing", () => {
    assert.match(coverage([costOf("1", [inv({ ndc11: "1" })], [])]).says, /1 of 1 drugs/);
  });

  test("asking about nothing says so", () => {
    assert.match(coverage([]).says, /No drug was asked about/);
  });
});
