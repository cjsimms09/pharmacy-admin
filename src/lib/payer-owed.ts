/**
 * What each payer owes against what it has actually sent.
 *
 * The owner: "it should be easy to know how much a payer owes us for a claim." Nothing on the site
 * answers it. Every ingredient is on file — each payer's receivable is its own remit on its own
 * transmission (`payerShares` in fills.ts), and what arrived is `claim_payments` — but the two have
 * never been put in the same room.
 *
 * ── The whole difficulty is that nothing has arrived yet ──
 *
 * No real payer 835 has ever reached this pharmacy. Billed, on 9 September 2026: $131,743.31.
 * Received: nothing. A page that renders that as a column of $0.00 against a column of five-figure
 * sums looks broken, and a page that looks broken gets ignored on the day it stops being wrong.
 *
 * So the states are named rather than left to be read off two numbers. Three of them are easy to
 * confuse and only one means something is wrong:
 *
 *   nothing to measure   a cash plan. It never sends money and never will. Not a debt.
 *   never measured       a real payer that has never remitted. Outstanding, and not late — the
 *                        site has no idea what late means for it until the first one lands.
 *   measured             it has paid before. Now the outstanding balance is a fact about a payer
 *                        that is capable of paying, which is the only version worth chasing.
 *
 * The same confusion in a different costume is the 24 facilitator payments on file, $5,808.33,
 * matching no claim. They are for fills between January and August; this site's records begin on
 * 1 September. Money with nothing to attach to is not an error and must not be counted as one.
 *
 * ── What this refuses to say ──
 *
 * That anything is late. No remittance cycle is on file for any payer — not in the contracts that
 * have been read, not on the payer register — so "30 days" would be a number this pharmacy invented
 * and then believed. It says how long the payer's oldest claim has been waiting and leaves the
 * judgement to somebody who knows the contract. A deadline nobody imposed has already cost this
 * project once.
 *
 * Nor that the age it prints is the age of anything *unsettled*. Payments are summed per payer, not
 * matched claim by claim, so where a payer has part-paid there is no telling which of its claims the
 * money covered. See `oldestOn`: this said the stronger thing until 1 caught it on review, which is
 * the fault this codebase is least able to afford — a comment asserting an invariant its code does
 * not enforce, where the comments are how the rules are known.
 *
 * Pure. `payer-owed-store.ts` loads the rows.
 */

/** One payer's claim on one fill: what it said it would pay. */
export type Receivable = {
  bin: string | null;
  name: string | null;
  /** The day the prescription was filled, which is when the payer's obligation begins. */
  dateFilled: string;
  cents: number;
  /** True where the plan is one the pharmacy bills through that never remits. */
  cashPlan: boolean;
};

/** One payment that arrived, as `claim_payments` holds it. */
export type Received = {
  /** Which payer sent it, matched to a receivable on the BIN where the remittance named one. */
  bin: string | null;
  payer: string | null;
  cents: number;
  receivedOn: string | null;
  /** False where the payment found no claim on file: money with nothing to attach to. */
  matched: boolean;
};

export type PayerState =
  /** Bills through this plan; the copay is the money. Nothing is owed, ever. */
  | "cashPlan"
  /** Billed and received agree. */
  | "settled"
  /** Outstanding, and nothing has ever arrived from this payer, so nothing is overdue yet. */
  | "waiting"
  /** Outstanding, from a payer that has paid before. The only state worth chasing. */
  | "owes"
  /** More has arrived than was billed. Worth a look either way. */
  | "overpaid";

export type PayerLine = {
  bin: string | null;
  name: string;
  claims: number;
  billedCents: number;
  receivedCents: number;
  /** Billed less received, floored at nought: an overpayment is its own state, not a negative debt. */
  outstandingCents: number;
  /**
   * The fill date of the oldest claim billed to this payer.
   *
   * Not the oldest *unsettled* one, which this shape cannot know: what has arrived is summed per
   * payer, not matched claim by claim, so there is no telling which of a payer's claims a payment
   * covered. Where a payer has part-paid, this is therefore the longest anything of its could have
   * been waiting rather than the longest anything has — it errs towards chasing, which is the safe
   * direction, but it is not the stronger claim the name suggests.
   */
  oldestOn: string | null;
  daysWaiting: number | null;
  state: PayerState;
  /** One sentence saying what the two figures mean, so neither is read alone. */
  says: string;
};

export type OwedSummary = {
  lines: PayerLine[];
  billedCents: number;
  receivedCents: number;
  outstandingCents: number;
  /** Payments that found no claim. Not an error: see the module note. */
  unattached: { count: number; cents: number };
  /** True where no payer has ever sent anything. The state the whole page has to survive. */
  nothingHasArrived: boolean;
  /** The headline, in words, above the table. */
  says: string;
};

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Whole days between two ISO dates, or null where either is missing or unreadable. */
export function daysBetween(from: string | null, to: string): number | null {
  if (!from) return null;
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * The key a payer is grouped on.
 *
 * The BIN, because that is what a claim carries and what a remittance names. A payer with no BIN at
 * all is grouped under its printed name rather than being merged with every other nameless one —
 * two payers nothing can identify are still two payers.
 */
function keyOf(bin: string | null, name: string | null): string {
  const b = (bin ?? "").trim();
  if (b) return `bin:${b}`;
  return `name:${(name ?? "unnamed").trim().toLowerCase()}`;
}

/**
 * What each payer owes, and — the part that matters — what its two figures mean together.
 *
 * `today` is passed rather than read so this stays pure and so the sentences are testable.
 */
export function owedByPayer(receivables: Receivable[], received: Received[], today: string): OwedSummary {
  type Acc = { bin: string | null; name: string; claims: number; billed: number; got: number; oldest: string | null; cash: boolean; payments: number };
  const by = new Map<string, Acc>();

  for (const r of receivables) {
    const k = keyOf(r.bin, r.name);
    const a = by.get(k) ?? { bin: r.bin, name: r.name ?? r.bin ?? "Unnamed payer", claims: 0, billed: 0, got: 0, oldest: null, cash: r.cashPlan, payments: 0 };
    a.claims++;
    a.billed += r.cents;
    if (!a.oldest || r.dateFilled < a.oldest) a.oldest = r.dateFilled;
    // One cash row makes the plan a cash plan: the flag is a property of the plan, not of the fill.
    if (r.cashPlan) a.cash = true;
    if (!a.name || a.name === a.bin) a.name = r.name ?? a.name;
    by.set(k, a);
  }

  let unattachedCount = 0;
  let unattachedCents = 0;
  for (const p of received) {
    if (!p.matched) {
      /*
       * Money that found no claim. Counted apart and never against a payer's balance: attributing
       * it would settle a debt with a payment for a fill this site has never held, and the balance
       * would look right for the wrong reason.
       */
      unattachedCount++;
      unattachedCents += p.cents;
      continue;
    }
    const k = keyOf(p.bin, p.payer);
    const a = by.get(k);
    /*
     * A matched payment whose payer has no receivable here is still money received, but it belongs
     * to a claim outside whatever period was asked for. Left out rather than credited, so a
     * September balance is not settled by an August payment that September never billed for.
     */
    if (!a) continue;
    a.got += p.cents;
    a.payments++;
  }

  const lines: PayerLine[] = [...by.values()]
    .map((a) => {
      const outstanding = Math.max(0, a.billed - a.got);
      const days = daysBetween(a.oldest, today);
      const state: PayerState = a.cash
        ? "cashPlan"
        : a.got > a.billed
          ? "overpaid"
          : outstanding === 0
            ? "settled"
            : a.payments === 0
              ? "waiting"
              : "owes";
      return {
        bin: a.bin,
        name: a.name,
        claims: a.claims,
        billedCents: a.billed,
        receivedCents: a.got,
        outstandingCents: outstanding,
        oldestOn: a.oldest,
        daysWaiting: outstanding > 0 ? days : null,
        state,
        says: sentenceFor(state, a.name, outstanding, a.got, a.billed, days),
      };
    })
    // Largest outstanding first: the page exists to answer "who owes me the most".
    .sort((x, y) => y.outstandingCents - x.outstandingCents || y.billedCents - x.billedCents);

  const billedCents = lines.reduce((n, l) => n + l.billedCents, 0);
  const receivedCents = lines.reduce((n, l) => n + l.receivedCents, 0);
  const outstandingCents = lines.reduce((n, l) => n + l.outstandingCents, 0);
  const real = lines.filter((l) => l.state !== "cashPlan");
  const nothingHasArrived = real.length > 0 && real.every((l) => l.receivedCents === 0);

  return {
    lines,
    billedCents,
    receivedCents,
    outstandingCents,
    unattached: { count: unattachedCount, cents: unattachedCents },
    nothingHasArrived,
    says: headline({ lines, real, billedCents, receivedCents, outstandingCents, nothingHasArrived, unattachedCount, unattachedCents }),
  };
}

function sentenceFor(state: PayerState, name: string, outstanding: number, got: number, billed: number, days: number | null): string {
  switch (state) {
    case "cashPlan":
      return `${name} is a plan the pharmacy bills through rather than one that pays: the copay is the money, and the ${money(billed)} here was collected at the counter. Nothing is owed.`;
    case "settled":
      return `${money(billed)} billed and ${money(got)} received. Square.`;
    case "waiting":
      /*
       * The sentence the whole page is for. It says outstanding without saying overdue, because
       * nothing on file says how long this payer takes and the site will not invent a figure.
       */
      return (
        `${money(outstanding)} outstanding. Nothing has arrived from ${name} yet, so this is not late — it is unpaid, which is a different thing.` +
        (days === null ? "" : ` The oldest claim was filled ${days} ${days === 1 ? "day" : "days"} ago.`) +
        " No remittance cycle for this payer is on file; the first one that lands will say what normal looks like."
      );
    case "owes":
      return (
        `${money(outstanding)} outstanding of ${money(billed)} billed. ${name} has remitted before — ${money(got)} so far — so this is a balance from a payer that does pay.` +
        (days === null ? "" : ` Oldest unsettled claim filled ${days} ${days === 1 ? "day" : "days"} ago.`)
      );
    case "overpaid":
      return `${money(got)} received against ${money(billed)} billed — ${money(got - billed)} more than this pharmacy asked for. Worth reading before it is spent.`;
  }
}

function headline(a: {
  lines: PayerLine[];
  real: PayerLine[];
  billedCents: number;
  receivedCents: number;
  outstandingCents: number;
  nothingHasArrived: boolean;
  unattachedCount: number;
  unattachedCents: number;
}): string {
  if (a.lines.length === 0) return "No claims have been billed to any payer yet, so nobody owes anything.";

  const tail =
    a.unattachedCount > 0
      ? ` Separately, ${a.unattachedCount} payment${a.unattachedCount === 1 ? "" : "s"} totalling ${money(a.unattachedCents)} arrived for prescriptions this site does not hold — fills from before its records begin. That money is real and is counted nowhere on this page, because there is no claim here for it to settle.`
      : "";

  if (a.real.length === 0) {
    return `Every plan billed is one the pharmacy bills through rather than one that pays. Nothing is owed by anybody.${tail}`;
  }
  if (a.nothingHasArrived) {
    /*
     * The state this page was hardest to write for. $131,743.31 billed and nothing received is not
     * a fault in the page, in the claims, or in the payers — it is a pharmacy eight days into
     * keeping its own records, before the first remittance cycle has come round.
     */
    return (
      `${money(a.billedCents)} billed to ${a.real.length} payer${a.real.length === 1 ? "" : "s"} and nothing received from any of them yet. ` +
      `That is not this page failing: no remittance has reached the pharmacy since these records began, so every figure in the received column is a true nought rather than a missing one. ` +
      `When the first 835 arrives it will land here.${tail}`
    );
  }
  return `${money(a.billedCents)} billed, ${money(a.receivedCents)} received, ${money(a.outstandingCents)} outstanding across ${a.real.length} payer${a.real.length === 1 ? "" : "s"}.${tail}`;
}
