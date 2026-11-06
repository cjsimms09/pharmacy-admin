import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cashPlanFor, isCashPlan, readPayerMoney, type CashPlan } from "../src/lib/cash-plans";

/**
 * The owner: "There is no third party remit from pharmd. Whatever the copay is is the only money we
 * receive." The figures are September's real ones — the pharmacy's cash plan is RxLocal on BIN
 * 028249, 277 fills, $12,427.69 collected from patients, and three fills carrying $418.22 of
 * "remit" that is not money and was booked as though it were.
 */
const rxlocal: CashPlan = { bin: "028249", pcn: "RXLOCAL", name: "Pharm D (RxLocal)" };
const wholeBin: CashPlan = { bin: "610455", pcn: null, name: "A cash plan named by BIN alone" };

describe("which plans are cash plans", () => {
  test("the pharmacy's own is found by BIN and PCN", () => {
    assert.equal(isCashPlan("028249", "RXLOCAL", [rxlocal]), true);
    assert.equal(cashPlanFor("028249", "RXLOCAL", [rxlocal])?.name, "Pharm D (RxLocal)");
  });

  test("a real payer on a different BIN is not one", () => {
    assert.equal(isCashPlan("610455", "BCBSKS", [rxlocal]), false);
  });

  /*
   * The case that makes PCN matter. A BIN can carry a dozen plans and only one of them be cash;
   * matching on BIN alone would take a paying Part D plan's remit to nought and lose real revenue —
   * the opposite error, and a much more expensive one.
   */
  test("the same BIN under another PCN is not a cash plan", () => {
    assert.equal(isCashPlan("028249", "ENROLL", [rxlocal]), false);
  });

  test("a row with no PCN covers the whole BIN", () => {
    assert.equal(isCashPlan("610455", "BCBSKS", [wholeBin]), true);
    assert.equal(isCashPlan("610455", null, [wholeBin]), true);
  });

  test("a PCN row wins over a BIN-wide row, never the other way round", () => {
    const plans = [{ bin: "028249", pcn: null, name: "the whole BIN" }, rxlocal];
    assert.equal(cashPlanFor("028249", "RXLOCAL", plans)?.name, "Pharm D (RxLocal)");
    assert.equal(cashPlanFor("028249", "OTHER", plans)?.name, "the whole BIN");
  });

  test("case and stray spaces do not decide it", () => {
    assert.equal(isCashPlan(" 028249 ", "rxlocal", [rxlocal]), true);
  });

  test("no BIN is not a cash plan", () => {
    assert.equal(isCashPlan(null, "RXLOCAL", [rxlocal]), false);
    assert.equal(isCashPlan("", "RXLOCAL", [rxlocal]), false);
  });
});

describe("reading a payer's money", () => {
  test("a real payer is left exactly as it was", () => {
    const payer = { bin: "610455", pcn: "BCBSKS", remitCents: 8_000, copayCents: 1_000 };
    const r = readPayerMoney(payer, [rxlocal]);
    assert.deepEqual(r.payer, payer);
    assert.equal(r.plan, null);
    assert.equal(r.discountGivenCents, 0);
  });

  /*
   * September's Omnipod: $2,273.10 of price, $2,201.29 taken from the patient, and $71.81 that the
   * claim calls a payment. The two add to the price exactly, which is what gives it away — nobody
   * paid the $71.81, the patient simply was not charged it. Booking it would put $71.81 of revenue
   * in the month and $71.81 of receivable against a payer that has never sent a cheque.
   */
  test("a cash plan remits nothing, and what it appeared to pay is named as a discount", () => {
    const r = readPayerMoney({ bin: "028249", pcn: "RXLOCAL", remitCents: 7_181, copayCents: 220_129 }, [rxlocal]);
    assert.equal(r.payer.remitCents, 0, "never revenue, never a receivable");
    assert.equal(r.payer.copayCents, 220_129, "the copay is the money, and it was collected");
    assert.equal(r.discountGivenCents, 7_181);
    assert.equal(r.plan?.name, "Pharm D (RxLocal)");
  });

  test("the ordinary cash-plan fill, where nothing was ever claimed to be paid", () => {
    const r = readPayerMoney({ bin: "028249", pcn: "RXLOCAL", remitCents: 0, copayCents: 4_500 }, [rxlocal]);
    assert.equal(r.payer.remitCents, 0);
    assert.equal(r.discountGivenCents, 0, "no discount, just a cash sale");
    assert.notEqual(r.plan, null);
  });

  test("a null remit on a cash plan is nought, not null, so a total cannot be tripped by it", () => {
    const r = readPayerMoney({ bin: "028249", pcn: "RXLOCAL", remitCents: null, copayCents: 4_500 }, [rxlocal]);
    assert.equal(r.payer.remitCents, 0);
    assert.equal(r.discountGivenCents, 0);
  });

  /*
   * A reversal must survive untouched. It is paired with the claim it cancels by a key built from
   * its own figures, so zeroing it strands the partner and leaves the original standing as revenue.
   * September had two of these on the cash plan, on a Wegovy and an Omnipod.
   */
  test("a reversal on a cash plan is left exactly as it is", () => {
    const rev = { bin: "028249", pcn: "RXLOCAL", remitCents: -17_210, copayCents: -153_005 };
    const r = readPayerMoney(rev, [rxlocal]);
    assert.deepEqual(r.payer, rev, "nothing changed");
    assert.equal(r.discountGivenCents, 0, "a cancellation is not a discount");
    assert.notEqual(r.plan, null, "still recognised as the cash plan");
  });

  test("the input is not mutated", () => {
    const payer = { bin: "028249", pcn: "RXLOCAL", remitCents: 7_181, copayCents: 220_129 };
    readPayerMoney(payer, [rxlocal]);
    assert.equal(payer.remitCents, 7_181, "the caller's row is its own");
  });

  test("September's three, added up", () => {
    const three = [
      { bin: "028249", pcn: "RXLOCAL", remitCents: 7_181, copayCents: 220_129 },
      { bin: "028249", pcn: "RXLOCAL", remitCents: 17_431, copayCents: 118_213 },
      { bin: "028249", pcn: "RXLOCAL", remitCents: 17_210, copayCents: 153_501 },
    ].map((p) => readPayerMoney(p, [rxlocal]));
    assert.equal(three.reduce((n, r) => n + r.discountGivenCents, 0), 41_822, "$418.22 that was never money");
    assert.equal(three.reduce((n, r) => n + (r.payer.remitCents ?? 0), 0), 0);
    assert.equal(three.reduce((n, r) => n + (r.payer.copayCents ?? 0), 0), 491_843, "$4,918.43 that was");
  });
});
