/**
 * How each wholesaler draws: how long after billing, and how much of the ledger at a time.
 *
 * ── Why a learned cadence beats a search ──
 *
 * The owner: "We already know mckessons billing cadance don't we? Once weekly?" Yes — and the
 * matcher was searching for a set of invoices adding to each debit as though it knew nothing. Over
 * IPC's dozen invoices a subset search is fine. Over McKesson's forty-two it does not terminate; it
 * runs out of steps and reports "no subset adds to it", which is a search giving up wearing the
 * clothes of an answer. That sentence was in a report I gave him, and it was worthless.
 *
 * A supplier does not pay an arbitrary basket. It pays what it billed over a period, a fixed time
 * after billing it. Two numbers — the lag and the span — turn an exponential search into an
 * arithmetic check: add up the days the cadence names, and see whether it equals the draw.
 *
 * ── Measured, not assumed ──
 *
 * The cadence is learned from draws that have already been settled, not typed in and not guessed
 * from a supplier's reputation. Two of his IPC draws settled by exact sums before this existed, and
 * both came out at seven days: the draw of 9 September was the invoices of 2 September, and the
 * draw of the 10th was the invoices of the 3rd. That is what this generalises.
 *
 * One confirmation is a coincidence. The lag is only offered where at least two settled draws agree
 * on it, because a single seven-day gap between one debit and one day's billing is exactly what a
 * fortnightly biller looks like on its first payment.
 *
 * Pure.
 */

export type SettledDraw = {
  /** The day the money left. */
  on: string;
  /** The invoice dates the draw was proved to have settled. */
  invoiceDates: string[];
};

export type Cadence = {
  /** Days between the last invoice in a draw and the draw itself. */
  lagDays: number;
  /** How many days of billing one draw covers: 1 for a daily biller drawn daily, 7 for a weekly. */
  spanDays: number;
  /** How many settled draws agree on this. Never fewer than two. */
  from: number;
  says: string;
};

const DAY = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

/** The most common value, and how often it occurred. Ties go to the smaller value, so it is stable. */
function commonest(values: number[]): { value: number; count: number } | null {
  if (values.length === 0) return null;
  const tally = new Map<number, number>();
  for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
  return [...tally]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value - b.value)[0];
}

/**
 * What a supplier's settled draws say about how it collects.
 *
 * @param settled draws already proved against their invoices, by whatever means
 */
export function learnCadence(settled: SettledDraw[]): Cadence | null {
  const usable = settled.filter((s) => s.invoiceDates.length > 0);
  if (usable.length < 2) return null;

  const lags: number[] = [];
  const spans: number[] = [];
  for (const s of usable) {
    const sorted = [...s.invoiceDates].sort();
    const last = sorted[sorted.length - 1];
    const first = sorted[0];
    /* Measured from the LAST invoice in the draw: a supplier collects a period once it has closed. */
    lags.push(days(last, s.on));
    spans.push(days(first, last) + 1);
  }

  const lag = commonest(lags);
  const span = commonest(spans);
  if (!lag || !span || lag.count < 2) return null;

  return {
    lagDays: lag.value,
    spanDays: span.value,
    from: lag.count,
    says:
      `Draws ${lag.value} day${lag.value === 1 ? "" : "s"} after billing, covering ${span.value === 1 ? "a single day" : `${span.value} days`} of invoices at a time. ` +
      `Measured from ${lag.count} settled draw${lag.count === 1 ? "" : "s"}, not assumed.`,
  };
}

/**
 * The invoice dates a cadence says a given draw should be settling.
 *
 * The answer to "which invoices is this debit for" once the cadence is known: not a search, a
 * subtraction. The caller adds those days up and compares — and where it does not equal the draw,
 * that disagreement is worth far more than a search that would have kept looking until something
 * fitted.
 */
export function datesDrawnOn(cadence: Cadence, on: string): string[] {
  const last = Date.parse(`${on}T00:00:00Z`) - cadence.lagDays * DAY;
  const out: string[] = [];
  for (let i = cadence.spanDays - 1; i >= 0; i--) out.push(new Date(last - i * DAY).toISOString().slice(0, 10));
  return out;
}
