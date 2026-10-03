import { test, describe } from "node:test";
import assert from "node:assert/strict";

/*
 * The netting rule, tested on its own arithmetic rather than against the database.
 *
 * The question the owner asked is "is it a credit, and will the insurance take it back", and the
 * answer the site has to encode is: it is neither revenue nor a credit the pharmacy issues, it is
 * cash held against a takeback that has not arrived yet. So the only thing worth testing here is
 * that a fill closes when the plan recovers the money and stays open when it does not.
 */
type Payment = { amountCents: number; receivedOn: string | null };

/** The same fold `paymentsOnReversedFills` performs over one fill's payments. */
function net(payments: Payment[]): { netCents: number; paidCents: number; takenBackCents: number } {
  let netCents = 0;
  let paidCents = 0;
  let takenBackCents = 0;
  for (const p of payments) {
    netCents += p.amountCents;
    if (p.amountCents >= 0) paidCents += p.amountCents;
    else takenBackCents += -p.amountCents;
  }
  return { netCents, paidCents, takenBackCents };
}

describe("money paid on a fill the pharmacy reversed", () => {
  test("a takeback of the same amount closes it out", () => {
    const r = net([
      { amountCents: 4_231, receivedOn: "2026-09-02" },
      { amountCents: -4_231, receivedOn: "2026-09-19" },
    ]);
    assert.equal(r.netCents, 0, "nothing is held once the plan has recovered it");
    assert.equal(r.paidCents, 4_231);
    assert.equal(r.takenBackCents, 4_231);
  });

  test("a partial recovery leaves the remainder held, not the whole payment", () => {
    const r = net([
      { amountCents: 4_231, receivedOn: "2026-09-02" },
      { amountCents: -3_000, receivedOn: "2026-09-19" },
    ]);
    assert.equal(r.netCents, 1_231);
  });

  test("no takeback leaves the whole payment held", () => {
    const r = net([{ amountCents: 4_231, receivedOn: "2026-09-02" }]);
    assert.equal(r.netCents, 4_231);
    assert.equal(r.takenBackCents, 0);
  });

  test("a plan that recovers more than it paid leaves a negative, which is also worth seeing", () => {
    // Not hypothetical: a plan recovering against the wrong fill takes back money it never sent.
    const r = net([
      { amountCents: 4_231, receivedOn: "2026-09-02" },
      { amountCents: -4_231, receivedOn: "2026-09-19" },
      { amountCents: -4_231, receivedOn: "2026-09-26" },
    ]);
    assert.equal(r.netCents, -4_231, "an over-recovery does not net to zero and must not disappear");
  });
});
