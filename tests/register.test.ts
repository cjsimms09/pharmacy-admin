import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkCardBatches, registerReceipt, type RegisterDay } from "../src/lib/register";

const day = (over: Partial<RegisterDay>): RegisterDay => ({ day: "2026-09-03", cashDepositCents: 0, checkDepositCents: 0, cardCents: 0, signatureOnlyCents: 0, chargedToAccountsCents: 0, accountPaymentsCents: 0, ...over });

describe("what a register day banks", () => {
  test("the drawers' cash and cheque deposit, as one receipt keyed to the day", () => {
    const r = registerReceipt(day({ cashDepositCents: 17_953, checkDepositCents: 1_842, cardCents: 270_435, signatureOnlyCents: 81_000, chargedToAccountsCents: 591 }));
    assert.equal(r?.amountCents, 19_795, "cash + cheques only");
    assert.equal(r?.sourceKey, "register|2026-09-03");
    assert.equal(r?.reference, "20260903", "digits, so two days depositing the same amount stay two deposits at the gate");
  });

  test("card takings, Signature Only pickups and account charges are never banked here", () => {
    // Card money is banked from its batch; a Signature Only pickup took no money (the owner, 15 September); a charge is owed.
    assert.equal(registerReceipt(day({ cardCents: 450_000, signatureOnlyCents: 81_000, chargedToAccountsCents: 591 })), null);
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
