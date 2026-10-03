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
  test("a fill coordinated across two plans is settled leg by leg, so the primary's 835 alone is not a short-pay", () => {
    const co = (later: { source: string; payer: string | null; amountCents: number }[]) => ({ ...fill("a", 18_000, later), payers: [{ name: "CVS Caremark", remitCents: 15_000 }, { name: "Kansas Medicaid", remitCents: 3_000 }] });
    const primaryOnly = remitCheck([co([{ source: "plan", payer: "Caremark", amountCents: 15_000 }])]);
    assert.equal(primaryOnly.short.length, 0, "the secondary has not paid yet; that is awaiting, not short");
    assert.equal(primaryOnly.agrees, 1);
    assert.equal(primaryOnly.awaiting, 1);
    assert.equal(primaryOnly.awaitingCents, 3_000);
    const unnamed = remitCheck([co([{ source: "plan", payer: null, amountCents: 15_000 }])]);
    assert.equal(unnamed.short.length, 0, "a payment naming nobody goes to the first unpaid leg, the primary");
    assert.equal(unnamed.awaitingCents, 3_000);
    const both = remitCheck([co([{ source: "plan", payer: "Caremark", amountCents: 15_000 }, { source: "plan", payer: "Medicaid", amountCents: 2_500 }])]);
    assert.equal(both.checked, 2);
    assert.deepEqual(both.short.map((l) => [l.payer, l.differenceCents]), [["Kansas Medicaid", -500]], "the short line names the leg that is short");
    assert.equal(both.awaiting, 0);
  });

  test("a fill the plan paid nothing on at adjudication is not awaiting anything", () => {
    const r = remitCheck([fill("a", 0, [])]);
    assert.equal(r.awaiting, 0);
  });
});
