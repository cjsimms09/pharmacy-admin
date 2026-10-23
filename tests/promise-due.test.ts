import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  graceFor,
  percentileDays,
  promiseDue,
  splitPromised,
  addDays,
  DEFAULT_GRACE_DAYS,
  OBSERVED_MINIMUM,
  type Promised,
} from "../src/lib/promise-due";

/*
 * When promised money stops being unpaid and starts being late.
 *
 * The owner, 12 September 2026, reading "$96.89 promised by a plan and not yet paid — 1 fill" the
 * morning after that fill was dispensed: "can we give these time before alerting.."
 *
 * Two things have to hold at once and they pull against each other. Nothing inside the payer's own
 * cycle may reach the morning's list, and nothing may vanish from what the pharmacy is owed. The
 * tests below are mostly about the second: it is the easy one to break while fixing the first.
 */

const FILL = "2026-09-11";
/* The facilitator's own measured cycle on the live data: the 90th percentile of 31 payments. */
const GRACE = graceFor({ payer: "the facilitator", observedDaysToPay: MEASURED() });

/** The 31 facilitator payments on file, in days between the fill and the money arriving. */
function MEASURED(): number[] {
  return [15, 15, 16, 16, 17, 19, 19, 19, 19, 20, 20, 22, 22, 22, 22, 22, 23, 23, 23, 23, 23, 23, 25, 25, 25, 25, 25, 25, 27, 210, 210];
}

const fill = (o: Partial<Promised> = {}): Promised => ({
  dateFilled: FILL,
  expectedFacilitatorCents: 9689,
  facilitatorOutstandingCents: 9689,
  ...o,
});

describe("what the grace period is keyed on", () => {
  test("a payer's own stated terms win over everything else", () => {
    const g = graceFor({ payer: "Capital Rx", termsDays: 14, observedDaysToPay: MEASURED() });
    assert.equal(g.days, 14);
    assert.equal(g.basis, "payerTerms");
    assert.match(g.why, /Capital Rx/);
    assert.match(g.why, /own agreement/);
  });

  test("with no terms on file, the pharmacy's own observed time-to-pay is used", () => {
    assert.equal(GRACE.basis, "observed");
    assert.equal(GRACE.observations, 31);
    // The 90th percentile of the real distribution. Not the mean, which the two 210s drag to 33.5.
    assert.equal(GRACE.days, 25);
    assert.match(GRACE.why, /31 payments/);
  });

  test("the two 210-day stragglers do not set the period for everything", () => {
    // A mean here is 33.5 days, past every payment the facilitator has actually made bar two.
    const mean = MEASURED().reduce((a, b) => a + b, 0) / MEASURED().length;
    assert.ok(mean > 33 && mean < 34);
    assert.ok(GRACE.days < mean);
  });

  test("a payer with no terms and no history gets the stated default, and the sentence says so", () => {
    const g = graceFor({ payer: "Humana" });
    assert.equal(g.days, DEFAULT_GRACE_DAYS);
    assert.equal(g.basis, "default");
    assert.equal(g.observations, 0);
    assert.match(g.why, /is a default/);
    assert.match(g.why, /nothing has ever arrived from it/);
  });

  test("thin history is not measured — it falls back and says how thin", () => {
    /*
     * The site has received almost no real payer 835s. A 90th percentile of four payments is the
     * slowest of four, which is not a reading of anything.
     */
    const g = graceFor({ payer: "Prime", observedDaysToPay: [18, 19, 20, 61] });
    assert.equal(g.days, DEFAULT_GRACE_DAYS);
    assert.equal(g.basis, "default");
    assert.equal(g.observations, 4);
    assert.match(g.why, /only 4 of its payments have landed/);
  });

  test("the minimum is where a percentile stops being the slowest payment on file", () => {
    // One straggler at the boundary must not become the grace period the moment n is reached.
    const nine = [20, 20, 20, 20, 20, 20, 20, 20, 210];
    assert.equal(nine.length, OBSERVED_MINIMUM - 1);
    assert.equal(graceFor({ observedDaysToPay: nine }).basis, "default");
    const ten = [...nine, 20];
    const g = graceFor({ observedDaysToPay: ten });
    assert.equal(g.basis, "observed");
    assert.equal(g.days, 20, "the ninth of ten, not the straggler");
  });

  test("a payment received before the fill it names is not evidence of anything", () => {
    // claim_payments holds a ProviderPay backfill running to -126 days.
    const g = graceFor({ observedDaysToPay: [...MEASURED(), -126, -40] });
    assert.equal(g.observations, 31);
    assert.equal(g.days, 25);
  });

  test("no history divides by nothing rather than by zero", () => {
    assert.equal(percentileDays([], 90), null);
    assert.equal(percentileDays([22], 90), 22);
    assert.equal(graceFor({ observedDaysToPay: [] }).days, DEFAULT_GRACE_DAYS);
  });
});

describe("the boundary", () => {
  test("the day before it is due, it is outstanding and not late", () => {
    // 25 days' grace on an 11 September fill: 5 October is the last quiet morning.
    const d = promiseDue(fill(), GRACE, "2026-10-05");
    assert.equal(d.state, "notDue");
    assert.equal(d.lateFrom, "2026-10-06");
    assert.equal(d.daysWaiting, 24);
    assert.equal(d.daysToGo, 1);
  });

  test("the day it becomes due, it is late", () => {
    const d = promiseDue(fill(), GRACE, "2026-10-06");
    assert.equal(d.state, "due");
    assert.equal(d.lateFrom, "2026-10-06");
    assert.equal(d.daysWaiting, 25);
    assert.equal(d.daysToGo, 0);
  });

  test("the morning after the fill — the line the owner objected to — is not late", () => {
    assert.equal(promiseDue(fill(), GRACE, "2026-09-12").state, "notDue");
  });

  test("a payer with no terms on file gets its thirty days, and the boundary moves with it", () => {
    const g = graceFor({ payer: "Humana" });
    assert.equal(promiseDue(fill(), g, "2026-10-10").state, "notDue", "day 29");
    assert.equal(promiseDue(fill(), g, "2026-10-11").state, "due", "day 30");
    assert.equal(addDays(FILL, g.days), "2026-10-11");
  });

  test("a fill date nothing can read is treated as due, never quietly held back", () => {
    const d = promiseDue(fill({ dateFilled: "not a date" }), GRACE, "2026-10-06");
    assert.equal(d.state, "due");
  });
});

describe("the states are not rendered as one another", () => {
  test("no payment was ever expected is not the same as promised and paid", () => {
    const never = promiseDue({ dateFilled: FILL, expectedFacilitatorCents: null, facilitatorOutstandingCents: null }, GRACE, "2026-12-01");
    const paid = promiseDue(fill({ facilitatorOutstandingCents: 0 }), GRACE, "2026-12-01");
    assert.equal(never.state, "none");
    assert.equal(paid.state, "settled");
    assert.notEqual(never.state, paid.state);
  });

  test("not due yet is not the same as nothing owed", () => {
    const s = splitPromised([fill()], GRACE, "2026-09-12");
    assert.equal(s.dueCents, 0, "nothing to alert on");
    assert.equal(s.allCents, 9689, "and $96.89 still owed");
    assert.equal(s.notDueCents, 9689);
    assert.equal(s.all.length, 1);
  });
});

describe("the split keeps every dollar and says which is which", () => {
  const fills = [
    fill({ dateFilled: "2026-08-01", facilitatorOutstandingCents: 121_618, expectedFacilitatorCents: 121_618 }),
    fill({ dateFilled: "2026-09-11", facilitatorOutstandingCents: 9689 }),
    fill({ dateFilled: "2026-09-05", facilitatorOutstandingCents: 14_618, expectedFacilitatorCents: 14_618 }),
  ];

  test("due plus not due is the whole receivable, and the whole receivable is unchanged", () => {
    const s = splitPromised(fills, GRACE, "2026-09-12");
    assert.equal(s.dueCents + s.notDueCents, s.allCents);
    assert.equal(s.allCents, 121_618 + 9689 + 14_618);
    assert.equal(s.all.length, 3, "nothing dropped out of what is owed");
  });

  test("only what has outrun the cycle is on the list", () => {
    const s = splitPromised(fills, GRACE, "2026-09-12");
    assert.equal(s.due.length, 1);
    assert.equal(s.due[0].dateFilled, "2026-08-01");
    assert.equal(s.dueCents, 121_618);
    assert.equal(s.notDue.length, 2);
  });

  test("the screen is told the day the first quiet one starts being chased", () => {
    const s = splitPromised(fills, GRACE, "2026-09-12");
    // 5 September plus 25 days, which is sooner than 11 September plus 25.
    assert.equal(s.nextLateFrom, "2026-09-30");
  });

  test("the sentence says the amount, the period, and where the period came from", () => {
    const s = splitPromised(fills, GRACE, "2026-09-12");
    assert.match(s.says, /\$1,216\.18 on 1 fill has been waiting more than 25 days/);
    assert.match(s.says, /31 payments/);
    assert.match(s.says, /\$243\.07 on 2 fills is still owed and not on the list/);
    assert.match(s.says, /chased from 2026-09-30/);
  });

  test("when nothing is late the sentence still accounts for the money", () => {
    const s = splitPromised([fill()], GRACE, "2026-09-12");
    assert.match(s.says, /^Nothing to chase/);
    assert.match(s.says, /\$96\.89 on 1 fill is still owed/);
    assert.match(s.says, /chased from 2026-10-06/);
  });

  test("a default grace period announces itself on the screen, not only in the code", () => {
    const s = splitPromised([fill()], graceFor({ payer: "Humana" }), "2026-09-12");
    assert.match(s.says, /30 days is a default/);
  });

  test("nothing promised says nothing promised", () => {
    const s = splitPromised([], GRACE, "2026-09-12");
    assert.equal(s.allCents, 0);
    assert.equal(s.says, "Nothing a plan promised is outstanding.");
  });

  test("biggest first, in both halves, because that is the order he reads in", () => {
    const s = splitPromised(fills, GRACE, "2026-09-12");
    assert.deepEqual(
      s.all.map((f) => f.facilitatorOutstandingCents),
      [121_618, 14_618, 9689],
    );
    assert.deepEqual(
      s.notDue.map((f) => f.facilitatorOutstandingCents),
      [14_618, 9689],
    );
  });
});
