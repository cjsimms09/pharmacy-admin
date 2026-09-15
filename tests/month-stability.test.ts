import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stabilityOf, stabilityOfAll, type MonthSnapshot, type MonthNow, type Cause } from "../src/lib/month-stability";

/**
 * The guarantee the owner's decision bought, and the check that enforces it.
 *
 * Asked whether a fill sold in one month and returned in another belongs to the month of the sale
 * or the month it came back, he said: "Month it came back." What that buys is a reported month
 * being final — and the two faults found this week were both a closed month moving without saying
 * so. These tests are about the one rule that makes such a check readable rather than noisy: not
 * "nothing moved", but "every movement is explained to the cent".
 */

const snap = (figures: Partial<MonthSnapshot["figures"]> = {}): MonthSnapshot => ({
  month: "2026-08",
  basis: "accrual",
  takenOn: "2026-09-01",
  figures: { revenueCents: 10_621_418, costOfGoodsCents: 9_106_450, grossProfitCents: 1_514_968, netProfitCents: 214_968, ...figures },
});

const now = (figures: Partial<MonthNow["figures"]> = {}): MonthNow => ({
  month: "2026-08",
  basis: "accrual",
  figures: { revenueCents: 10_621_418, costOfGoodsCents: 9_106_450, grossProfitCents: 1_514_968, netProfitCents: 214_968, ...figures },
});

describe("a month nobody wrote down is not a month that has not moved", () => {
  test("no snapshot is its own answer, and says so", () => {
    const s = stabilityOf(null, now());
    assert.equal(s.state, "unsnapshotted");
    assert.match(s.says, /never been written down/);
    assert.match(s.says, /not the same as unchanged/);
  });

  test("and it is never reported as unchanged", () => {
    assert.notEqual(stabilityOf(null, now()).state, "unchanged");
  });
});

describe("every movement explained to the cent", () => {
  test("a month that has not moved says so plainly", () => {
    const s = stabilityOf(snap(), now());
    assert.equal(s.state, "unchanged");
    assert.deepEqual(s.drifts, []);
  });

  test("a late day of the transaction report is a legitimate change, and is accounted for", () => {
    // Four fills collected on 31 August reached the site on 3 September. August genuinely grew.
    const causes: Cause[] = [
      {
        what: "4 fills collected in August arrived in a report loaded on 3 September",
        moves: [
          { key: "revenueCents", cents: 42_000 },
          { key: "costOfGoodsCents", cents: 30_000 },
          { key: "grossProfitCents", cents: 12_000 },
          { key: "netProfitCents", cents: 12_000 },
        ],
      },
    ];
    const s = stabilityOf(snap(), now({ revenueCents: 10_663_418, costOfGoodsCents: 9_136_450, grossProfitCents: 1_526_968, netProfitCents: 226_968 }), causes);
    assert.equal(s.state, "explained");
    assert.equal(s.unexplained.length, 0);
    assert.equal(s.drifts.length, 4);
    assert.match(s.says, /every penny of it is accounted for/);
  });

  test("a return that took revenue back out of the month of the sale is caught, because nothing explains it", () => {
    // The fault as it actually happened: a September return removing August's revenue and cost.
    const s = stabilityOf(snap(), now({ revenueCents: 10_534_418, costOfGoodsCents: 9_046_450, grossProfitCents: 1_487_968, netProfitCents: 187_968 }));
    assert.equal(s.state, "unexplained");
    assert.equal(s.unexplained.length, 4);
    assert.equal(s.unexplained[0].cents, -87_000);
    assert.match(s.unexplained[0].says, /Revenue moved −\$870\.00 since 2026-09-01 and nothing accounts for it/);
    assert.match(s.says, /The figures somebody acted on are not the figures now|figures somebody acted on/);
  });

  test("a cause that is too small leaves the residue, and names both halves", () => {
    // The dangerous case: something explains part of the movement, so it looks accounted for.
    const causes: Cause[] = [{ what: "one late fill", moves: [{ key: "revenueCents", cents: 10_000 }] }];
    const s = stabilityOf(snap(), now({ revenueCents: 10_671_418 }), causes);
    assert.equal(s.state, "unexplained");
    assert.equal(s.unexplained.length, 1);
    assert.equal(s.unexplained[0].cents, 40_000);
    assert.match(s.unexplained[0].says, /\+\$100\.00 is accounted for and \+\$400\.00 is not/);
  });

  test("there is no tolerance: one cent unaccounted for is unaccounted for", () => {
    const s = stabilityOf(snap(), now({ revenueCents: 10_621_419 }));
    assert.equal(s.state, "unexplained");
    assert.equal(s.unexplained[0].cents, 1);
  });

  test("a cause that exactly cancels a drift in the other direction still closes it", () => {
    const causes: Cause[] = [{ what: "a reversal booked correctly", moves: [{ key: "revenueCents", cents: -5_000 }] }];
    const s = stabilityOf(snap(), now({ revenueCents: 10_616_418 }), causes);
    assert.equal(s.state, "explained");
  });
});

describe("the two bases are two different accounts", () => {
  test("comparing them is refused rather than answered wrongly", () => {
    assert.throws(
      () => stabilityOf(snap(), { ...now(), basis: "cash" }),
      /answer different questions/,
    );
  });
});

describe("every month at once", () => {
  test("the worst state wins and the unexplained months are named", () => {
    const all = stabilityOfAll([
      { snapshot: snap(), now: now() },
      { snapshot: { ...snap(), month: "2026-07" }, now: { ...now({ revenueCents: 1 }), month: "2026-07" } },
      { snapshot: null, now: { ...now(), month: "2026-06" } },
    ]);
    assert.equal(all.worst, "unexplained");
    assert.match(all.says, /1 reported month has changed with nothing to account for it: 2026-07/);
    assert.equal(all.rows[0].month, "2026-07");
  });

  test("months never written down are reported as that, not as clean", () => {
    const all = stabilityOfAll([{ snapshot: null, now: now() }]);
    assert.match(all.says, /No month has ever been written down/);
    assert.doesNotMatch(all.says, /unchanged or accounted for/);
  });

  test("all quiet is claimed only when every month was actually checked", () => {
    const all = stabilityOfAll([{ snapshot: snap(), now: now() }]);
    assert.match(all.says, /Every reported month is either unchanged or accounted for to the cent/);
  });
});
