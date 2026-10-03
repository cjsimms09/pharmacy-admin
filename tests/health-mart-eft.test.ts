import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { section } from "./support/fixtures";
import { readFile } from "node:fs/promises";
import { readEftNotice, looksLikeEftNotice, HEALTH_MART_ATLAS } from "../src/lib/health-mart-eft";

/**
 * The Health Mart Atlas "EFT completed" email.
 *
 * The layout is the one the owner forwarded on 15 September, copied line for line, with the EFT
 * number, the amount and the NCPDP changed. It has nothing attached, and the mail sweep dropped it as
 * "No attachment on this message" — every deposit notice after it would have gone the same way.
 */
const OWN = "1234567";

const body = (rows = `   EFT-99000001 ${OWN}       $20,091.28 West Wichita Family Pharmacy`, date = "9/14/2026") => `



[photo]


Cory Simms
Pharmacist in Charge, West Wichita Family Pharmacy

________________________________
From: operations.hmatlas@mckesson.com <operations.hmatlas@mckesson.com>
Sent: Monday, September 14, 2026 1:19 PM
To: Cory J. Simms
Subject: Health Mart Atlas EFT completed

The electronic funds transfer for ${date} is complete.

The following payments were made:

   PMT          NCPDP             Amount Store Name

${rows}


Deposit includes payments from the following third parties:

  Payers:
     MEDIMPACT
     OptumRx
     Serve You
     SmithRx


Please visit https://connect.mckesson.com to review the details of this transaction.

Confidentiality Notice: This e-mail message, including any attachments, is for the sole use of the intended recipient(s).`;

const FWD = "Fw: Health Mart Atlas EFT completed";

describe("reading the notice", () => {
  test("REGRESSION: the forwarded notice is read as one deposit, not dropped", () => {
    const n = readEftNotice(FWD, body(), OWN);
    assert.ok(n, "the notice was not read");
    assert.equal(n.transferOn, "2026-09-14");
    assert.equal(n.payments.length, 1);
    const [p] = n.payments;
    assert.equal(p.paymentNumber, "EFT-99000001");
    assert.equal(p.payerName, HEALTH_MART_ATLAS);
    assert.equal(p.amountCents, 2_009_128);
    assert.equal(p.depositedOn, "2026-09-14");
    assert.equal(p.method, "EFT");
  });

  test("the direct email, not forwarded, is read the same", () => {
    assert.equal(readEftNotice("Health Mart Atlas EFT completed", body(), OWN)?.payments.length, 1);
  });

  test("the payer names are kept as the notice's own words, and never as amounts", () => {
    const n = readEftNotice(FWD, body(), OWN)!;
    assert.deepEqual(n.payers, ["MEDIMPACT", "OptumRx", "Serve You", "SmithRx"]);
    assert.ok(n.payments.every((p) => p.claimMatchCents === null && p.remitMatched === null), "the notice says nothing about claims");
  });

  test("several payments in one notice are each their own deposit", () => {
    const rows = `   EFT-99000001 ${OWN}       $20,091.28 West Wichita Family Pharmacy\n   EFT-99000002 ${OWN}          $377.41 West Wichita Family Pharmacy`;
    const n = readEftNotice(FWD, body(rows), OWN)!;
    assert.deepEqual(n.payments.map((p) => [p.paymentNumber, p.amountCents]), [["EFT-99000001", 2_009_128], ["EFT-99000002", 37_741]]);
  });

  test("a one-digit month and day are read as a date, not a guess", () => {
    assert.equal(readEftNotice(FWD, body(undefined, "1/5/2027"), OWN)?.transferOn, "2027-01-05");
  });
});

describe("what it refuses", () => {
  test("a payment to another store's NCPDP is not this pharmacy's money", () => {
    const rows = `   EFT-99000001 ${OWN}       $20,091.28 West Wichita Family Pharmacy\n   EFT-99000003 7654321        $9,999.99 Some Other Pharmacy`;
    const n = readEftNotice(FWD, body(rows), OWN)!;
    assert.equal(n.payments.length, 1);
    assert.match(n.refused.join(" "), /EFT-99000003: paid to NCPDP 7654321/);
    assert.match(n.says, /Refused/);
  });

  test("an amount that will not read is refused and said, not taken as nought", () => {
    const n = readEftNotice(FWD, body(`   EFT-99000001 ${OWN}       $20,O91.28 West Wichita Family Pharmacy`), OWN)!;
    assert.equal(n.payments.length, 0);
    assert.match(n.refused[0], /could not be read/);
  });

  test("an email that only mentions the subject is not a deposit", () => {
    // A reply that quotes the subject, with no transfer sentence, is not banked.
    assert.equal(readEftNotice("Re: Health Mart Atlas EFT completed", "Thanks, got it.", OWN), null);
    assert.equal(looksLikeEftNotice("Re: Health Mart Atlas EFT completed", "Thanks, got it."), false);
  });

  test("a different email is not this notice", () => {
    assert.equal(readEftNotice("Purchase Confirmation", body(), OWN), null);
  });
});

describe("the same money down two roads", () => {
  test("REGRESSION: the notice banks under the portal report's own key, through the same function", async () => {
    /*
     * The portal's payer payment report already banks Health Mart Atlas deposits keyed
     * payer-payment|health mart atlas|EFT-… . The notice is the same money, so it must use the same
     * key and the same gate, or every deposit is counted twice.
     */
    const store = await readFile("src/lib/health-mart-eft-store.ts", "utf8");
    assert.match(store, /bankPayerPayments\(/, "the notice must bank through the shared function");
    assert.doesNotMatch(store, /addCashReceipt\(/, "the notice must not write cash receipts on its own");
    const payments = await readFile("src/lib/payer-payments-store.ts", "utf8");
    assert.match(payments, /const key = \(p: PayerPayment\) => `payer-payment\|\$\{p\.payerName\.trim\(\)\.toLowerCase\(\)\}\|\$\{p\.paymentNumber\.trim\(\)\}`/);
    assert.equal(HEALTH_MART_ATLAS.toLowerCase(), "health mart atlas", "the payer name must fold to the key the report already wrote");
  });

  test("the portal report's import goes through the same function, so there is one gate", async () => {
    const payments = await readFile("src/lib/payer-payments-store.ts", "utf8");
    const imp = section(payments, "export async function importPayerPayments", "export type Banking");
    assert.match(imp, /bankPayerPayments\(/);
    assert.doesNotMatch(imp, /addCashReceipt\(/);
  });
});

describe("routing", () => {
  test("the sweep reads the notice before it writes 'No attachment on this message'", async () => {
    const text = await readFile("src/lib/mailbox.ts", "utf8");
    const eft = text.indexOf("bankEftNotice(");
    const ignore = text.indexOf('"No attachment on this message."');
    assert.ok(eft > 0 && ignore > 0 && eft < ignore, "the notice reader must run before the message is passed over");
  });

  test("every message the sweep marks read uses the IMAP flag, not a keyword", async () => {
    // "\Seen" with one backslash is "Seen" in JavaScript — a keyword, and the message stays unread.
    const text = await readFile("src/lib/mailbox.ts", "utf8");
    assert.doesNotMatch(text, /\["\\Seen"\]/);
  });
});
