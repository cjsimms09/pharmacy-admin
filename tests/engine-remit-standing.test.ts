import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { standings } from "../src/lib/engine/remit-standing";

describe("what stands for a remittance at the bank", () => {
  const row = { id: "r", payerName: "SS&C HEALTH", remitOn: "2026-09-23", amountCents: 200_800, paymentNumber: "999000000000011", remitNumber: "7000000011", source: "providerpay remit summary" };
  const none = { amountCents: 1, receivedOn: "2026-01-01", reference: null, sourceKey: null };

  test("the payment number first: the report and the 835 share it", () => {
    assert.deepEqual(standings([row], [none, { amountCents: 5, receivedOn: "2026-02-02", reference: "999000000000011", sourceKey: null }]), ["payment number"]);
  });
  test("then the remittance number inside a receipt's key", () => {
    assert.deepEqual(standings([{ ...row, paymentNumber: null }], [none, { amountCents: 5, receivedOn: "2026-02-02", reference: null, sourceKey: "835|ss&c health|7000000011|2026-09-23" }]), ["remittance number"]);
  });
  test("then the same amount inside a fortnight (an advice can run twelve days ahead of its money), and nothing beyond it", () => {
    assert.deepEqual(standings([{ ...row, paymentNumber: null, remitOn: "2026-09-03" }], [{ amountCents: 200_800, receivedOn: "2026-09-15", reference: null, sourceKey: null }]), ["amount in window"]);
    assert.deepEqual(standings([{ ...row, paymentNumber: null }], [{ amountCents: 200_800, receivedOn: "2026-10-24", reference: null, sourceKey: null }]), [null]);
  });
  test("a receipt stands for one remittance only, and the stronger evidence takes it", () => {
    const early = { ...row, id: "a", remitOn: "2026-09-15", paymentNumber: "999000000000012", remitNumber: "7000000012" };
    const later = { ...row, id: "b", remitOn: "2026-09-23", paymentNumber: null, remitNumber: "7000000013" };
    const receipt = { amountCents: 200_800, receivedOn: "2026-09-24", reference: "7000000013", sourceKey: "835|ss&c health|7000000013|2026-09-23" };
    assert.deepEqual(standings([early, later], [receipt]), [null, "remittance number"]);
  });
  test("two remittances of one amount a day apart need two receipts", () => {
    const a = { ...row, id: "a", remitOn: "2026-09-15", paymentNumber: null, remitNumber: "7000000014" };
    const b = { ...row, id: "b", remitOn: "2026-09-16", paymentNumber: null, remitNumber: "7000000015" };
    const one = { amountCents: 200_800, receivedOn: "2026-09-17", reference: null, sourceKey: null };
    assert.deepEqual(standings([a, b], [one]), ["amount in window", null]);
    assert.deepEqual(standings([a, b], [one, { ...one, receivedOn: "2026-09-18" }]), ["amount in window", "amount in window"]);
  });

  /*
   * The 15 and 23 September pair: one $2,008.00 deposit, keyed to the later remittance's number because that was the only advice on paper,
   * and ProviderPay's account history showing it under the earlier remittance's payment number. `deposit` is what engine/remit-sweep.ts
   * hands over once that history has been joined to a placed bank line; `rec-1` is the receipt that bank line confirmed.
   */
  describe("a deposit ProviderPay's account history shows under the payment number", () => {
    const early = { ...row, id: "a", remitOn: "2026-09-15", paymentNumber: "999000000000012", remitNumber: "7000000012" };
    const later = { ...row, id: "b", remitOn: "2026-09-23", paymentNumber: null, remitNumber: "7000000013" };
    const rec1 = { id: "rec-1", amountCents: 200_800, receivedOn: "2026-09-24", reference: "7000000013", sourceKey: "835|ss&c health|7000000013|2026-09-23" };
    const deposit = { paymentNumber: "999000000000012", amountCents: 200_800, lineReceiptIds: ["rec-1"] };

    test("stands for the remittance it is under, and spends the receipt that was keyed to the other one", () => {
      assert.deepEqual(standings([early, later], [rec1]), [null, "remittance number"], "without the history the later one takes the receipt, as it always did");
      assert.deepEqual(standings([early, later], [rec1], [deposit]), ["sweep deposit", null]);
    });

    test("is spent once: a second remittance with the same payment number and amount is not also banked by it", () => {
      const twin = { ...early, id: "c", remitOn: "2026-09-16", remitNumber: "7000000016" };
      assert.deepEqual(standings([early, twin], [], [deposit]), ["sweep deposit", null]);
    });

    test("must be the remittance's own amount", () => {
      assert.deepEqual(standings([early, later], [rec1], [{ ...deposit, amountCents: 200_799 }]), [null, "remittance number"]);
    });

    test("a receipt carrying the payment number still comes first, and leaves the deposit alone", () => {
      const byNumber = { id: "rec-2", amountCents: 200_800, receivedOn: "2026-09-24", reference: "999000000000012", sourceKey: null };
      assert.deepEqual(standings([early, later], [byNumber, rec1], [deposit]), ["payment number", "remittance number"]);
    });

    test("the history is read before any other remittance's claim, so a receipt carrying the other remittance's payment number is still spent on the one the history proves", () => {
      const other = { ...later, paymentNumber: "999000000000013" };
      const carrying = { ...rec1, reference: "999000000000013" };
      assert.deepEqual(standings([early, other], [carrying], [deposit]), ["sweep deposit", null]);
    });

    test("where the bank line made no receipt there is nothing to spend, and the other remittance keeps its own", () => {
      assert.deepEqual(standings([early, later], [rec1], [{ ...deposit, lineReceiptIds: [] }]), ["sweep deposit", "remittance number"]);
    });

    test("spends only a receipt of the remittance's amount", () => {
      const smaller = { ...rec1, amountCents: 100_000 };
      assert.deepEqual(standings([early, later], [smaller], [deposit]), ["sweep deposit", "remittance number"]);
    });

    test("no payment number, or one too short to be one, is never banked by a deposit", () => {
      assert.deepEqual(standings([{ ...early, paymentNumber: null }], [], [deposit]), [null]);
      assert.deepEqual(standings([{ ...early, paymentNumber: "12345" }], [], [{ ...deposit, paymentNumber: "12345" }]), [null]);
      assert.deepEqual(standings([{ ...early, paymentNumber: "123456" }], [], [{ ...deposit, paymentNumber: "123456" }]), ["sweep deposit"], "six digits is enough");
    });
  });
});
