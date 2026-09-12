/**
 * When money a payer promised stops being merely unpaid and starts being late.
 *
 * The owner, 12 September 2026, reading "$96.89 promised by a plan and not yet paid — 1 fill" on
 * the claims page: *"can we give these time before alerting.."*
 *
 * He is right. The fill behind that line was dispensed the previous afternoon. A plan names the
 * facilitator payment when it adjudicates the claim and the money follows on a remittance cycle;
 * a fill adjudicated yesterday is not late, it is not due yet, and calling it "not yet paid" the
 * next morning turns the one real signal on this page into a line he has to learn to ignore.
 *
 * ── What this does and does not change ──
 *
 * Nothing here changes what is owed. `facilitatorOutstandingCents` in `fills.ts` is the arithmetic
 * of the receivable and it is untouched: the promise, less what has arrived, floored at nothing.
 * This module only decides which of that money is a job this morning. The whole outstanding figure
 * stays on the screen, because money the pharmacy is owed does not stop being owed while it is
 * inside the payer's own cycle — it just stops being something to go and do.
 *
 * ── Four states, and none of them may be rendered as another ──
 *
 *   none      no payer named a payment on this fill. Nothing is expected and nothing is owed.
 *   settled   a payment was promised and all of it arrived. Square.
 *   notDue    promised, unpaid, still inside the cycle. Outstanding, and not a job.
 *   due       promised, unpaid, past the cycle. The only state worth an alert.
 *
 * `docs/DAILY-CHECK.md` names "a null that means two things" as a standing fault shape here, and
 * this is exactly where it would land: `expectedFacilitatorCents === null` (nobody promised) and
 * `facilitatorOutstandingCents === 0` (promised and paid) are both "nothing outstanding", and
 * collapsing them would make a fill nobody owes anything on indistinguishable from one a payer has
 * settled. They are kept apart.
 *
 * ── One counterparty, not one per plan ──
 *
 * Every promise this site holds is a Medicare Transaction Facilitator payment: the manufacturer's
 * refund under the negotiated-price programme, routed through the MTF. The BIN on the claim is
 * Caremark or OptumRx or Humana or Prime, but none of them pays it — so keying the grace period on
 * the adjudicating PBM would hold the facilitator to a cycle belonging to somebody who is not
 * paying. The grace is therefore measured for the facilitator, once, and `graceFor` is shaped to
 * take a payer's own stated terms the day a real payer promise appears that has any.
 *
 * Pure. `promise-due-store.ts` reads the payment history behind `graceFor`.
 */

import { daysBetween } from "./payer-owed";

/** What state a promised payment on one fill is in. See the module note: these are four facts. */
export type PromiseState = "none" | "settled" | "notDue" | "due";

/** Where the grace period came from. Ranked: stated terms beat measurement, measurement beats a default. */
export type GraceBasis = "payerTerms" | "observed" | "default";

export type Grace = {
  /** Days from the fill that the payer gets before anything is called late. */
  days: number;
  basis: GraceBasis;
  /** How many payments the measurement rests on. Nought where the basis is not `observed`. */
  observations: number;
  /** Why this number and not another, in one clause, for the screen and for an audit. */
  why: string;
};

/**
 * The grace period used where nothing better is on file. **It is a default.**
 *
 * Thirty days, because thirty is the clean-claim payment cycle named by more of the agreements this
 * pharmacy actually holds than any other figure. Of the 29 rows in `payment_routing`, 20 state a
 * cycle at all, and across those the day-counts they name are: thirty seven times (Blue Eagle,
 * MC-Rx, Gainwell, MedOne, Citizens Rx, Go Mango, Capital Rx), sixty four times, ten three times,
 * fourteen once, seven once. It is the modal term of this pharmacy's own contracts rather than a
 * round number chosen because it felt safe.
 *
 * **What would replace it,** in order:
 *
 *  1. That payer's own stated terms as a number of days. `payment_routing.payment_cycle` holds the
 *     terms today, but as the prose the contract printed — "Within fourteen (14) days of receipt of
 *     an electronically submitted Clean Claim" — and nothing parses a number out of it. Reading
 *     those cycles into days is the real fix and it is not a small one: the same row can carry two
 *     cycles for two lines of business, and Caremark's row states a sixty-day reconciliation cycle
 *     that has nothing to do with when a point-of-sale claim is paid. Parse it wrong and the site
 *     invents a deadline, which `payer-owed.ts` refuses to do for exactly this reason.
 *  2. The pharmacy's own observed time-to-pay for that payer, once `OBSERVED_MINIMUM` of its
 *     payments have landed. This is already what governs the facilitator.
 */
export const DEFAULT_GRACE_DAYS = 30;

/**
 * How many payments must have arrived before this pharmacy's own history beats the default.
 *
 * Almost no real payer 835 has ever reached this pharmacy — see `docs/DAILY-CHECK.md` — so for most
 * payers this will not be met for a long time, and the honest answer until then is the default
 * rather than a percentile of two payments.
 *
 * Ten, because below ten the 90th percentile *is* the slowest payment on file (the nearest-rank
 * index reaches the last element), so one straggler would set the grace period for everything. The
 * facilitator history has two payments at 210 days against 29 between 15 and 27; at n=9 those two
 * would push the grace period to 210 days and this check would never fire again.
 */
export const OBSERVED_MINIMUM = 10;

/**
 * Which percentile of observed time-to-pay becomes the grace period.
 *
 * The ninetieth. An alert then means "this has been waiting longer than nine out of every ten
 * payments this payer has ever sent", which is a sentence that justifies the interruption. The
 * mean would not do: the facilitator's mean is 33.5 days against a median of 22, dragged there
 * entirely by the two 210-day rows, and a grace period of 34 days would sit past every payment
 * the facilitator has actually made.
 */
export const OBSERVED_PERCENTILE = 90;

/**
 * Nearest-rank percentile of a set of day counts. Null where there is nothing to read.
 *
 * No mean and no division by a count: a set of one gives that one, a set of none gives null rather
 * than NaN. The history here is thin by construction and this has to survive being thin.
 */
export function percentileDays(days: number[], percentile: number): number | null {
  const sorted = days.filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * How long to give a payer, and why.
 *
 * `termsDays` is that payer's own stated cycle where the site holds it as a number — see
 * `DEFAULT_GRACE_DAYS` for why nothing supplies one yet. `observedDaysToPay` is one entry per
 * payment received from this payer, being the days between the fill and the money arriving.
 *
 * A negative observation is dropped rather than counted. `claim_payments` holds remittances
 * received before the fill they name — the ProviderPay backfill runs to −126 days — and whatever
 * that is, it is not evidence of how long this payer takes to pay.
 */
export function graceFor(a: { payer?: string | null; termsDays?: number | null; observedDaysToPay?: number[] }): Grace {
  const payer = a.payer?.trim() || "this payer";

  if (a.termsDays !== null && a.termsDays !== undefined && Number.isFinite(a.termsDays) && a.termsDays > 0) {
    const days = Math.round(a.termsDays);
    return {
      days,
      basis: "payerTerms",
      observations: 0,
      why: `${days} days is what ${payer}'s own agreement on file says it takes to pay a clean claim`,
    };
  }

  const usable = (a.observedDaysToPay ?? []).filter((d) => Number.isFinite(d) && d >= 0);
  if (usable.length >= OBSERVED_MINIMUM) {
    const days = percentileDays(usable, OBSERVED_PERCENTILE);
    if (days !== null) {
      return {
        days,
        basis: "observed",
        observations: usable.length,
        why: `${days} days is how long all but one in ten of the ${usable.length} payments ${payer} has actually sent this pharmacy took to arrive`,
      };
    }
  }

  return {
    days: DEFAULT_GRACE_DAYS,
    basis: "default",
    observations: usable.length,
    why:
      `${DEFAULT_GRACE_DAYS} days is a default, not ${payer}'s own terms — no payment cycle for it is on file as a number, and ` +
      (usable.length === 0
        ? "nothing has ever arrived from it to measure one from"
        : `only ${usable.length} of its payments have landed, too few to measure one from`),
  };
}

/** A fill's promise, as much of it as this decision needs. */
export type Promised = {
  /** The day the drug was dispensed, which is when the payer's obligation begins. */
  dateFilled: string;
  /** What was promised at adjudication. Null where nothing was. */
  expectedFacilitatorCents: number | null;
  /** The promise less what has arrived. Null where nothing was promised. Never negative. */
  facilitatorOutstandingCents: number | null;
};

export type PromiseDue = {
  state: PromiseState;
  /** The first morning this counts as late: the fill date plus the grace period. Null unless outstanding. */
  lateFrom: string | null;
  /** Days since the fill. Null where the date cannot be read. */
  daysWaiting: number | null;
  /** Days until `lateFrom`. Nought or less once it is late. Null unless outstanding. */
  daysToGo: number | null;
};

/** The fill date plus a number of days, as an ISO date. */
export function addDays(iso: string, days: number): string | null {
  const t = Date.parse(iso + "T00:00:00Z");
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Which of the four states one fill's promise is in, on a given morning.
 *
 * Late from the fill date plus the grace period **inclusive**: given 25 days' grace on a fill
 * dispensed 11 September, the 5th of October is the last quiet morning and the 6th is the first
 * one it is chased on. A payer that has taken the whole of its cycle has taken its cycle.
 */
export function promiseDue(fill: Promised, grace: Grace, today: string): PromiseDue {
  const outstanding = fill.facilitatorOutstandingCents;
  if (fill.expectedFacilitatorCents === null || outstanding === null) {
    return { state: "none", lateFrom: null, daysWaiting: null, daysToGo: null };
  }
  if (outstanding <= 0) {
    return { state: "settled", lateFrom: null, daysWaiting: daysBetween(fill.dateFilled, today), daysToGo: null };
  }
  const lateFrom = addDays(fill.dateFilled, grace.days);
  const daysWaiting = daysBetween(fill.dateFilled, today);
  /*
   * A fill date nothing can read cannot be aged, and an unaged fill is treated as due rather than
   * quietly held back for ever. Hiding money behind an unparseable date is the failure this whole
   * change is meant not to introduce.
   */
  if (lateFrom === null || daysWaiting === null) {
    return { state: "due", lateFrom: null, daysWaiting, daysToGo: null };
  }
  const daysToGo = grace.days - daysWaiting;
  return { state: daysWaiting >= grace.days ? "due" : "notDue", lateFrom, daysWaiting, daysToGo };
}

export type PromisedSplit<T> = {
  grace: Grace;
  /** Every promised, unpaid fill. The receivable, whole and unchanged. */
  all: T[];
  allCents: number;
  /** Past the payer's cycle. This, and only this, is what earns an alert. */
  due: T[];
  dueCents: number;
  /** Inside the cycle. Real money outstanding, and nothing to do about it yet. */
  notDue: T[];
  notDueCents: number;
  /** The soonest any not-due fill becomes late, so the screen can say when rather than "later". */
  nextLateFrom: string | null;
  /** One sentence saying what is counted, what is not, and why. */
  says: string;
};

/**
 * Split promised, unpaid money into what is late and what is simply not due yet.
 *
 * Takes the fills already filtered to an outstanding promise, and keeps them: `all` is the same
 * population and the same total that reached this function. Both halves are returned, biggest
 * first, because the not-due half has to stay visible — the owner asked for the alert to wait, not
 * for the money to disappear.
 */
export function splitPromised<T extends Promised>(fills: T[], grace: Grace, today: string): PromisedSplit<T> {
  const cents = (f: T) => f.facilitatorOutstandingCents ?? 0;
  const all = [...fills].sort((a, b) => cents(b) - cents(a));
  const due: T[] = [];
  const notDue: T[] = [];
  let nextLateFrom: string | null = null;

  for (const f of all) {
    const d = promiseDue(f, grace, today);
    if (d.state === "due") due.push(f);
    else if (d.state === "notDue") {
      notDue.push(f);
      if (d.lateFrom !== null && (nextLateFrom === null || d.lateFrom < nextLateFrom)) nextLateFrom = d.lateFrom;
    }
    /* `none` and `settled` cannot occur here: the caller filtered to an outstanding promise. */
  }

  const total = (xs: T[]) => xs.reduce((n, f) => n + cents(f), 0);
  const dueCents = total(due);
  const notDueCents = total(notDue);

  return {
    grace,
    all,
    allCents: total(all),
    due,
    dueCents,
    notDue,
    notDueCents,
    nextLateFrom,
    says: sentence({ grace, dueCents, dueFills: due.length, notDueCents, notDueFills: notDue.length, nextLateFrom }),
  };
}

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fills = (n: number) => `${n} fill${n === 1 ? "" : "s"}`;

/**
 * The line on the screen, in his words: why something is or is not being counted.
 *
 * Every branch says the grace period and where it came from, because a figure that moved because
 * of a rule nobody can see is the thing this project has spent the most trust on.
 */
export function sentence(a: {
  grace: Grace;
  dueCents: number;
  dueFills: number;
  notDueCents: number;
  notDueFills: number;
  nextLateFrom: string | null;
}): string {
  const waiting =
    a.notDueFills === 0
      ? ""
      : ` ${money(a.notDueCents)} on ${fills(a.notDueFills)} is still owed and not on the list: dispensed too recently to be late` +
        (a.nextLateFrom === null ? "." : `, and the first of it is chased from ${a.nextLateFrom}.`);

  if (a.dueFills === 0 && a.notDueFills === 0) return "Nothing a plan promised is outstanding.";

  if (a.dueFills === 0) {
    return `Nothing to chase — every promised payment is still inside ${a.grace.days} days, and ${a.grace.why}.${waiting}`;
  }

  return (
    `${money(a.dueCents)} on ${fills(a.dueFills)} has been waiting more than ${a.grace.days} days, and ${a.grace.why}.` +
    waiting
  );
}
