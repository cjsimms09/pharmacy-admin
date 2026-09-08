import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fillMinimums, type FillInput } from "../src/lib/minimum-filler";
import type { Offer, Movement } from "../src/lib/order-plan";

/**
 * Meeting a $500 minimum with the generics the secondary is genuinely the best place to buy.
 *
 * Prices in micros per unit; a tablet at $0.10 is 100,000 micros. Packs of 100 and 500.
 */
const offer = (ndc11: string, supplier: string, unitDollars: number, packQty: number | null = 100, over: Partial<Offer> = {}): Offer => ({
  ndc11,
  supplier,
  unitCostMicros: Math.round(unitDollars * 1_000_000),
  effectiveUnitMicros: Math.round(unitDollars * 1_000_000),
  rebated: null,
  packQty,
  shortDated: null,
  description: `Drug ${ndc11}`,
  ...over,
});

const move = (ndc11: string, perDayUnits: number, onHandUnits = 0, steady = true): Movement => ({ ndc11, perDayThousandths: perDayUnits * 1000, steady, onHandThousandths: onHandUnits * 1000 });

function input(over: Partial<FillInput> = {}): FillInput {
  return {
    suppliers: [
      { supplier: "McKesson", minimumCents: null, primary: true },
      { supplier: "IPC", minimumCents: 50_000 },
    ],
    basketCentsBySupplier: new Map([["McKesson", 120_000], ["IPC", 18_000]]),
    orderedBySupplier: new Map([["IPC", new Set(["00000000011"])]]),
    offers: [
      // A: IPC cheapest, generic, steady, 5 a day → 60 days is 300 units = 3 packs of 100 at $0.10 = $10/pack
      offer("00000000001", "IPC", 0.1), offer("00000000001", "McKesson", 0.14),
      // B: IPC cheapest, generic, 10 a day, pack of 500 at $0.20 = $100/pack
      offer("00000000002", "IPC", 0.2, 500), offer("00000000002", "McKesson", 0.25, 500),
      // C: McKesson cheapest → never a pick at IPC
      offer("00000000003", "IPC", 0.3), offer("00000000003", "McKesson", 0.2),
      // D: brand, IPC cheapest → left out as not generic
      offer("00000000004", "IPC", 1.0), offer("00000000004", "McKesson", 1.2),
      // E: controlled, IPC cheapest → left out
      offer("00000000005", "IPC", 0.5), offer("00000000005", "McKesson", 0.6),
      // F: lumpy, IPC cheapest → refused
      offer("00000000006", "IPC", 0.5), offer("00000000006", "McKesson", 0.6),
      // G: no CMS flag → left out as unknown
      offer("00000000007", "IPC", 0.5), offer("00000000007", "McKesson", 0.6),
    ],
    movement: [move("00000000001", 5), move("00000000002", 10), move("00000000003", 5), move("00000000004", 2), move("00000000005", 3), move("00000000006", 4, 0, false), move("00000000007", 6)],
    names: new Map([["00000000001", "Amlodipine 5 mg"], ["00000000002", "Metformin 500 mg"]]),
    eligibility: {
      generic: new Map([["00000000001", "G"], ["00000000002", "G"], ["00000000003", "G"], ["00000000004", "B"], ["00000000005", "G"], ["00000000006", "G"]]),
      controlled: new Set(["00000000005"]),
    },
    horizonDays: 60,
    ...over,
  };
}

describe("filling a minimum with the right generics", () => {
  test("only generics, not controlled, steady, and cheapest here, inside the horizon", () => {
    const [mck, ipc] = fillMinimums(input());
    assert.equal(mck.meets, true);
    assert.match(mck.says, /is the primary/);
    assert.equal(ipc.shortfallCents, 32_000);
    const ndcs = ipc.picks.map((p) => p.ndc11);
    assert.ok(!ndcs.includes("00000000003"), "McKesson is cheaper on C");
    assert.ok(!ndcs.includes("00000000004"), "D is a brand");
    assert.ok(!ndcs.includes("00000000005"), "E is controlled");
    assert.ok(!ndcs.includes("00000000006"), "F is one big fill, not a rate");
    assert.ok(!ndcs.includes("00000000007"), "G has no CMS flag");
    assert.deepEqual(ipc.leftOut, { notGeneric: 1, controlled: 1, unknownClass: 1 });
    assert.ok(ipc.refused.some((r) => r.ndc11 === "00000000006"));
  });

  test("whole packs inside sixty days of use, ranked by saving per dollar, until the minimum is met", () => {
    const ipc = fillMinimums(input())[1];
    // B saves $0.05/unit on $0.20 (25%); A saves $0.04 on $0.10 (40%): A ranks first.
    assert.equal(ipc.picks[0].ndc11, "00000000001");
    const a = ipc.picks[0];
    // 60 days × 5 a day = 300 units = 3 packs of 100, $10 each: the cap allows 3 and the shortfall wants more, so 3.
    assert.equal(a.packs, 3);
    assert.equal(a.costCents, 3_000);
    assert.equal(a.savingCents, 300 * 4, "300 units at 4 cents cheaper");
    assert.equal(a.daysOfStockAfter, 60);
    assert.equal(a.projectedThousandths, 300_000);
    // Then B: 60 days × 10 = 600 units = 1 pack of 500 ($100); shortfall left $290 → wants 3 packs, cap allows 1.
    const b = ipc.picks[1];
    assert.equal(b.ndc11, "00000000002");
    assert.equal(b.packs, 1);
    assert.equal(b.costCents, 10_000);
    assert.equal(ipc.addedCents, 13_000);
    assert.equal(ipc.meets, false, "$180 + $130 is still short of $500");
    assert.equal(ipc.overshootCents, 18_000 + 13_000 - 50_000);
    assert.match(ipc.says, /still leave the order \$190\.00 short/);
  });

  test("a minimum already met adds nothing; a smaller gap takes only what it needs", () => {
    const met = fillMinimums(input({ basketCentsBySupplier: new Map([["IPC", 60_000]]) }))[1];
    assert.equal(met.picks.length, 0);
    assert.equal(met.meets, true);
    assert.equal(met.overshootCents, 10_000);
    // $4,985 basket against $5,000: two $10 packs of A are enough, and overshoot by $5.
    const small = fillMinimums(input({ suppliers: [{ supplier: "IPC", minimumCents: 500_000 }], basketCentsBySupplier: new Map([["IPC", 498_500]]) }))[0];
    assert.equal(small.picks.length, 1);
    assert.equal(small.picks[0].packs, 2);
    assert.equal(small.meets, true);
    assert.equal(small.overshootCents, 500);
    assert.match(small.says, /\$5\.00 over/);
  });

  test("stock on order is cover, and an item already on the order is not added again", () => {
    // A has 250 on order: 60 days of use is 300, so only 50 units of room — under a pack, refused.
    const withOrder = fillMinimums(input({ onOrderThousandths: new Map([["00000000001", 250_000]]) }))[1];
    assert.ok(!withOrder.picks.some((p) => p.ndc11 === "00000000001"));
    assert.ok(withOrder.refused.some((r) => r.ndc11 === "00000000001" && /days/.test(r.why)));
    const already = fillMinimums(input({ orderedBySupplier: new Map([["IPC", new Set(["00000000001"])]]) }))[1];
    assert.ok(!already.picks.some((p) => p.ndc11 === "00000000001"));
  });

  test("every qualifying generic is ranked by need and price together, whether or not the lines already meet the minimum", () => {
    // A holds 20 days (100 on hand at 5 a day) and is 40% cheaper here; B holds 2 days (20 at 10 a day) and is 25% cheaper.
    // Urgency wins: B is 0.97 + 0.25 against A's 0.67 + 0.40.
    const ipc = fillMinimums(input({ movement: [move("00000000001", 5, 100), move("00000000002", 10, 20), move("00000000003", 5)] }))[1];
    assert.deepEqual(ipc.candidates.map((c) => c.ndc11), ["00000000002", "00000000001"]);
    const b = ipc.candidates[0];
    assert.equal(b.packQty, 500);
    assert.equal(b.packCostCents, 10_000);
    assert.equal(b.savingPerPackCents, 2_500);
    assert.equal(Math.round(b.daysOnHand), 2);
    assert.equal(Math.round(b.daysAfterOnePack), 52);
    assert.equal(b.maxPacks, 1);
    // Met already: the greedy fill stands down, the ranked list does not — the cart may not match the plan.
    const met = fillMinimums(input({ basketCentsBySupplier: new Map([["IPC", 60_000]]) }))[1];
    assert.equal(met.picks.length, 0);
    assert.ok(met.candidates.length >= 2);
    assert.equal(fillMinimums(input())[0].candidates.length, 0, "the primary gets no add-on list");
    // The owner, 8 September: no minimums to type; the list stands on its own, ranked by days left and price.
    const noMin = fillMinimums(input({ suppliers: [{ supplier: "McKesson", minimumCents: null, primary: true }, { supplier: "IPC", minimumCents: null }] }))[1];
    assert.ok(noMin.candidates.length >= 2, "a secondary with no minimum still lists the next best to order");
    assert.equal(noMin.picks.length, 0, "nothing is filled to a target that does not exist");
    assert.match(noMin.says, /no order minimum on file, so nothing is filled to a target/);
    // The same two shelves but A now 90% cheaper here: price outranks a small difference in need.
    const cheap = fillMinimums(input({ offers: [...input().offers.filter((o) => o.ndc11 !== "00000000001"), offer("00000000001", "IPC", 0.1), offer("00000000001", "McKesson", 1.0)], movement: [move("00000000001", 5, 60), move("00000000002", 10, 20), move("00000000003", 5)] }))[1];
    assert.deepEqual(cheap.candidates.map((c) => c.ndc11), ["00000000001", "00000000002"]);
  });

  test("what the list refuses: dearer here, more than two months on the shelf, or one large fill", () => {
    const ipc = fillMinimums(input({ movement: [move("00000000001", 5, 400), move("00000000002", 10), move("00000000003", 5), move("00000000006", 4, 0, false)] }))[1];
    const listed = ipc.candidates.map((c) => c.ndc11);
    assert.ok(!listed.includes("00000000003"), "McKesson is cheaper on C, so C is never offered here");
    assert.ok(!listed.includes("00000000001"), "A holds 80 days already, over the horizon");
    assert.ok(ipc.refused.some((r) => r.ndc11 === "00000000001" && /days of stock/.test(r.why)));
    assert.ok(!listed.includes("00000000006"), "F was one large fill, not a rate");
    assert.ok(ipc.refused.some((r) => r.ndc11 === "00000000006" && /one large fill/.test(r.why)));
  });

  test("when nothing qualifies it says so and prices the alternative rather than inventing a basket", () => {
    const none = fillMinimums(input({ movement: [move("00000000003", 5)] }))[1];
    assert.equal(none.picks.length, 0);
    assert.equal(none.meets, false);
    assert.match(none.says, /Nothing qualifies/);
    assert.match(none.says, /\$320\.00 short/);
  });
});

/*
 * A line the supplier prices no better than anybody else.
 *
 * Since 54e11ad an equal price qualifies as an add-on: reaching a minimum on it costs the pharmacy
 * nothing, and refusing it can mean paying a primary's price on the whole basket for want of $40.
 * The arithmetic is right. The danger is the words — the sentence the owner reads said "Cheapest
 * here at 0.1000 against 0.1000 at McKesson", which asserts a saving that does not exist. He is
 * being asked to spend money on the strength of these sentences, so they have to hold.
 */
describe("an add-on at the same price", () => {
  const sameInput = () =>
    input({
      suppliers: [{ supplier: "IPC", minimumCents: 50_000 }],
      basketCentsBySupplier: new Map([["IPC", 47_000]]),
      orderedBySupplier: new Map(),
      offers: [offer("00000000001", "IPC", 0.1), offer("00000000001", "McKesson", 0.1)],
      movement: [move("00000000001", 5)],
      eligibility: { generic: new Map([["00000000001", "G"]]), controlled: new Set() },
    });

  test("qualifies, because reaching the minimum on it costs nothing", () => {
    const [fill] = fillMinimums(sameInput());
    assert.equal(fill.picks.length, 1);
    assert.equal(fill.picks[0].ndc11, "00000000001");
    assert.equal(fill.picks[0].savingCents, 0, "no saving, and none claimed");
    assert.ok(fill.meets);
  });

  test("and says so, rather than calling an equal price the cheapest", () => {
    const [fill] = fillMinimums(sameInput());
    assert.match(fill.picks[0].why, /The same price here as at McKesson/);
    assert.doesNotMatch(fill.picks[0].why, /Cheapest here/);
    // The summary must not book a saving either.
    assert.match(fill.says, /none of them cheaper here than elsewhere/);
    assert.doesNotMatch(fill.says, /cheaper in all/);
  });

  test("a genuinely cheaper line still says it is cheaper, and by how much in all", () => {
    const [fill] = fillMinimums(
      input({
        suppliers: [{ supplier: "IPC", minimumCents: 50_000 }],
        basketCentsBySupplier: new Map([["IPC", 47_000]]),
        orderedBySupplier: new Map(),
        offers: [offer("00000000001", "IPC", 0.1), offer("00000000001", "McKesson", 0.14)],
        movement: [move("00000000001", 5)],
        eligibility: { generic: new Map([["00000000001", "G"]]), controlled: new Set() },
      }),
    );
    assert.match(fill.picks[0].why, /Cheapest here at 0\.1000\/unit against 0\.1400 at McKesson/);
    assert.ok(fill.picks[0].savingCents > 0);
    assert.match(fill.says, /cheaper in all/);
  });

  test("a dearer line is still refused, because paying more to reach a number is the thing this prevents", () => {
    const [fill] = fillMinimums(
      input({
        suppliers: [{ supplier: "IPC", minimumCents: 50_000 }],
        basketCentsBySupplier: new Map([["IPC", 47_000]]),
        orderedBySupplier: new Map(),
        offers: [offer("00000000001", "IPC", 0.11), offer("00000000001", "McKesson", 0.1)],
        movement: [move("00000000001", 5)],
        eligibility: { generic: new Map([["00000000001", "G"]]), controlled: new Set() },
      }),
    );
    assert.equal(fill.picks.length, 0);
    assert.equal(fill.meets, false);
  });
});
