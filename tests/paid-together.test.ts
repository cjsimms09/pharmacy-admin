import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkAllocations, checkPaidTogether, paymentCentsFrom, type PaidTogetherInvoice } from "../src/lib/paid-together";

/*
 * A statement payment marking several invoices paid. The owner, 15 September: "believe parmed and ipd are per statement".
 * Invented invoice numbers and amounts.
 */
const inv = (id: string, totalCents: number | null, over: Partial<PaidTogetherInvoice> = {}): PaidTogetherInvoice => ({
  id,
  supplier: "Parmed",
  invoiceNumber: `T-${id}`,
  totalCents,
  paidOn: null,
  ...over,
});
const three = [inv("1", 50_000), inv("2", 60_000), inv("3", 36_146)];
const DAY = "2026-10-10";

describe("marking a statement's invoices paid by one payment", () => {
  test("ticked invoices that come to the payment are marked paid", () => {
    assert.deepEqual(checkPaidTogether({ invoices: three, paidOn: DAY, paymentCents: 146_146, acceptDifference: false }), {
      ok: true,
      supplier: "Parmed",
      totalCents: 146_146,
      paymentCents: 146_146,
      differenceCents: 0,
    });
  });

  test("a total that is not the payment records nothing, and says both figures", () => {
    const r = checkPaidTogether({ invoices: three.slice(0, 2), paidOn: DAY, paymentCents: 146_146, acceptDifference: false });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /2 ticked invoices come to \$1,100\.00; the payment was \$1,461\.46, \$361\.46 more\. Nothing was recorded/);
  });

  test("the person can say the difference is a discount or credit, and it is recorded with the difference", () => {
    const r = checkPaidTogether({ invoices: three, paidOn: DAY, paymentCents: 145_000, acceptDifference: true });
    assert.ok(r.ok);
    assert.equal(r.ok && r.differenceCents, -1_146);
  });

  test("invoices from two suppliers are refused: a statement is one supplier's", () => {
    const r = checkPaidTogether({ invoices: [inv("1", 50_000), inv("9", 10_000, { supplier: "IPD" })], paidOn: DAY, paymentCents: 60_000, acceptDifference: false });
    assert.match(r.ok ? "" : r.why, /from Parmed and IPD/);
  });

  test("one supplier spelled two ways is still one supplier", () => {
    assert.equal(checkPaidTogether({ invoices: [inv("1", 50_000), inv("2", 10_000, { supplier: "PARMED " })], paidOn: DAY, paymentCents: 60_000, acceptDifference: false }).ok, true);
  });

  test("an invoice with no amount read is refused, since the total could not be checked", () => {
    const r = checkPaidTogether({ invoices: [inv("1", 50_000), inv("2", null)], paidOn: DAY, paymentCents: 50_000, acceptDifference: true });
    assert.match(r.ok ? "" : r.why, /invoice T-2 has no amount read/);
  });

  test("an invoice already paid on another day is not moved silently; on the same day it is no change", () => {
    const moved = checkPaidTogether({ invoices: [inv("1", 50_000, { paidOn: "2026-09-25" })], paidOn: DAY, paymentCents: 50_000, acceptDifference: false });
    assert.match(moved.ok ? "" : moved.why, /invoice T-1 is already marked paid on 2026-09-25/);
    assert.equal(checkPaidTogether({ invoices: [inv("1", 50_000, { paidOn: DAY })], paidOn: DAY, paymentCents: 50_000, acceptDifference: false }).ok, true);
  });

  test("no day, no invoices, or no amount: each refused with what to give", () => {
    assert.match((checkPaidTogether({ invoices: three, paidOn: "", paymentCents: 146_146, acceptDifference: false }) as { why: string }).why, /day the payment left the bank/);
    assert.match((checkPaidTogether({ invoices: [], paidOn: DAY, paymentCents: 146_146, acceptDifference: false }) as { why: string }).why, /Tick the invoices/);
    assert.match((checkPaidTogether({ invoices: three, paidOn: DAY, paymentCents: null, acceptDifference: false }) as { why: string }).why, /amount paid/);
  });

  test("a credit memo on the statement counts against the total", () => {
    assert.equal(checkPaidTogether({ invoices: [inv("1", 50_000), inv("2", -5_000)], paidOn: DAY, paymentCents: 45_000, acceptDifference: false }).ok, true);
  });
});

/*
 * A payment that names its own amounts: IPD's statement pays one invoice $1,125.36 on 19 August and the remaining
 * $2,152.03 on 3 September, by two credit-memo offsets. Figures from that shape, invoice numbers invented.
 */
describe("a payment that says what it put against each invoice", () => {
  const big = inv("1", 327_739, { supplier: "IPD" });
  const other = inv("2", 100_000, { supplier: "IPD" });
  const none: Record<string, number> = {};

  test("part of an invoice is allowed: it is not paid until later payments finish it", () => {
    const r = checkAllocations({ invoices: [big], allocations: [{ invoiceId: "1", amountCents: 112_536 }], allocatedAlready: none, paidOn: "2026-08-19", paymentCents: 112_536, acceptDifference: false });
    assert.deepEqual(r, { ok: true, supplier: "IPD", allocatedCents: 112_536, differenceCents: 0 });
  });

  test("the rest of it is allowed on a later day", () => {
    const r = checkAllocations({ invoices: [big], allocations: [{ invoiceId: "1", amountCents: 215_203 }], allocatedAlready: { "1": 112_536 }, paidOn: "2026-09-03", paymentCents: 215_203, acceptDifference: false });
    assert.equal(r.ok, true);
  });

  test("more than is left owing is refused, which is what stops one cost counting in two months", () => {
    const r = checkAllocations({ invoices: [big], allocations: [{ invoiceId: "1", amountCents: 215_204 }], allocatedAlready: { "1": 112_536 }, paidOn: "2026-09-03", paymentCents: 215_204, acceptDifference: false });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.why, /already paid.*cannot pay more than is owed/s);
  });

  test("an invoice already marked paid with no payment behind it is not allocated again", () => {
    const paidByBank = inv("3", 50_000, { supplier: "IPD", paidOn: "2026-09-01" });
    const r = checkAllocations({ invoices: [paidByBank], allocations: [{ invoiceId: "3", amountCents: 50_000 }], allocatedAlready: none, paidOn: "2026-09-03", paymentCents: 50_000, acceptDifference: false });
    assert.match(r.ok ? "" : r.why, /already marked paid on 2026-09-01/);
  });

  test("the amounts must add up to the payment unless a difference is declared", () => {
    const parts = [{ invoiceId: "1", amountCents: 112_536 }, { invoiceId: "2", amountCents: 100_000 }];
    const r = checkAllocations({ invoices: [big, other], allocations: parts, allocatedAlready: none, paidOn: "2026-08-19", paymentCents: 200_000, acceptDifference: false });
    assert.match(r.ok ? "" : r.why, /the payment is \$2,000\.00 and what it puts against invoices comes to \$2,125\.36/i);
    assert.equal(checkAllocations({ invoices: [big, other], allocations: parts, allocatedAlready: none, paidOn: "2026-08-19", paymentCents: 200_000, acceptDifference: true }).ok, true);
  });

  test("nought, a negative amount, or the same invoice twice is refused", () => {
    const bad = (allocations: { invoiceId: string; amountCents: number }[]) =>
      checkAllocations({ invoices: [big, other], allocations, allocatedAlready: none, paidOn: "2026-08-19", paymentCents: 1, acceptDifference: true });
    assert.equal(bad([{ invoiceId: "1", amountCents: 0 }]).ok, false);
    assert.equal(bad([{ invoiceId: "1", amountCents: -5 }]).ok, false);
    assert.match(bad([{ invoiceId: "1", amountCents: 10 }, { invoiceId: "1", amountCents: 20 }]).ok ? "" : "names one invoice twice", /twice/);
  });

  test("an invoice the payment names that is not on file stops the whole payment", () => {
    const r = checkAllocations({ invoices: [big], allocations: [{ invoiceId: "1", amountCents: 10 }, { invoiceId: "99", amountCents: 10 }], allocatedAlready: none, paidOn: "2026-08-19", paymentCents: 20, acceptDifference: false });
    assert.match(r.ok ? "" : r.why, /not on file/);
  });
});

describe("the amount as typed", () => {
  test("dollars with a sign, commas or spaces become cents", () => {
    assert.equal(paymentCentsFrom("1,461.46"), 146_146);
    assert.equal(paymentCentsFrom(" $3561.38 "), 356_138);
    assert.equal(paymentCentsFrom("25"), 2_500);
  });

  test("anything that is not an amount is no amount, never nought", () => {
    assert.equal(paymentCentsFrom(""), null);
    assert.equal(paymentCentsFrom("about 1400"), null);
    assert.equal(paymentCentsFrom("1.234"), null);
  });
});
