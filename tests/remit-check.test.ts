import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { remitCheck } from "../src/lib/remit-check";

const fill = (key: string, remitCents: number, later: { source: string; payer: string | null; amountCents: number }[]) => ({ key, rxNumber: key, fillNumber: 1, dateFilled: "2026-09-01", itemName: null, remitCents, laterPayments: later });

describe("remits against claims", () => {
  test("a plan's payment equal to the adjudicated remit agrees; short and over are named with the money", () => {
    const r = remitCheck([
      fill("a", 15_025, [{ source: "plan", payer: "Caremark", amountCents: 15_025 }]),
      fill("b", 20_000, [{ source: "plan", payer: "Caremark", amountCents: 18_000 }]),
      fill("c", 5_000, [{ source: "plan", payer: "ESI", amountCents: 5_250 }]),
      fill("d", 9_999, [{ source: "plan", payer: "ESI", amountCents: 10_000 }]),
    ]);
    assert.equal(r.checked, 4);
    assert.equal(r.agrees, 2, "a cent of rounding is not a finding");
    assert.deepEqual(r.short.map((l) => [l.key, l.differenceCents]), [["b", -2_000]]);
    assert.equal(r.shortCents, 2_000);
    assert.deepEqual(r.over.map((l) => [l.key, l.differenceCents]), [["c", 250]]);
  });
  test("the facilitator's and a card's money is on top of the remit, never a settlement of it", () => {
    const r = remitCheck([fill("a", 15_025, [{ source: "mtf", payer: "MTF", amountCents: 4_000 }])]);
    assert.equal(r.checked, 0);
    assert.equal(r.awaiting, 1, "adjudicated to a plan, and the plan has not paid yet");
    assert.equal(r.awaitingCents, 15_025);
  });
  test("a fill the plan paid nothing on at adjudication is not awaiting anything", () => {
    const r = remitCheck([fill("a", 0, [])]);
    assert.equal(r.awaiting, 0);
  });
});
