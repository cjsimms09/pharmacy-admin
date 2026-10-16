import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { depositsNotInBooks, distinctDeposits } from "../src/lib/account-deposits";
import type { AccountLine, AccountMonth } from "../src/lib/providerpay-account";

const dep = (date: string, pn: string | null, cents: number): AccountLine => ({ date, paymentNumber: pn, description: `ACME PBM ${pn}`, amountCents: cents, kind: "deposit", payer: "ACME PBM" });
const month = (...lines: AccountLine[]): AccountMonth => ({ lines, depositedCents: 0, transferredCents: 0, awaitingTransferCents: 0, sweeps: [], problems: [] });

describe("deposits the sweep account proves against the books", () => {
  test("a deposit whose payment number is on a receipt is in the books, whichever document banked it", () => {
    assert.equal(depositsNotInBooks([dep("2026-09-23", "900001", 100)], [{ reference: "900001", amountCents: 100, receivedOn: "2026-09-23" }]).length, 0);
  });
  test("a deposit with no receipt is named", () => {
    const r = depositsNotInBooks([dep("2026-09-23", "900001", 100)], []);
    assert.equal(r.length, 1);
  });
  test("a receipt filed under another number counts when the amount and day agree", () => {
    assert.equal(depositsNotInBooks([dep("2026-09-24", "900002", 200800)], [{ reference: "900009", amountCents: 200800, receivedOn: "2026-09-23" }]).length, 0);
  });
  test("one receipt cannot stand in for two deposits of the same amount", () => {
    const r = depositsNotInBooks([dep("2026-09-24", "900002", 200800), dep("2026-09-25", "900003", 200800)], [{ reference: "900009", amountCents: 200800, receivedOn: "2026-09-24" }]);
    assert.equal(r.length, 1);
  });
  test("an amount far from the day is not a match", () => {
    assert.equal(depositsNotInBooks([dep("2026-09-24", "900002", 200800)], [{ reference: null, amountCents: 200800, receivedOn: "2026-09-10" }]).length, 1);
  });
  test("two files holding one deposit count it once; transfers and money out are not deposits", () => {
    const l = dep("2026-09-23", "900001", 100);
    const t: AccountLine = { date: "2026-09-24", paymentNumber: null, description: "ProviderPay Transfer", amountCents: -100, kind: "transfer", payer: null };
    assert.equal(distinctDeposits([month(l, t), month({ ...l })]).length, 1);
  });
});
