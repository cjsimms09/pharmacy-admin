import test from "node:test";
import assert from "node:assert/strict";
import { groupIntoFills, payerShares, sharesReconcile, type ClaimRow } from "../src/lib/fills";

/*
 * The owner: "I've noticed we tend to assert all the profit to one payor which doesn't make sense."
 *
 * He is right, and it is wrong twice on the same 22 fills. PioneerRx puts the whole cost on the
 * primary's row and none on the secondary's, so the primary reads as a loss and the secondary as
 * pure profit. The site's own payer scores key every fill on payers[0], so the primary is credited
 * with the secondary's remit and a payor that only ever appears second never appears at all.
 */

const row = (o: Partial<ClaimRow> & { bin: string }): ClaimRow =>
  ({
    rxNumber: "RX1", fillNumber: 1, dateFilled: "2026-06-01", ndc11: "00093721698",
    pcn: null, groupNumber: null, pbmName: null, payerLabel: null, status: "paid",
    remitCents: 0, copayCents: 0, acquisitionCents: null, quantityThousandths: 30_000, cashPlan: false,
    ...o,
  }) as ClaimRow;

/*
 * The pharmacy's own coordinated shape, at the scale the drill-down reports it: a primary paying
 * $462.50 and RxRescue paying $458.29 against a bottle that cost $1,306.23.
 */
const coordinated = () =>
  groupIntoFills([
    row({ bin: "610011", remitCents: 46_250, acquisitionCents: 130_623 }),
    row({ bin: "024284", remitCents: 45_829, acquisitionCents: 130_623 }),
  ])[0];

test("both payors carry a share of the cost — neither is pure profit, neither eats it all", () => {
  const shares = payerShares(coordinated());
  assert.equal(shares.length, 2);
  // PioneerRx says the primary lost $843.73 and RxRescue earned $458.29. Both are fictions.
  assert.ok(shares[0].marginCents! < 0, "the primary is underwater");
  assert.ok(shares[1].marginCents! < 0, "and so is the secondary — this fill loses money");
  assert.notEqual(shares[1].marginCents, 45_829, "the secondary is never credited with pure profit");
});

test("the shares add back up to the fill exactly, which is the whole test of the convention", () => {
  const fill = coordinated();
  assert.equal(sharesReconcile(fill), 0);
});

test("what each payor is owed is its own remit, untouched by the other", () => {
  const shares = payerShares(coordinated());
  // This is the only figure an 835 settles: a remittance arrives against this payor's own claim.
  assert.equal(shares[0].receivableCents, 46_250);
  assert.equal(shares[1].receivableCents, 45_829);
});

test("cost is split on remit, so the payor that paid more carries more of the bottle", () => {
  const shares = payerShares(coordinated());
  assert.ok(shares[0].costShareCents! > shares[1].costShareCents!, "610011 paid more, so it carries more");
  assert.equal(shares[0].costShareCents! + shares[1].costShareCents!, 130_623, "and the two shares are the whole bottle");
});

test("a single-payor fill is unchanged: the whole cost, the whole margin, one payor", () => {
  const fill = groupIntoFills([row({ bin: "610011", remitCents: 10_000, acquisitionCents: 6_000 })])[0];
  const shares = payerShares(fill);
  assert.equal(shares.length, 1);
  assert.equal(shares[0].costShareCents, 6_000);
  assert.equal(shares[0].marginCents, 4_000);
  assert.equal(sharesReconcile(fill), 0);
});

test("payors who together paid nothing get no cost share, rather than one of them getting all of it", () => {
  // Nought divided by nought is not a share, and a made-up one puts the bottle on whoever was first.
  const fill = groupIntoFills([
    row({ bin: "610011", remitCents: 0, copayCents: 5_000, acquisitionCents: 3_000 }),
  ])[0];
  const shares = payerShares(fill);
  assert.equal(shares[0].costShareCents, null);
  assert.equal(shares[0].marginCents, null);
});

test("the patient's money is given to no payor", () => {
  // The patient pays the residual *because* the plans did not. Crediting it to a plan would reward
  // a payor for covering less.
  const fill = groupIntoFills([
    row({ bin: "610011", remitCents: 4_000, copayCents: 2_000, acquisitionCents: 5_000 }),
  ])[0];
  const shares = payerShares(fill);
  assert.equal(shares[0].receivableCents, 4_000, "the payor is owed its remit, not the patient's copay");
  assert.equal(sharesReconcile(fill), 0, "and the patient's money still lands in the fill's margin");
});

test("an unknown acquisition cost yields no margin by payor rather than a margin of the whole remit", () => {
  const fill = groupIntoFills([
    row({ bin: "610011", remitCents: 4_000, acquisitionCents: null }),
    row({ bin: "024284", remitCents: 1_000, acquisitionCents: null }),
  ])[0];
  for (const s of payerShares(fill)) {
    assert.equal(s.costShareCents, null);
    assert.equal(s.marginCents, null);
    assert.ok(s.receivableCents > 0, "but each is still owed what it said it would pay");
  }
});
