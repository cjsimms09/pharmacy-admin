import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { carriedForVeridikalRow, claimShares, newRevenueCents, owedByPayer, type Receivable, type Received, type VoucherFields } from "../src/lib/payer-owed";
import { COPAY_PAYER } from "../src/lib/copay-remit";

/*
 * Who owes what on a claim a manufacturer programme pays part or all of (`claimShares`). The owner: "the evoucher is a
 * secondary". The three cases were measured on PioneerRx and the programmes' reports (P-1, P-2, P-5). Invented BINs and
 * figures; the conversion's shape follows P-5's sample rows ($668.86 ingredient, $671.36 net).
 */
const PLAN_BIN = "999003";
const DAY = "2026-10-10";
const EVOUCHER = "Veridikal (eVoucher)";
const CONVERSION = "Veridikal (Denial Conversion)";

describe("who owes what on a claim with a programme's money in it", () => {
  test("a claim with no voucher is owed by its plan, exactly as before", () => {
    assert.deepEqual(claimShares({ remitCents: 5000, evoucherCents: 0 }), { kind: "none", planCents: 5000, programme: null, programmeCents: 0, unpaidFeeCents: 0, from: null });
  });

  test("a RedSail voucher: the plan owes the net less the voucher, RedSail the voucher", () => {
    const s = claimShares({ remitCents: 91347, evoucherCents: 10000, evoucherProgramme: "RedSail" });
    assert.deepEqual(s, { kind: "redsail_voucher", planCents: 81347, programme: COPAY_PAYER, programmeCents: 10000, unpaidFeeCents: 0, from: "programme" });
  });

  test("where the voucher is the whole net, as on a cash plan, the plan owes nothing", () => {
    assert.equal(claimShares({ remitCents: 10118, evoucherCents: 10118, evoucherProgramme: "RedSail" }).planCents, 0);
  });

  test("a Veridikal eVoucher: the plan owes net − voucher − $2.50, Veridikal the voucher and its $2.50", () => {
    const s = claimShares({ remitCents: 22250, evoucherCents: 0, evoucherMessageCents: 10000, evoucherProgramme: "Veridikal" });
    assert.deepEqual(s, { kind: "veridikal_evoucher", planCents: 12000, programme: EVOUCHER, programmeCents: 10250, unpaidFeeCents: 0, from: "programme" });
  });

  test("a Veridikal denial conversion: the plan on the claim owes nothing, Veridikal the net less $0.50, which nobody pays", () => {
    const s = claimShares({ remitCents: 67136, evoucherCents: 0, evoucherMessageCents: 67136, evoucherProgramme: "Veridikal conversion" });
    assert.deepEqual(s, { kind: "veridikal_conversion", planCents: 0, programme: CONVERSION, programmeCents: 67086, unpaidFeeCents: 50, from: "programme" });
  });

  test("the shares and the unpaid fee always add back to the net: nothing is added to the claim", () => {
    const cases: VoucherFields[] = [
      { remitCents: 5000, evoucherCents: 0 },
      { remitCents: 91347, evoucherCents: 10000, evoucherProgramme: "RedSail" },
      { remitCents: 22250, evoucherCents: 0, evoucherMessageCents: 10000, evoucherProgramme: "Veridikal" },
      { remitCents: 67136, evoucherCents: 0, evoucherMessageCents: 67136, evoucherProgramme: "Veridikal conversion" },
      { remitCents: 4000, evoucherCents: 6000, evoucherProgramme: "RedSail" },
      { remitCents: 10000, evoucherCents: 0, evoucherMessageCents: 9900, evoucherProgramme: "Veridikal" },
      { remitCents: 30, evoucherCents: 0, evoucherMessageCents: 30, evoucherProgramme: "Veridikal" },
    ];
    for (const c of cases) {
      const s = claimShares(c);
      assert.equal(s.planCents + s.programmeCents + s.unpaidFeeCents, c.remitCents, JSON.stringify(c));
      assert.ok(s.planCents >= 0 && s.programmeCents >= 0 && s.unpaidFeeCents >= 0, JSON.stringify(c));
    }
  });

  test("an amount larger than the net is capped at it, so a claim is never billed more than it carries", () => {
    assert.deepEqual(claimShares({ remitCents: 4000, evoucherCents: 6000, evoucherProgramme: "RedSail" }).programmeCents, 4000);
  });

  test("a negative net is a fee owed by the pharmacy, not a voucher claim", () => {
    assert.equal(claimShares({ remitCents: -1500, evoucherCents: 1000, evoucherProgramme: "RedSail" }).kind, "none");
  });
});

describe("a claim whose voucher message has not been read", () => {
  /*
   * Measured 15 September: no claim on live has a programme or message amount yet, and all 53 voucher claims carry the
   * amount in EvoucherAmountPaid. PioneerRx puts RedSail's there and Veridikal's in the message column.
   */
  test("an amount in EvoucherAmountPaid is RedSail's, and says it was taken from the column", () => {
    const s = claimShares({ remitCents: 23833, evoucherCents: 7732 });
    assert.equal(s.kind, "redsail_voucher");
    assert.equal(s.programme, COPAY_PAYER);
    assert.equal(s.from, "column");
  });

  test("an amount in the message column is Veridikal's", () => {
    const s = claimShares({ remitCents: 22250, evoucherCents: 0, evoucherMessageCents: 10000 });
    assert.equal(s.kind, "veridikal_evoucher");
    assert.equal(s.from, "column");
  });

  test("a programme that has been read wins over the column", () => {
    assert.equal(claimShares({ remitCents: 22250, evoucherCents: 10000, evoucherProgramme: "Veridikal" }).kind, "veridikal_evoucher");
  });

  test("a claim that says it is a conversion is one, whatever the amounts look like", () => {
    /* The pull writes "Veridikal conversion" where the message names RelayHealth as the primary payer. */
    const s = claimShares({ remitCents: 67136, evoucherCents: 0, evoucherMessageCents: 20000, evoucherProgramme: "Veridikal conversion" });
    assert.equal(s.kind, "veridikal_conversion");
    assert.equal(s.planCents, 0);
    assert.equal(s.from, "programme");
  });

  test("a claim that says eVoucher is not read as a conversion, however much the message covers", () => {
    /*
     * P-2 measured one Veridikal claim in forty whose message equals the net while the plan really paid $412.89 of it.
     * Read as a conversion, the plan would owe nothing and its payment would look like an overpayment.
     */
    const s = claimShares({ remitCents: 49174, evoucherCents: 0, evoucherMessageCents: 49174, evoucherProgramme: "Veridikal" });
    assert.equal(s.kind, "veridikal_evoucher");
    assert.equal(s.programme, "Veridikal (eVoucher)");
    assert.equal(s.unpaidFeeCents, 0, "an eVoucher leaves nothing unpaid; only a conversion does");
  });

  test("with nothing read, the whole net still looks like a conversion and is treated as one", () => {
    assert.equal(claimShares({ remitCents: 67136, evoucherCents: 0, evoucherMessageCents: 67136 }).kind, "veridikal_conversion");
  });

  test("the old rule, by BIN, is gone: a RedSail voucher on a plan's BIN is RedSail's", () => {
    assert.equal(claimShares({ remitCents: 91347, evoucherCents: 10000 }).programme, COPAY_PAYER);
  });
});

describe("how much of a Veridikal row the claim already carries, which is not new revenue", () => {
  const evRow = { paymentCents: 10000, thirdPartyDueCents: 12000 };
  const evClaim = { remitCents: 22250, evoucherCents: 0, evoucherMessageCents: 10000, evoucherProgramme: "Veridikal" };
  const revenue = newRevenueCents;

  test("the arithmetic: only what is beyond the claim is new, with the payment's sign", () => {
    assert.equal(newRevenueCents(10350, 10250), 100, "a voucher $1.00 over the claim's adds $1.00, not the whole row");
    assert.equal(newRevenueCents(-10350, 10250), -100);
    assert.equal(newRevenueCents(9000, 10250), 0, "paying less than the claim carries is not negative revenue here");
    assert.equal(newRevenueCents(5000, 0), 5000);
  });

  test("an eVoucher of $100.00 with its $2.50 fee, on the claim it belongs to, adds nothing", () => {
    const carried = carriedForVeridikalRow("evoucher", evRow, evClaim);
    assert.equal(carried, 10250);
    assert.equal(revenue(10250, carried), 0);
  });

  test("its reversal takes nothing back from revenue either", () => {
    assert.equal(revenue(-10250, carriedForVeridikalRow("evoucher", { paymentCents: -10000, thirdPartyDueCents: -12000 }, evClaim)), 0);
  });

  test("on a claim whose message is not read, the row is asked whether its plan share, voucher and $2.50 make the net", () => {
    assert.equal(carriedForVeridikalRow("evoucher", evRow, { remitCents: 22250, evoucherCents: 10000 }), 10250);
    assert.equal(carriedForVeridikalRow("evoucher", evRow, { remitCents: 5000, evoucherCents: 0 }), 0, "a claim that does not carry it: all new");
  });

  test("a conversion of $150.00 with its $2.00 fee, on the claim it belongs to, adds nothing and is $0.50 short of the net", () => {
    const claim = { remitCents: 15250, evoucherCents: 0, evoucherMessageCents: 15250, evoucherProgramme: "Veridikal conversion" };
    const carried = carriedForVeridikalRow("denial_conversion", { paymentCents: 15000, thirdPartyDueCents: null }, claim);
    assert.equal(carried, 15250);
    assert.equal(revenue(15200, carried), 0);
    assert.equal(claimShares(claim).unpaidFeeCents, 50);
  });

  test("a conversion on a claim whose message is not read is known by its ingredient and $2.50 making the net", () => {
    assert.equal(carriedForVeridikalRow("denial_conversion", { paymentCents: 15000, thirdPartyDueCents: null }, { remitCents: 15250, evoucherCents: 0 }), 15250);
    assert.equal(carriedForVeridikalRow("denial_conversion", { paymentCents: 15000, thirdPartyDueCents: null }, { remitCents: 9000, evoucherCents: 0 }), 0);
  });
});

describe("who a programme's payment settles", () => {
  const ev = claimShares({ remitCents: 22250, evoucherCents: 0, evoucherMessageCents: 10000, evoucherProgramme: "Veridikal" });
  const conv = claimShares({ remitCents: 67136, evoucherCents: 0, evoucherMessageCents: 67136, evoucherProgramme: "Veridikal conversion" });
  const receivables: Receivable[] = [
    { bin: PLAN_BIN, name: "Test Plan", dateFilled: DAY, cents: ev.planCents, cashPlan: false },
    { bin: null, name: ev.programme, dateFilled: DAY, cents: ev.programmeCents, cashPlan: false },
    { bin: null, name: conv.programme, dateFilled: DAY, cents: conv.programmeCents, cashPlan: false },
  ];
  const veridikal: Received = { bin: null, payer: EVOUCHER, cents: 10250, receivedOn: "2026-11-05", matched: true };
  const conversion: Received = { bin: null, payer: CONVERSION, cents: 67086, receivedOn: "2026-11-05", matched: true };
  const plan: Received = { bin: PLAN_BIN, payer: "Test Plan", cents: 12000, receivedOn: "2026-10-20", matched: true };

  test("the voucher paid and the plan not: the plan still owes all of its share", () => {
    const s = owedByPayer(receivables, [veridikal, conversion], "2026-11-10");
    assert.equal(s.lines.find((l) => l.bin === PLAN_BIN)!.outstandingCents, 12000);
    assert.equal(s.lines.find((l) => l.name === EVOUCHER)!.outstandingCents, 0);
  });

  test("everything paid: every line settled, the conversion included, and nothing over", () => {
    const s = owedByPayer(receivables, [veridikal, conversion, plan], "2026-11-10");
    assert.equal(s.outstandingCents, 0);
    assert.ok(s.lines.every((l) => l.state === "settled"), JSON.stringify(s.lines.map((l) => [l.name, l.state])));
  });
});
