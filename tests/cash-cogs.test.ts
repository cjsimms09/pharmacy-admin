import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cashCostOfGoods, countedTwiceInCash, type SettledLine } from "../src/lib/cash-cogs";

/**
 * September 2026, in miniature, with the figures the real month actually carried.
 *
 * McKesson took one ACH of $106,322.62 on the 7th. The site meanwhile held $270,369.84 of cost for
 * the month, because it was counting invoice dates and calling that cash.
 */
const settled: SettledLine[] = [
  { supplier: "Mckesson", invoiceNumber: "7656141694", netCents: 6_388, clearingDate: "2026-09-07", checkNumber: "CKACH07227740" },
  { supplier: "Mckesson", invoiceNumber: "7656141698", netCents: 1_390_246, clearingDate: "2026-09-07", checkNumber: "CKACH07227740" },
  /* Billed, due on the 15th, and still sitting in the bank. */
  { supplier: "Mckesson", invoiceNumber: "7657345034", netCents: 2_211_856, clearingDate: null, checkNumber: null },
];

const invoices = [
  /* McKesson's own invoices must never be added on top of their statement. */
  { supplier: "Mckesson", invoiceNumber: "7657345034", invoiceDate: "2026-09-11", totalCents: 2_211_856 },
  { supplier: "IPC", invoiceNumber: "11497543", invoiceDate: "2026-09-10", totalCents: 21_639 },
];

const receiving = [
  /* A McKesson delivery whose invoice never arrived by email. The statement has it; this must not. */
  { supplier: "McKesson", invoiceNumber: "7656519321", invoiceDate: "2026-09-08", totalCents: 858_988 },
  /* An IPD delivery with no invoice, from a supplier nobody sends a statement for. */
  { supplier: "IPD", invoiceNumber: "99001", invoiceDate: "2026-09-05", totalCents: 50_000 },
];

describe("cash cost of goods, once the wholesaler's own ledger arrives", () => {
  const r = cashCostOfGoods({ month: "2026-09", settled, invoices, receiving });

  test("a settled supplier contributes only what actually left the bank", () => {
    assert.equal(r.settledCents, 1_396_634);
  });

  test("their unpaid invoices are not cost this month, however certain the due date", () => {
    /* $22,118.56 is due on the 15th. It is owed, not spent. */
    assert.equal(r.notYetTakenCents, 2_211_856);
    assert.ok(!r.onInvoiceDates.includes("Mckesson"));
  });

  test("their own invoices are never added on top of their statement", () => {
    /* Only IPC's $216.39 comes from an invoice date. McKesson's $22,118.56 does not. */
    assert.equal(r.fromInvoiceDatesCents, 21_639);
  });

  test("their deliveries with no invoice are not added either — the statement already has them", () => {
    /* $8,589.88 of McKesson receiving is excluded; only IPD's $500.00 remains. */
    assert.equal(r.fromReceivingCents, 50_000);
  });

  test("the total is the three parts and nothing else", () => {
    assert.equal(r.cents, 1_396_634 + 21_639 + 50_000);
  });

  test("a supplier spelled differently in the two systems is still the same supplier", () => {
    /* PioneerRx says "McKesson", the invoice file says "Mckesson". One wholesaler. */
    const hit = r.fromReceivingCents;
    assert.equal(hit, 50_000, "the McKesson delivery must be recognised as covered despite the capital K");
  });

  test("a month where nothing moved says nothing rather than nought", () => {
    const quiet = cashCostOfGoods({ month: "2026-10", settled, invoices, receiving });
    assert.equal(quiet.cents, null);
  });

  test("the sentence names the ACH, so a bank line can be found by it", () => {
    assert.match(r.says, /CKACH07227740 on 2026-09-07 covering 2 invoices/);
    assert.match(r.says, /IPC, whose payments this site cannot see/);
  });

  test("a clearing in another month belongs to that month, not this one", () => {
    const october = cashCostOfGoods({
      month: "2026-09",
      settled: [{ supplier: "Mckesson", invoiceNumber: "X", netCents: 100_000, clearingDate: "2026-10-02", checkNumber: "CK2" }],
      invoices: [],
      receiving: [],
    });
    assert.equal(october.settledCents, 0);
    assert.equal(october.cents, null);
  });
});

/**
 * The proof, rather than the argument.
 *
 * The rules above are written so a purchase cannot be counted twice, and the tests hold them. This
 * checks the same thing by counting rather than by reasoning, which is what catches the case nobody
 * thought of.
 */
describe("nothing reaches the cash figure twice", () => {
  test("the real shape of September finds nothing", () => {
    assert.deepEqual(countedTwiceInCash({ month: "2026-09", settled, invoices, receiving }), []);
  });

  test("it would catch a settled supplier's invoice being added by date as well", () => {
    /* If the coverage rule were ever removed, this is what it would look like. */
    const leak = countedTwiceInCash({
      month: "2026-09",
      settled: [{ supplier: "Mckesson", invoiceNumber: "7656141694", netCents: 6_388, clearingDate: "2026-09-07", checkNumber: "CK1" }],
      /* Same invoice, same supplier, but spelled as an uncovered one so it slips into the second bucket. */
      invoices: [{ supplier: "Mckesson Drug Co", invoiceNumber: "7656141694", invoiceDate: "2026-09-04", totalCents: 6_388 }],
      receiving: [],
    });
    assert.equal(leak.length, 1);
    assert.deepEqual(leak[0].inBoth, ["the invoice file", "the wholesaler's own ledger"]);
  });

  test("it would catch a delivery counted from receiving and from an invoice", () => {
    const leak = countedTwiceInCash({
      month: "2026-09",
      settled: [],
      invoices: [{ supplier: "IPD", invoiceNumber: "99001", invoiceDate: "2026-09-05", totalCents: 50_000 }],
      /* A receiving row whose number differs only by case must still be seen as the same purchase. */
      receiving: [{ supplier: "IPD", invoiceNumber: " 99001 ", invoiceDate: "2026-09-05", totalCents: 50_000 }],
    });
    assert.deepEqual(leak, []);
  });
});
