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
});
