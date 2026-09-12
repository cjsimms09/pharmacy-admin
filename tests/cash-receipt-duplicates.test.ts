import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gateDeposit, withinWindow, shiftDays, type BankedReceipt } from "../src/lib/deposit-gate";

/*
 * The rule `addCashReceipt` enforces — imported, not written out again.
 *
 * The owner, 9 September: "we need to make sure we are using this data to make our money tracking
 * even more correct but also make sure we arent duplicating things!" Three feeds see the same
 * deposit: the payer's own payment report lists it by payment number, an 835 carries it with a
 * trace number, a copay statement settles a slice of it.
 *
 * This file used to hold its own copy of the gate as a local function. It agreed with the real one
 * on the day it was written and could not be relied on to keep agreeing — the fault class an audit
 * found all over this codebase the same night. One rule, one place, and both callers use it.
 *
 * The case that made it matter: a test here asserted that a different day always banks. It was
 * true of the code and wrong about the world, and it is the assertion that let $84,921.40 through.
 */

const fromReport: BankedReceipt = {
  amountCents: 3_790_927,
  receivedOn: "2026-09-08",
  payer: "Health Mart Atlas",
  sourceKey: "payer-payment|health mart atlas|EFT-31434994",
  reference: "EFT-31434994",
  month: "2026-09",
  createdBy: "the payment report",
};

describe("the same deposit down two roads", () => {
  /*
   * The live case. The payment report banks on the day the money landed; the 835 banks on BPR16,
   * the effective date. On this deposit those are 2026-09-08 and 2026-09-04, so a gate keyed on the
   * calendar day saw two deposits and banked $37,909.27 twice.
   */
  test("an 835 four days off the deposit date is caught by the payer's own reference", () => {
    const v = gateDeposit([fromReport], {
      amountCents: 3_790_927,
      receivedOn: "2026-09-04",
      payer: "Health Mart Atlas",
      sourceKey: "835|Health Mart Atlas|31434994|2026-09-04",
      reference: "31434994",
    });
    assert.equal(v.bank, false);
    assert.match(v.bank === false ? v.why : "", /already banked/);
  });

  test("it is caught in the other order too", () => {
    const held: BankedReceipt = { ...fromReport, receivedOn: "2026-09-04", sourceKey: "835|Health Mart Atlas|31434994|2026-09-04", reference: "31434994", createdBy: "the 835" };
    const v = gateDeposit([held], {
      amountCents: 3_790_927,
      receivedOn: "2026-09-08",
      payer: "Health Mart Atlas",
      sourceKey: "payer-payment|health mart atlas|EFT-31434994",
      reference: "EFT-31434994",
    });
    assert.equal(v.bank, false);
  });

  test("with no reference to go on, the amount and payer inside the window still catch it", () => {
    const v = gateDeposit([fromReport], { amountCents: 3_790_927, receivedOn: "2026-09-05", payer: "Health Mart Atlas", sourceKey: "835|hma|no-trace|2026-09-05", reference: null });
    assert.equal(v.bank, false);
    assert.match(v.bank === false ? v.why : "", /under 2026-09-08/);
  });

  test("the same file read twice is refused, and names this feed rather than another", () => {
    const v = gateDeposit([fromReport], { ...fromReport, receivedOn: fromReport.receivedOn });
    assert.equal(v.bank, false);
    assert.match(v.bank === false ? v.why : "", /already banked from the payment report/);
  });

  test("a matching reference with a different amount is still one deposit, and says so", () => {
    const v = gateDeposit([fromReport], { amountCents: 3_790_900, receivedOn: "2026-09-04", payer: "Health Mart Atlas", sourceKey: "835|x", reference: "31434994" });
    assert.equal(v.bank, false);
    assert.match(v.bank === false ? v.why : "", /though this copy says 37909\.00/);
  });
});

describe("what must still be banked", () => {
  test("a different deposit from the same payer on the same day goes through", () => {
    const v = gateDeposit([fromReport], { amountCents: 45_283, receivedOn: "2026-09-08", payer: "Health Mart Atlas", sourceKey: "835|hma|31429473|2026-09-08", reference: "31429473" });
    assert.equal(v.bank, true);
  });

  test("the same amount from a different payer goes through", () => {
    const v = gateDeposit([fromReport], { amountCents: 3_790_927, receivedOn: "2026-09-08", payer: "Express Scripts", sourceKey: "835|esi|99|2026-09-08", reference: "9900123" });
    assert.equal(v.bank, true);
  });

  test("the same amount and payer well outside the window is a second payment, not a second copy", () => {
    const v = gateDeposit([fromReport], { amountCents: 3_790_927, receivedOn: "2026-10-08", payer: "Health Mart Atlas", sourceKey: "835|hma|later|2026-10-08", reference: "77777777" });
    assert.equal(v.bank, true);
  });

  /*
   * Typed by a person, off a bank statement. The bank is the record: if it shows two deposits of one
   * amount on one day then there were two, and refusing the second would be this code overruling the
   * document it exists to agree with.
   */
  test("a hand-typed receipt is never refused, whatever else is banked", () => {
    const v = gateDeposit([fromReport], { amountCents: 3_790_927, receivedOn: "2026-09-08", payer: "Health Mart Atlas", sourceKey: null, reference: "EFT-31434994" });
    assert.equal(v.bank, true);
  });

  test("a short reference cannot collide two unrelated payments", () => {
    const held: BankedReceipt = { ...fromReport, reference: "12" };
    const v = gateDeposit([held], { amountCents: 999, receivedOn: "2026-09-08", payer: "Someone Else", sourceKey: "835|se|12|2026-09-08", reference: "12" });
    assert.equal(v.bank, true, "two digits is not an identity");
  });
});

describe("the window itself", () => {
  test("seven days each way, and not eight", () => {
    assert.equal(withinWindow("2026-09-08", "2026-09-01"), true);
    assert.equal(withinWindow("2026-09-08", "2026-09-15"), true);
    assert.equal(withinWindow("2026-09-08", "2026-08-31"), false);
    assert.equal(withinWindow("2026-09-08", "2026-09-16"), false);
  });

  test("a missing date is never inside the window", () => {
    assert.equal(withinWindow(null, "2026-09-08"), false);
    assert.equal(withinWindow("2026-09-08", null), false);
  });

  test("the shift crosses a month end", () => {
    assert.equal(shiftDays("2026-09-01", -7), "2026-08-25");
    assert.equal(shiftDays("2026-08-31", 7), "2026-09-07");
  });
});
