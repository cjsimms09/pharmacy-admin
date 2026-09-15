import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { owedByPayer, splitReceivable, voucherProgrammeFor, type Receivable, type Received } from "../src/lib/payer-owed";

/*
 * A manufacturer voucher inside a claim's remit is owed by the voucher programme, not the plan (money map section 15).
 * Invented BINs and figures; the RedSail BIN is the one the copay-voucher reader already names.
 */
const PLAN_BIN = "999003";
const DAY = "2026-09-10";

describe("a claim's receivable with a voucher in it", () => {
  test("the plan owes the remit less the voucher, and the programme the voucher", () => {
    assert.deepEqual(splitReceivable(91347, 10000), { planCents: 81347, voucherCents: 10000 });
  });

  test("where the remit is all voucher, the plan owes nothing", () => {
    assert.deepEqual(splitReceivable(10118, 10118), { planCents: 0, voucherCents: 10118 });
  });

  test("a claim with no voucher is exactly as before", () => {
    assert.deepEqual(splitReceivable(5000, 0), { planCents: 5000, voucherCents: 0 });
  });

  test("a voucher larger than the remit is capped at it, so the claim is never billed more than it carries", () => {
    assert.deepEqual(splitReceivable(4000, 6000), { planCents: 0, voucherCents: 4000 });
  });

  test("RedSail's copay voucher owes the claims on its own BIN; Veridikal the rest", () => {
    assert.equal(voucherProgrammeFor("028249"), "RedSail Technologies (RAS copay voucher)");
    assert.equal(voucherProgrammeFor(PLAN_BIN), "Veridikal (eVoucher)");
    assert.equal(voucherProgrammeFor(null), "Veridikal (eVoucher)");
  });
});

describe("who a voucher payment settles", () => {
  const { planCents, voucherCents } = splitReceivable(91347, 10000);
  const receivables: Receivable[] = [
    { bin: PLAN_BIN, name: "Test Plan", dateFilled: DAY, cents: planCents, cashPlan: false },
    { bin: null, name: voucherProgrammeFor(PLAN_BIN), dateFilled: DAY, cents: voucherCents, cashPlan: false },
  ];
  const veridikal: Received = { bin: null, payer: voucherProgrammeFor(PLAN_BIN), cents: 10000, receivedOn: "2026-10-05", matched: true };
  const plan: Received = { bin: PLAN_BIN, payer: "Test Plan", cents: 81347, receivedOn: "2026-09-20", matched: true };

  test("the voucher paid and the plan not: the plan still owes all of its share", () => {
    const s = owedByPayer(receivables, [veridikal], "2026-10-10");
    const planLine = s.lines.find((l) => l.bin === PLAN_BIN)!;
    const voucherLine = s.lines.find((l) => l.name === "Veridikal (eVoucher)")!;
    assert.equal(planLine.receivedCents, 0);
    assert.equal(planLine.outstandingCents, 81347);
    assert.equal(voucherLine.outstandingCents, 0);
  });

  test("both paid: both settled, and nothing is over", () => {
    const s = owedByPayer(receivables, [veridikal, plan], "2026-10-10");
    assert.equal(s.outstandingCents, 0);
    assert.ok(s.lines.every((l) => l.state === "settled"), JSON.stringify(s.lines.map((l) => [l.name, l.state])));
  });
});
