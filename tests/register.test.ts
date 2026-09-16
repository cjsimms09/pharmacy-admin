import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkCardBatches, registerCardReceipt, registerReceipt, REGISTER_CARD_PAYER, type RegisterDay } from "../src/lib/register";
import { gateDeposit, type BankedReceipt } from "../src/lib/deposit-gate";

const day = (over: Partial<RegisterDay>): RegisterDay => ({ day: "2026-09-03", cashDepositCents: 0, checkDepositCents: 0, cardCents: 0, signatureOnlyCents: 0, chargedToAccountsCents: 0, accountPaymentsCents: 0, ...over });

describe("what a register day banks", () => {
  test("the drawers' cash and cheque deposit, as one receipt keyed to the day", () => {
    const r = registerReceipt(day({ cashDepositCents: 17_953, checkDepositCents: 1_842, cardCents: 270_435, signatureOnlyCents: 81_000, chargedToAccountsCents: 591 }));
    assert.equal(r?.amountCents, 19_795, "cash + cheques only");
    assert.equal(r?.sourceKey, "register|2026-09-03");
    assert.equal(r?.reference, "20260903", "digits, so two days depositing the same amount stay two deposits at the gate");
  });

  test("card takings, Signature Only pickups and account charges are never in the drawer deposit", () => {
    // Card money is banked separately or from its batch; a Signature Only pickup took no money (the owner, 15 September); a charge is owed.
    assert.equal(registerReceipt(day({ cardCents: 450_000, signatureOnlyCents: 81_000, chargedToAccountsCents: 591 })), null);
  });
});

describe("card takings banked from the register where no batch was ever forwarded", () => {
  test("its own key and its own figure, and nothing on a day that took no cards", () => {
    const r = registerCardReceipt(day({ day: "2026-09-01", cashDepositCents: 17_953, cardCents: 672_937 }));
    assert.equal(r?.sourceKey, "register-card|2026-09-01");
    assert.equal(r?.amountCents, 672_937, "the card total alone — the drawer deposit is a separate receipt");
    assert.equal(registerCardReceipt(day({ cashDepositCents: 17_953 })), null);
  });

  test("the day's drawer deposit does not refuse it at the gate", () => {
    /*
     * The fault this exists to catch. The gate refuses an incoming reference whose digits are already banked, before
     * it looks at which feed asked or what the payer was — so a card receipt referenced by the day alone would have
     * been refused by that same day's cash deposit, silently, and the money would have stayed out of the books with
     * the site reporting it banked.
     */
    const d = day({ day: "2026-09-01", cashDepositCents: 17_953, cardCents: 672_937 });
    const deposit = registerReceipt(d)!;
    const card = registerCardReceipt(d)!;
    const held: BankedReceipt[] = [{ amountCents: deposit.amountCents, receivedOn: d.day, payer: "Register cash and cheques", sourceKey: deposit.sourceKey, reference: deposit.reference }];
    assert.deepEqual(gateDeposit(held, { ...card, receivedOn: d.day, payer: REGISTER_CARD_PAYER }), { bank: true });
  });

  test("two days with identical card takings inside the window are both banked", () => {
    const a = registerCardReceipt(day({ day: "2026-09-01", cardCents: 672_937 }))!;
    const b = registerCardReceipt(day({ day: "2026-09-02", cardCents: 672_937 }))!;
    const held: BankedReceipt[] = [{ amountCents: a.amountCents, receivedOn: "2026-09-01", payer: REGISTER_CARD_PAYER, sourceKey: a.sourceKey, reference: a.reference }];
    assert.deepEqual(gateDeposit(held, { ...b, receivedOn: "2026-09-02", payer: REGISTER_CARD_PAYER }), { bank: true }, "two days' takings that happen to be equal are two takings");
  });

  test("a batch forwarded later is refused by the gate as well as replaced by the reader", () => {
    /*
     * `bankCardBatch` hands the stand-in's own row over to the batch, which is the mechanism. This is the backstop:
     * if that replacement were ever removed or missed, the gate still refuses a second receipt for the same money,
     * because the stand-in's payer shares its first eight letters with "Card batch".
     */
    const card = registerCardReceipt(day({ day: "2026-09-01", cardCents: 672_937 }))!;
    const held: BankedReceipt[] = [{ amountCents: card.amountCents, receivedOn: "2026-09-01", payer: REGISTER_CARD_PAYER, sourceKey: card.sourceKey, reference: card.reference }];
    const verdict = gateDeposit(held, { amountCents: 672_937, receivedOn: "2026-09-01", payer: "Card batch", sourceKey: "card-batch|4471", reference: "4471" });
    assert.equal(verdict.bank, false);
  });
});

describe("the register's card takings against the card batch", () => {
  test("P-6: equal on the days a batch is on file, and a day with takings and no batch is named", () => {
    const days = [day({ day: "2026-09-01", cardCents: 672_937 }), day({ day: "2026-09-03", cardCents: 270_435 }), day({ day: "2026-09-06", cardCents: 0 })];
    const r = checkCardBatches(days, new Map([["2026-09-03", 270_435]]));
    assert.equal(r.agree, 1);
    assert.deepEqual(r.missing, [{ day: "2026-09-01", cents: 672_937 }]);
    assert.deepEqual(r.differs, [], "a day with no card takings is neither missing nor different");
  });

  test("a batch that disagrees with the register is named with both figures", () => {
    const r = checkCardBatches([day({ cardCents: 270_435 })], new Map([["2026-09-03", 270_000]]));
    assert.deepEqual(r.differs, [{ day: "2026-09-03", registerCents: 270_435, batchCents: 270_000 }]);
  });
});
