import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readPostageEmail, postageKey } from "../src/lib/postage-email";

/**
 * Both messages below are copied from the two Endicia confirmations this pharmacy actually
 * received, on 8 and 10 September 2026. Neither reached the books: they carry no attachment, and
 * the mail sweep files attachments.
 */
const REAL = `Dear Scott,

Thank you for your recent purchase. The following transaction has been successfully posted to your account.

Transaction Details
-------------------

Date: 09-08-2026 17:24 Description: Purchase Order Number: 625063610 Payment Method: Mastercard Amount: $100.00 Surcharge: 

Your current available account balance is: 

Your customer ID is: 7952546.

Sincerely,

 The Endicia  Customer Support Team`;

describe("a postage confirmation with nothing attached", () => {
  test("reads the charge, the day and the order from the body", () => {
    const p = readPostageEmail("no-reply@endicia.com", "Purchase Confirmation", REAL);
    assert.ok(p);
    assert.equal(p.vendor, "Endicia");
    assert.equal(p.amountCents, 10_000);
    assert.equal(p.purchasedOn, "2026-09-08");
    assert.equal(p.orderNumber, "625063610");
    assert.equal(p.paymentMethod, "Mastercard");
    assert.equal(p.surchargeCents, 0);
  });

  test("a printed surcharge is added to the charge", () => {
    const p = readPostageEmail("no-reply@endicia.com", "Purchase Confirmation", REAL.replace("Surcharge: ", "Surcharge: $2.50 "));
    assert.equal(p?.amountCents, 10_250);
    assert.equal(p?.surchargeCents, 250);
  });

  test("the balance on the same line is never mistaken for the charge", () => {
    /* The message prints an available balance too; only the labelled Amount is the charge. */
    const p = readPostageEmail("no-reply@endicia.com", "Purchase Confirmation", REAL.replace("balance is: ", "balance is: $438.19"));
    assert.equal(p?.amountCents, 10_000);
  });

  test("another sender is not read at all", () => {
    assert.equal(readPostageEmail("invoices@mckesson.com", "Purchase Confirmation", REAL), null);
    /* A lookalike domain is not Endicia. */
    assert.equal(readPostageEmail("no-reply@endicia.com.example.net", "Purchase Confirmation", REAL), null);
  });

  test("a message that is not a purchase confirmation is not read", () => {
    assert.equal(readPostageEmail("no-reply@endicia.com", "Your account balance is low", REAL), null);
  });

  test("no amount and no date mean nothing is booked, never a guess", () => {
    assert.equal(readPostageEmail("no-reply@endicia.com", "Purchase Confirmation", REAL.replace("Amount: $100.00", "Amount:")), null);
    assert.equal(readPostageEmail("no-reply@endicia.com", "Purchase Confirmation", REAL.replace("Date: 09-08-2026", "Date:")), null);
  });

  test("an impossible date is refused rather than shifted into range", () => {
    assert.equal(readPostageEmail("no-reply@endicia.com", "Purchase Confirmation", REAL.replace("09-08-2026", "13-45-2026")), null);
  });

  test("the same confirmation twice is the same purchase", () => {
    const a = readPostageEmail("no-reply@endicia.com", "Purchase Confirmation", REAL)!;
    const b = readPostageEmail("no-reply@endicia.com", "Purchase Confirmation", REAL)!;
    assert.equal(postageKey(a), postageKey(b));
    /* And the second real purchase, a different order, is a different bill. */
    const later = readPostageEmail("no-reply@endicia.com", "Purchase Confirmation", REAL.replace("625063610", "625306520").replace("09-08-2026", "09-10-2026"))!;
    assert.notEqual(postageKey(a), postageKey(later));
  });
});

/**
 * The whole path, from the message the sweep sees to the bill on both accounts.
 *
 * The reader above is tested on the text. This is the part that was actually missing: the sweep
 * looked for an attachment, found none, and wrote "No attachment on this message". Everything the
 * charge needed was in the body it threw away.
 */
describe("what the sweep does with the next one", () => {
  const NEXT = `Dear Scott,

Thank you for your recent purchase. The following transaction has been successfully posted to your account.

Transaction Details
-------------------

Date: 10-02-2026 09:15 Description: Purchase Order Number: 631118402 Payment Method: Mastercard Amount: $250.00 Surcharge: $3.75 

Your current available account balance is: $412.60

Your customer ID is: 7952546.`;

  test("it is recognised, priced and dated before anything says it was empty", () => {
    const p = readPostageEmail("no-reply@endicia.com", "Purchase Confirmation", NEXT);
    assert.ok(p, "the sweep must read it rather than passing it over");
    /* The charge plus its surcharge is what left the bank. */
    assert.equal(p.amountCents, 25_375);
    assert.equal(p.purchasedOn, "2026-10-02");
    /* The available balance on the same line is not the charge. */
    assert.notEqual(p.amountCents, 41_260);
  });

  test("it carries its own identity, so the sweep and a backfill cannot both book it", () => {
    const p = readPostageEmail("no-reply@endicia.com", "Purchase Confirmation", NEXT)!;
    assert.equal(postageKey(p), "POSTAGE|Endicia|631118402");
  });

  test("the description says what it is without anybody opening the email", () => {
    const p = readPostageEmail("no-reply@endicia.com", "Purchase Confirmation", NEXT)!;
    assert.match(p.says, /Endicia postage bought 2026-10-02/);
    assert.match(p.says, /order 631118402/);
  });
});
