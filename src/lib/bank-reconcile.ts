/**
 * What a deposit is made of.
 *
 * `payer-model.md` §9: "A deposit is explained by one or more remittances (a TRN's amount and date)
 * or by register takings; a deposit nothing explains, or a remittance with no deposit, is a finding
 * the books show."
 *
 * The question this answers is the owner's, not an accountant's: *did this payer actually pay me
 * what the remittances said they would?* Today nothing can answer it. A deposit becomes a cash
 * receipt attributed to a payer by the words in the bank's description, and the remittances sit
 * beside it unconnected, so a plan that promised $4,000 and paid $3,600 looks exactly like one that
 * paid in full.
 *
 * Pure, and deliberately so — it is the half that can be right before the remittance tables exist.
 * `remittances`, `remittance_lines` and `remittance_adjustments` are still being audited, so the
 * store, the migration and the page wait; this takes whatever settlements a caller has and works
 * on their shape rather than on a schema.
 *
 * ── What it will and will not decide ──
 *
 * It matches on money and date and nothing else, so it is capable of being confidently wrong in a
 * way the rest of this site is not allowed to be. Three rules hold it back:
 *
 *   - **Exact sums only.** A deposit is explained when some set of outstanding settlements adds up
 *     to it exactly. Near enough is not a reconciliation; it is a second, quieter set of books.
 *   - **Ambiguity is reported, never chosen.** Two PBMs paying $1,240.00 in the same week is
 *     ordinary, and picking one would tie a payer's money to another payer's deposit. The books
 *     would still balance, which is what makes it dangerous.
 *   - **Nothing is asserted about a partial payment.** A remittance may legitimately split across
 *     two deposits, so a deposit smaller than a single outstanding remittance is a candidate worth
 *     showing and never a settlement worth recording.
 */

/** A line on the bank statement that brought money in. */
export type Deposit = {
  /** YYYY-MM-DD. */
  on: string;
  amountCents: number;
  description?: string | null;
};

/**
 * Money a payer said it was sending, which a deposit might be.
 *
 * `kind` is what the money is, and it matters more than it looks. An 835's TRN is a promise about a
 * named set of claims; a facilitator payment is a later top-up belonging to fills already paid. A
 * deposit explained by facilitator money has not told you a plan paid its remittance.
 */
export type Settlement = {
  id: string;
  kind: "remittance" | "facilitator";
  /** The TRN trace number, or the payment's own reference. Shown so a person can find it. */
  reference: string | null;
  payor: string;
  /** What the whole remittance or payment came to. */
  amountCents: number;
  /** The 835's production date, or the date the payment was recorded. */
  on: string;
  /** How much of it is already tied to another deposit. A remittance can split across two. */
  appliedCents?: number;
};

/** What is left of a settlement to explain a deposit with. */
export function outstandingCents(s: Settlement): number {
  return s.amountCents - (s.appliedCents ?? 0);
}

export type Explanation =
  /** One set of outstanding settlements adds up to the deposit exactly, and only one does. */
  | { kind: "explained"; settlements: Settlement[]; totalCents: number }
  /**
   * More than one set adds up to it. The sets are returned, in full, for a person to choose.
   *
   * Two payers sending the same money in the same week is ordinary, and a wrong choice here does
   * not show up as an imbalance — the books still add up, with one payer's money against another's
   * name, which is why this can never be settled by picking the first.
   */
  | { kind: "ambiguous"; candidates: Settlement[][]; why: string }
  /**
   * Nothing adds up to it exactly, but a single outstanding settlement is larger — which is what a
   * remittance split across two deposits looks like. Offered, never recorded.
   */
  | { kind: "possible-split"; settlements: Settlement[]; why: string }
  /** Nothing accounts for it: register takings, or money nobody has told the site about. */
  | { kind: "unexplained"; why: string };

/**
 * How far back a deposit may reach for the remittance that caused it.
 *
 * A payer produces the 835 and the money lands days later, never before, so the window is one-sided.
 * Thirty days is generous for a twice-monthly cycle and short enough that a deposit does not reach
 * back into a previous month's unclaimed remittances and find a coincidence there.
 */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * The most settlements considered at once.
 *
 * Subset-sum is exponential and this runs against real data, so it is bounded rather than trusted
 * to be small: with more candidates than this in the window, no set is proposed at all and the
 * deposit is reported as needing a person. A slow page is a bug; a page that stops answering is an
 * outage, and this one would arrive on the day a payer sent thirty remittances in a fortnight.
 */
export const MAX_CANDIDATES = 16;

/** The largest number of settlements one deposit is allowed to be made of. */
export const MAX_SET_SIZE = 4;

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return (b - a) / 86_400_000;
}

/**
 * The settlements a deposit could plausibly be, before any arithmetic.
 *
 * Dated on or before the deposit and within the window, still carrying money, and — where the
 * caller knows the payer — from that payer. Exported because the page shows this list beside the
 * answer: "nothing explains this deposit" is a different statement from "nothing was even in range",
 * and the second is usually the true one early on.
 */
export function inRange(
  deposit: Deposit,
  settlements: Settlement[],
  opts: { windowDays?: number; payor?: string | null } = {},
): Settlement[] {
  const window = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const payor = (opts.payor ?? "").trim().toLowerCase();
  return settlements.filter((s) => {
    if (outstandingCents(s) <= 0) return false;
    const gap = daysBetween(s.on, deposit.on);
    // Never after the deposit: money does not arrive before the payer produces the file.
    if (!(gap >= 0 && gap <= window)) return false;
    if (payor && s.payor.trim().toLowerCase() !== payor) return false;
    return true;
  });
}

/** Every set of up to `MAX_SET_SIZE` settlements whose outstanding amounts total exactly the target. */
function exactSets(candidates: Settlement[], targetCents: number): Settlement[][] {
  const found: Settlement[][] = [];
  const chosen: Settlement[] = [];

  const walk = (start: number, remaining: number): void => {
    if (remaining === 0 && chosen.length > 0) {
      found.push([...chosen]);
      return;
    }
    if (remaining < 0 || chosen.length >= MAX_SET_SIZE || found.length > 8) return;
    for (let i = start; i < candidates.length; i++) {
      const c = candidates[i];
      const amount = outstandingCents(c);
      if (amount > remaining) continue;
      chosen.push(c);
      walk(i + 1, remaining - amount);
      chosen.pop();
    }
  };

  walk(0, targetCents);
  return found;
}

/**
 * What explains this deposit.
 *
 * `settlements` is everything outstanding; this narrows it by date and payer itself, so a caller
 * cannot forget to.
 */
export function explainDeposit(
  deposit: Deposit,
  settlements: Settlement[],
  opts: { windowDays?: number; payor?: string | null } = {},
): Explanation {
  if (deposit.amountCents <= 0) {
    return { kind: "unexplained", why: "Not a deposit: this line took money out rather than putting it in." };
  }

  const candidates = inRange(deposit, settlements, opts);
  if (candidates.length === 0) {
    return {
      kind: "unexplained",
      why: `No remittance or later payment is outstanding within ${opts.windowDays ?? DEFAULT_WINDOW_DAYS} days before this deposit. It may be register takings.`,
    };
  }
  if (candidates.length > MAX_CANDIDATES) {
    return {
      kind: "unexplained",
      why: `${candidates.length} settlements are outstanding in the window, too many to combine safely. Narrow it by payer, or tie this deposit by hand.`,
    };
  }

  const sets = exactSets(candidates, deposit.amountCents);
  if (sets.length === 1) {
    return { kind: "explained", settlements: sets[0], totalCents: deposit.amountCents };
  }
  if (sets.length > 1) {
    return {
      kind: "ambiguous",
      candidates: sets,
      why:
        `${sets.length} different sets of remittances add up to this deposit exactly. Choosing one would tie a payer's ` +
        `money to another payer's name, and the books would still balance — so this is left for somebody to settle.`,
    };
  }

  /*
   * Nothing adds up. A single larger outstanding settlement is what a split looks like.
   *
   * Offered as a candidate and never recorded: the arithmetic cannot tell a genuine part-payment
   * from a coincidence, and a part-payment asserted wrongly leaves a receivable that looks settled.
   */
  const larger = candidates.filter((s) => outstandingCents(s) > deposit.amountCents);
  if (larger.length > 0) {
    return {
      kind: "possible-split",
      settlements: larger.slice(0, 5),
      why:
        larger.length === 1
          ? `Nothing adds up to this deposit exactly, but ${larger[0].payor} has ${money(outstandingCents(larger[0]))} outstanding — this may be part of it, paid in instalments.`
          : `Nothing adds up to this deposit exactly. ${larger.length} outstanding remittances are larger than it, so it may be part of one of them.`,
    };
  }

  return {
    kind: "unexplained",
    why:
      `Nothing outstanding in the window adds up to this deposit, and everything in range is smaller than it. ` +
      `It is register takings, several payers at once, or money the site has not been told about.`,
  };
}

/**
 * A remittance nobody's deposit accounts for.
 *
 * The other half of §9, and the half that is actually about money owed: a payer that produced an
 * 835 and never sent the money is invisible unless somebody asks this question. Reported once the
 * grace period is past, because a remittance produced yesterday is not late.
 */
export function unpaidSettlements(
  settlements: Settlement[],
  today: string,
  opts: { graceDays?: number } = {},
): { settlement: Settlement; outstandingCents: number; daysWaiting: number }[] {
  const grace = opts.graceDays ?? DEFAULT_WINDOW_DAYS;
  return settlements
    .map((s) => ({ settlement: s, outstandingCents: outstandingCents(s), daysWaiting: daysBetween(s.on, today) }))
    .filter((r) => r.outstandingCents > 0 && Number.isFinite(r.daysWaiting) && r.daysWaiting > grace)
    .sort((a, b) => b.outstandingCents - a.outstandingCents);
}

/** Dollars for a sentence somebody reads, not a column. */
function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
