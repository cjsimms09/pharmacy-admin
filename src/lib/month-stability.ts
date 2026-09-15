/**
 * A month that has been reported should not quietly become a different month.
 *
 * The owner, asked whether a fill sold in one month and returned in another belongs to the month of
 * the sale or the month it came back: *"Month it came back."* That answer buys one property above
 * all others — **a reported month is final** — and nothing in this site enforces it or would notice
 * if it broke. It has already broken twice: a return took revenue and cost back out of the month of
 * the sale (`fills.ts` drops a reversed row with no test of when it was reversed), and a month asked
 * for on its own loads its fills through a different window than the same month asked for inside a
 * strip, so the books and the chart answer differently.
 *
 * Both were found by a person reading code. This is the check that finds the next one.
 *
 * ── Why "it never moves" is the wrong rule ──
 *
 * A month does legitimately move. A day of the transaction report loaded late genuinely belongs to
 * August, and August should change when it arrives; so should a fill collected on the 31st that
 * reached the site on the 2nd. A check that forbids all movement would fire constantly, and a check
 * that fires constantly is one nobody reads.
 *
 * So the rule is not *nothing moved*. It is **every movement is explained to the cent**, which is
 * the same rule the remittance reader already lives by: the parts must add to the whole, and what
 * does not add up is named rather than rounded away. A caller that knows why August grew says so
 * and the growth is accounted for. What is left over is the finding — money that moved in a closed
 * month with nothing to account for it, which is precisely the silent restatement the owner's
 * decision exists to prevent.
 *
 * ── The third state, again ──
 *
 * A month with no snapshot is not a stable month. It is a month nobody has ever written down, which
 * is a different answer from "checked and unchanged" and must never be reported as one. Same rule
 * as `data-health.ts`'s: a measurement never taken is not a measurement of zero.
 *
 * ── No tolerance ──
 *
 * Deliberately exact. Every figure here is integer cents, so there is no rounding to absorb, and a
 * tolerance is a place for a real difference to hide — the DIR fee that went missing was $57.50,
 * and a check that shrugged at "close enough" would have shrugged at that. The 835 gate refuses on
 * `differenceCents !== 0` for the same reason.
 *
 * Pure. The store keeps the snapshots and supplies the causes.
 */

/** The figures a month is judged on. Adding one here is adding it to the guarantee. */
export const WATCHED = [
  { key: "revenueCents", what: "Revenue" },
  { key: "costOfGoodsCents", what: "Cost of goods" },
  { key: "grossProfitCents", what: "Gross profit" },
  { key: "netProfitCents", what: "The bottom line" },
] as const;

export type WatchedKey = (typeof WATCHED)[number]["key"];

/** A month's account as it stood when it was last written down. */
export type MonthSnapshot = {
  month: string;
  basis: "accrual" | "cash";
  /** The day it was taken, so a drift can be described as "since the 3rd". */
  takenOn: string;
  figures: Record<WatchedKey, number>;
};

/** The same month, recomputed now. */
export type MonthNow = { month: string; basis: "accrual" | "cash"; figures: Record<WatchedKey, number> };

/**
 * Something that legitimately moved the month after the snapshot was taken.
 *
 * Supplied by the caller, because only the store knows what arrived. Each names the figures it
 * moves and by how much, and the amounts are what make it an explanation rather than an excuse: a
 * cause that does not say how much it moved cannot cancel a drift.
 */
export type Cause = { what: string; moves: { key: WatchedKey; cents: number }[] };

export type Drift = { key: WatchedKey; what: string; wasCents: number; nowCents: number; byCents: number };

export type Unexplained = { key: WatchedKey; what: string; cents: number; says: string };

export type Stability = {
  state: "unsnapshotted" | "unchanged" | "explained" | "unexplained";
  /** Every figure that is not what it was, explained or not. */
  drifts: Drift[];
  /** The residue, per figure: what moved with nothing to account for it. */
  unexplained: Unexplained[];
  says: string;
};

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (c: number) => `${c < 0 ? "−" : "+"}${money(c)}`;

/** What a month's figures did since they were written down, and whether anything says why. */
export function stabilityOf(snapshot: MonthSnapshot | null, now: MonthNow, causes: Cause[] = []): Stability {
  if (!snapshot) {
    return {
      state: "unsnapshotted",
      drifts: [],
      unexplained: [],
      says: `${now.month} has never been written down, so nothing can be said about whether it has moved. That is not the same as unchanged.`,
    };
  }
  if (snapshot.basis !== now.basis) {
    /*
     * Two bases are two different accounts of the same month and comparing them says nothing. A
     * mismatch here is a caller fault, and a wrong answer would be worse than a refusal.
     */
    throw new Error(`A ${snapshot.basis} snapshot cannot be compared with a ${now.basis} account: they answer different questions.`);
  }

  const drifts: Drift[] = [];
  for (const w of WATCHED) {
    const was = snapshot.figures[w.key];
    const is = now.figures[w.key];
    if (was !== is) drifts.push({ key: w.key, what: w.what, wasCents: was, nowCents: is, byCents: is - was });
  }

  if (drifts.length === 0) {
    return { state: "unchanged", drifts: [], unexplained: [], says: `${now.month} is exactly as it was on ${snapshot.takenOn}.` };
  }

  const unexplained: Unexplained[] = [];
  for (const d of drifts) {
    const accounted = causes.reduce((n, c) => n + c.moves.filter((m) => m.key === d.key).reduce((s, m) => s + m.cents, 0), 0);
    const residue = d.byCents - accounted;
    if (residue !== 0) {
      unexplained.push({
        key: d.key,
        what: d.what,
        cents: residue,
        says:
          accounted === 0
            ? `${d.what} moved ${signed(d.byCents)} since ${snapshot.takenOn} and nothing accounts for it.`
            : `${d.what} moved ${signed(d.byCents)} since ${snapshot.takenOn}; ${signed(accounted)} is accounted for and ${signed(residue)} is not.`,
      });
    }
  }

  if (unexplained.length === 0) {
    return {
      state: "explained",
      drifts,
      unexplained: [],
      says: `${now.month} has moved since ${snapshot.takenOn}, and every penny of it is accounted for: ${causes.map((c) => c.what).join("; ")}.`,
    };
  }

  const worst = [...unexplained].sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents))[0];
  return {
    state: "unexplained",
    drifts,
    unexplained,
    says:
      `${now.month} was reported and has changed since ${snapshot.takenOn} with nothing to account for it. ` +
      `${worst.says} A month that moves after it has been read is the fault this check exists to catch — the figures somebody acted on are not the figures now.`,
  };
}

/** Every month at once, worst first, for the page. */
export function stabilityOfAll(
  months: { snapshot: MonthSnapshot | null; now: MonthNow; causes?: Cause[] }[],
): { rows: (Stability & { month: string })[]; worst: Stability["state"]; says: string } {
  const rows = months.map((m) => ({ ...stabilityOf(m.snapshot, m.now, m.causes ?? []), month: m.now.month }));
  const rank: Record<Stability["state"], number> = { unexplained: 3, unsnapshotted: 2, explained: 1, unchanged: 0 };
  const worst = rows.reduce<Stability["state"]>((w, r) => (rank[r.state] > rank[w] ? r.state : w), "unchanged");
  const bad = rows.filter((r) => r.state === "unexplained");
  const never = rows.filter((r) => r.state === "unsnapshotted");
  const says =
    bad.length > 0
      ? `${bad.length} reported month${bad.length === 1 ? " has" : "s have"} changed with nothing to account for it: ${bad.map((r) => r.month).join(", ")}.`
      : never.length === rows.length && rows.length > 0
        ? "No month has ever been written down, so none of them can be checked for having moved."
        : never.length > 0
          ? `Every month that was written down is accounted for; ${never.length} ${never.length === 1 ? "has" : "have"} never been written down and cannot be checked.`
          : "Every reported month is either unchanged or accounted for to the cent.";
  return { rows: [...rows].sort((a, b) => rank[b.state] - rank[a.state] || a.month.localeCompare(b.month)), worst, says };
}
