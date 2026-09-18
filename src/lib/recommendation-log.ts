/**
 * Remembering what the site recommended, and judging it by what happened next.
 *
 * The money list is rebuilt from scratch on every visit. That is right for the figures — they must
 * always be today's arithmetic on today's documents — and wrong for the advice, because advice
 * that is regenerated is advice with no memory: the same row appears for the fortieth morning
 * running, nobody knows whether it was tried, and the site cannot tell a recommendation that
 * worked from one that was ignored or one that was acted on and did nothing.
 *
 * So each row is reconciled against the log of rows seen before, by its key and subject:
 *
 *   - a row not seen before is **new**, and starts a log entry;
 *   - a row seen before is **persisting**, and its entry is brought up to date — the amount it
 *     claims today, the day it was last seen;
 *   - an entry whose row did not come back is **resolved**: the facts moved, or the thing was done.
 *
 * And where the claims can say what happened after a recommendation, the entry is scored. For
 * "buy this NDC instead of that one" the measure is direct: of the product's units dispensed since
 * the recommendation, what share went out under the NDC the site named, and what the gap between
 * the two NDCs came to on those units. That is the realised figure, on the pharmacy's own claims,
 * against the figure the site promised — the only honest test of the advice.
 *
 * Pure. The store loads and saves; this decides.
 */

import type { MoneyRow } from "./money-found";

export type LogEntry = {
  id: string;
  key: string;
  subject: string | null;
  says: string;
  todo: string;
  amountCents: number;
  cadence: string;
  confidence: string;
  firstSeenOn: string;
  lastSeenOn: string;
  resolvedOn: string | null;
  status: string;
  outcomeCents: number | null;
  outcomeBasis: string | null;
  measuredOn: string | null;
  note: string | null;
};

/** The identity of a row across days: its key, and the thing it is about where the key alone repeats. */
export function identityOf(row: MoneyRow): { key: string; subject: string | null } {
  // Rows about one product or one supplier carry it in the key already ("rebate-band-risk-mckesson").
  // Aggregate rows ("switch-ndc", "switch-supplier") are one entry each; their top item is in `todo`.
  return { key: row.key, subject: null };
}

export type Reconciled = {
  insert: Omit<LogEntry, "id">[];
  update: { id: string; lastSeenOn: string; amountCents: number; says: string; todo: string; confidence: string }[];
  resolve: { id: string; resolvedOn: string }[];
  /** For the page: how many mornings each row has been on the list. */
  ages: Map<string, number>;
};

const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * Today's rows against the open entries. A dismissed entry stays dismissed while its row keeps
 * appearing — the owner said no once and is not asked again — but is reopened as a new entry if
 * the row goes away and later comes back, because that is a different occasion.
 */
export function reconcile(open: LogEntry[], today: MoneyRow[], todayIso: string): Reconciled {
  const byKey = new Map<string, LogEntry>();
  for (const e of open) if (e.resolvedOn === null) byKey.set(`${e.key}|${e.subject ?? ""}`, e);
  const seen = new Set<string>();
  const out: Reconciled = { insert: [], update: [], resolve: [], ages: new Map() };

  for (const r of today) {
    const id = identityOf(r);
    const k = `${id.key}|${id.subject ?? ""}`;
    seen.add(k);
    const e = byKey.get(k);
    if (e) {
      out.update.push({ id: e.id, lastSeenOn: todayIso, amountCents: r.amountCents, says: r.says, todo: r.todo, confidence: r.confidence });
      out.ages.set(r.key, dayDiff(e.firstSeenOn, todayIso) + 1);
    } else {
      out.insert.push({
        key: id.key, subject: id.subject, says: r.says, todo: r.todo, amountCents: r.amountCents, cadence: r.cadence, confidence: r.confidence,
        firstSeenOn: todayIso, lastSeenOn: todayIso, resolvedOn: null, status: "open", outcomeCents: null, outcomeBasis: null, measuredOn: null, note: null,
      });
      out.ages.set(r.key, 1);
    }
  }
  for (const [k, e] of byKey) if (!seen.has(k)) out.resolve.push({ id: e.id, resolvedOn: todayIso });
  return out;
}

export type SwitchOutcome = {
  /** Units of the product dispensed since the recommendation. */
  unitsSince: number;
  /** Of those, the share that went out under the NDC the site named. */
  shareOnPick: number;
  /** The gap between the pick and the previous NDC, realised on the units that moved, in cents. */
  realisedCents: number;
  /** What the same gap would have been worth had every unit moved. */
  potentialCents: number;
  verdict: "followed" | "partly" | "not followed" | "too early";
  says: string;
};

/**
 * Scores "buy this NDC instead of that one" on the claims dispensed since it was said.
 *
 * `gapPerUnitMicros` is what the recommendation promised per unit (the pick's gap under NADAC less
 * the previous NDC's, from under-nadac.ts); the claims say how many units of the product went out
 * and under which NDC. Under `minUnits` nothing is concluded — a week of one product is not a test.
 */
export function switchOutcome(
  claimsSince: { ndc11: string | null; quantityThousandths: number | null; status?: string }[],
  pickNdc: string,
  productNdcs: Set<string>,
  gapPerUnitMicros: number,
  minUnits = 30,
): SwitchOutcome {
  let unitsSince = 0;
  let onPick = 0;
  for (const c of claimsSince) {
    if (c.status === "reversed" || !c.ndc11 || !productNdcs.has(c.ndc11) || !c.quantityThousandths || c.quantityThousandths <= 0) continue;
    const u = c.quantityThousandths / 1000;
    unitsSince += u;
    if (c.ndc11 === pickNdc) onPick += u;
  }
  const shareOnPick = unitsSince > 0 ? onPick / unitsSince : 0;
  const realisedCents = Math.round((gapPerUnitMicros * onPick) / 10_000);
  const potentialCents = Math.round((gapPerUnitMicros * unitsSince) / 10_000);
  const money = (c: number) => `$${(Math.abs(c) / 100).toFixed(2)}`;
  if (unitsSince < minUnits) {
    return { unitsSince, shareOnPick, realisedCents, potentialCents, verdict: "too early", says: `${unitsSince.toLocaleString()} units dispensed since; ${minUnits} are needed before anything is concluded.` };
  }
  const verdict: SwitchOutcome["verdict"] = shareOnPick >= 0.8 ? "followed" : shareOnPick >= 0.2 ? "partly" : "not followed";
  const says =
    verdict === "followed"
      ? `Followed: ${Math.round(shareOnPick * 100)}% of ${unitsSince.toLocaleString()} units went out under ${pickNdc}, worth ${money(realisedCents)} against the NDC it replaced.`
      : verdict === "partly"
        ? `Partly followed: ${Math.round(shareOnPick * 100)}% of ${unitsSince.toLocaleString()} units under ${pickNdc}, ${money(realisedCents)} realised of ${money(potentialCents)} possible.`
        : `Not followed: ${Math.round(shareOnPick * 100)}% of ${unitsSince.toLocaleString()} units under ${pickNdc}; ${money(potentialCents)} was there to be had.`;
  return { unitsSince, shareOnPick, realisedCents, potentialCents, verdict, says };
}

/**
 * The record, summed: what the site has said, what was taken up, what it came to.
 *
 * This is what lets the owner judge the site rather than take it on trust, and what lets the site
 * stop repeating a kind of advice that has been dismissed every time it was given.
 */
export function scorecard(entries: LogEntry[]): {
  open: number;
  acted: number;
  dismissed: number;
  resolved: number;
  promisedCents: number;
  realisedCents: number;
  byKey: { key: string; shown: number; acted: number; dismissed: number; realisedCents: number }[];
} {
  const byKey = new Map<string, { key: string; shown: number; acted: number; dismissed: number; realisedCents: number }>();
  let open = 0;
  let acted = 0;
  let dismissed = 0;
  let resolved = 0;
  let promised = 0;
  let realised = 0;
  for (const e of entries) {
    const k = byKey.get(e.key) ?? { key: e.key, shown: 0, acted: 0, dismissed: 0, realisedCents: 0 };
    k.shown++;
    if (e.status === "acted") { acted++; k.acted++; }
    else if (e.status === "dismissed") { dismissed++; k.dismissed++; }
    else if (e.resolvedOn) resolved++;
    else open++;
    promised += e.amountCents;
    if (e.outcomeCents !== null) { realised += e.outcomeCents; k.realisedCents += e.outcomeCents; }
    byKey.set(e.key, k);
  }
  return { open, acted, dismissed, resolved, promisedCents: promised, realisedCents: realised, byKey: [...byKey.values()].sort((a, b) => b.shown - a.shown) };
}
