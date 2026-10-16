/**
 * Which invoices a wholesaler's ACH debit actually paid, found by date and amount.
 *
 * ── Why this exists ──
 *
 * The owner, 17 September 2026: "You should be able to match IPC by date and amount.. same with all
 * other suppliers.. you have invoice amount and billing cadance.. you should be able to match
 * these." He was right, and the matcher could not: it placed a payment only where ONE open invoice
 * equalled the debit exactly. A wholesaler that bills daily and collects on a cycle never produces
 * that — IPC bills twice a day and draws every morning, so every one of its debits pays a handful of
 * invoices and equals none of them.
 *
 * Tested against his own statement before it was written: of eight IPC debits, two are exactly the
 * sum of two invoices each, and both of those sets were in PioneerRx's receiving rather than in the
 * emailed invoices. The rest pay August, which this pharmacy's books deliberately do not hold.
 *
 * ── The rule that keeps it honest ──
 *
 * Exact sums, and **ambiguity refuses**. Where two different sets of invoices add to the same figure
 * there is no way to tell which the wholesaler actually settled, and picking one marks the wrong
 * bills paid and hides the ones still owed — a worse state than leaving the line alone, because it
 * looks finished. A payment allocated wrongly is the kind of error nobody goes looking for.
 *
 * Bounded three ways so it cannot become a puzzle solver: only invoices on or before the debit, only
 * within a lag window, and a step ceiling. A basket big enough to need more than that is a basket
 * where a coincidental sum is likely, which is exactly when this should stop.
 *
 * Pure.
 */

export type PayableInvoice = {
  id: string;
  /** The supplier's own number, for saying which invoices were settled. */
  number: string;
  /** ISO date on the invoice. */
  on: string;
  /** Positive for an invoice, negative for a credit note — both belong in the sum. */
  cents: number;
};

export type PaysInvoices =
  | { kind: "settles"; invoices: PayableInvoice[]; says: string }
  | { kind: "ambiguous"; sets: number; says: string }
  | { kind: "none"; considered: number; says: string }
  /**
   * The cadence named the days this draw is for, and they do not add up to it.
   *
   * The owner: "the next thing to learn about suppliers isn't just when they bill but what dates is
   * that payment for, we should be able to figure that out." Once that is known this stops being a
   * search and becomes a statement with a number attached — and the interesting answer is not
   * "settled" but this one: the period is known, the arithmetic is known, and they differ.
   *
   * That is a real finding every time. It means an invoice for those days never reached the site, or
   * a credit was applied that did not, or the draw covered something else. A search would have gone
   * on hunting for any combination that fitted and found one eventually; this says what is missing
   * and how much of it.
   */
  | { kind: "period_disagrees"; from: string; to: string; expectedCents: number; drawCents: number; invoices: PayableInvoice[]; says: string };

/**
 * How far back a debit may reach for the invoices it settles.
 *
 * Forty-five days covers a monthly statement paid in arrears and a fortnightly one paid late, and
 * stops well short of the window in which a second, unrelated basket of invoices could add to the
 * same figure by chance.
 */
export const LAG_DAYS = 45;

/** Enough to search a fortnight of a daily biller; small enough that this can never hang a page. */
const MAX_STEPS = 200_000;

/** Every distinct subset summing exactly to the target, up to `limit`. */
function subsetsSummingTo(items: PayableInvoice[], target: number, limit: number): PayableInvoice[][] {
  const out: PayableInvoice[][] = [];
  let steps = 0;
  const walk = (i: number, left: number, chosen: PayableInvoice[]) => {
    if (out.length >= limit || ++steps > MAX_STEPS) return;
    if (left === 0 && chosen.length > 0) {
      out.push([...chosen]);
      return;
    }
    if (i >= items.length) return;
    /*
     * No pruning on a negative remainder.
     *
     * A credit note is a negative line and a real part of what a debit settles — IPC's CM107761 is
     * −$199.00 — so a search that gave up as soon as the remainder went below zero would refuse
     * every payment that included one, which is precisely the payment hardest to check by hand.
     */
    walk(i + 1, left - items[i].cents, [...chosen, items[i]]);
    walk(i + 1, left, chosen);
  };
  walk(0, target, []);
  return out;
}

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * @param debitCents what left the bank, as a positive number
 * @param on the day it left
 */
export function invoicesPaidBy(
  debitCents: number,
  on: string,
  invoices: PayableInvoice[],
  /**
   * The days this draw is for, where the supplier's cadence is known (`datesDrawnOn`).
   *
   * Given them, no search happens at all: the days are added up and compared. That is the whole
   * value of having learned the cadence — an answer instead of a hunt, and a named difference
   * instead of "no subset adds to it" when it does not tie.
   */
  period?: string[],
): PaysInvoices {
  if (period && period.length > 0) {
    const from = period[0];
    const to = period[period.length - 1];
    const inPeriod = invoices.filter((i) => i.on >= from && i.on <= to);
    const expected = inPeriod.reduce((n, i) => n + i.cents, 0);
    if (inPeriod.length > 0 && expected === debitCents) {
      const chosen = inPeriod.slice().sort((a, b) => (a.on === b.on ? a.number.localeCompare(b.number) : a.on.localeCompare(b.on)));
      return {
        kind: "settles",
        invoices: chosen,
        says:
          `${money(debitCents)} is the billing of ${from === to ? from : `${from} to ${to}`} — ${chosen.length} invoice${chosen.length === 1 ? "" : "s"}, ` +
          `which is what this supplier's cadence says a draw on ${on} is for.`,
      };
    }
    if (inPeriod.length > 0) {
      const short = debitCents - expected;
      return {
        kind: "period_disagrees",
        from,
        to,
        expectedCents: expected,
        drawCents: debitCents,
        invoices: inPeriod,
        says:
          `This supplier's cadence says a draw on ${on} is for the billing of ${from === to ? from : `${from} to ${to}`}. ` +
          `The ${inPeriod.length} invoice${inPeriod.length === 1 ? "" : "s"} on file for ${from === to ? "that day" : "those days"} come to ${money(expected)}, and the draw was ${money(debitCents)} — ` +
          `${money(Math.abs(short))} ${short > 0 ? "more than the site holds, so an invoice for that period never arrived" : "less than the site holds, so a credit was applied that did not"}.`,
      };
    }
    /* Nothing on file for the period the cadence names: fall through and search, rather than assert. */
  }

  const within = invoices.filter((i) => i.on <= on && Date.parse(on) - Date.parse(i.on) <= LAG_DAYS * 86_400_000);
  if (within.length === 0) {
    return { kind: "none", considered: 0, says: `No invoice from this supplier in the ${LAG_DAYS} days before ${on}, so there is nothing for it to have settled.` };
  }

  /* Three, not two: a third set is as fatal as a second, and stopping at three keeps the search short. */
  const sets = subsetsSummingTo(within, debitCents, 3);
  if (sets.length === 0) {
    return {
      kind: "none",
      considered: within.length,
      says: `No combination of the ${within.length} invoice${within.length === 1 ? "" : "s"} in the ${LAG_DAYS} days before ${on} adds to ${money(debitCents)}.`,
    };
  }
  if (sets.length > 1) {
    return {
      kind: "ambiguous",
      sets: sets.length,
      says:
        `More than one set of invoices adds to ${money(debitCents)}, so which the wholesaler settled cannot be told from the amount. ` +
        `Left alone rather than guessed: marking the wrong invoices paid hides the ones still owed.`,
    };
  }

  const chosen = sets[0].slice().sort((a, b) => (a.on === b.on ? a.number.localeCompare(b.number) : a.on.localeCompare(b.on)));
  return {
    kind: "settles",
    invoices: chosen,
    says:
      `${money(debitCents)} is exactly ${chosen.length === 1 ? "this invoice" : `these ${chosen.length} invoices`}: ` +
      `${chosen.map((i) => `${i.number} (${money(i.cents)}${i.cents < 0 ? " credit" : ""})`).join(", ")}.`,
  };
}
