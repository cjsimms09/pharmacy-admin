/**
 * What changed this week in what the pharmacy pays and what it is paid, and what it costs.
 *
 * The buy list (`under-nadac.ts`) says where every product stands today. This says what *moved*:
 * a supplier's price up on something dispensed every day, or NADAC down under the pharmacy's cost,
 * so that the next fill on a floor plan is paid at the new figure before anybody has noticed. Both
 * are one pass over data already arriving once the catalogue history is kept
 * (`data-audit.md` §3.1, §4.3).
 *
 * ── The rules the rows keep ──
 *
 * **A move is a change, not a standing position.** A product that has been over NADAC for a year is
 * the buy list's business and is already on the money list as "switch-ndc"; repeating it here
 * would count it twice. So every row is a transition between the two most recent points, and the
 * row names both points and both dates so it can be checked against the two files.
 *
 * **Money is on this pharmacy's own units.** A price up two cents on something dispensed twice a
 * year is not worth a line; the same two cents on 400 units a day is $240 a month. Every amount
 * is (per-unit change) × (units a day) × 30, and the units come from the claims, not from the
 * catalogue.
 *
 * **The floor share is not guessed.** A NADAC fall costs money only on the units paid at NADAC. Where
 * `pay-basis.ts` has said what share of an NDC's units are on floor or NADAC-tracking plans, the
 * row uses it and is "likely"; where it has not, the row uses every unit and says "worth checking",
 * because the true figure can only be smaller and nobody should act on a ceiling without knowing
 * it is one.
 *
 * **Confidence never scales the money** (`recommendations.ts`).
 *
 * Pure. The caller loads the history and the usage and decides what to show.
 */

import type { MoneyRow } from "./money-found";

/** One price for one NDC at one supplier on one day: a row of `supplier_price_history`. */
export type PricePoint = {
  ndc11: string;
  supplier: string;
  on: string;
  /** As listed, per unit. */
  unitMicros: number;
  /** After the rebate rate where the line is rebated and a rate is on file; equal to the gross otherwise. */
  effectiveUnitMicros?: number;
  shortDated?: boolean;
};

/** One NADAC per-unit figure for one NDC, effective from a date. */
export type NadacPoint = { ndc11: string; on: string; unitMicros: number };

/** How much of an NDC this pharmacy goes through, from the claims. */
export type NdcUsage = {
  ndc11: string;
  name: string | null;
  unitsPerDay: number;
  /**
   * Share of the units, 0 to 1, dispensed on plans that pay at NADAC (the floor and the
   * NADAC-tracking plans, per `pay-basis.ts`). Null where the plans have not been classified.
   */
  floorShare: number | null;
  groupKey: string | null;
};

/** Another NDC of the same product, with the cheapest effective cost known for it. */
export type Alternative = { ndc11: string; name: string | null; supplier: string; effectiveUnitMicros: number; groupKey: string | null };

export type Move = {
  ndc11: string;
  supplier: string;
  from: { on: string; unitMicros: number };
  to: { on: string; unitMicros: number };
  deltaMicros: number;
  percent: number;
};

export type PriceMovesInput = {
  history: PricePoint[];
  nadac?: NadacPoint[];
  usage: NdcUsage[];
  /** Every NDC of every product with a usable price, so a row can say what to buy instead. */
  alternatives?: Alternative[];
  /** Rows under this a month are not worth a line. */
  minMonthlyCents?: number;
  /** A rise under this share of the old price is noise (rounding in the file, a cent on a large pack). */
  minRisePercent?: number;
};

export type PriceMoves = {
  rows: MoneyRow[];
  /** Moves seen and not worth a row, with the reason, so the page can show its working. */
  quiet: { ndc11: string; says: string }[];
};

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const perUnit = (m: number) => `$${(m / 1_000_000).toFixed(4)}`;
const DAYS = 30;

const eff = (p: PricePoint) => p.effectiveUnitMicros ?? p.unitMicros;

/**
 * The last two prices at each supplier for each NDC, as a move.
 *
 * Two points on the same day are one point (the later import wins); a price that did not change
 * between files is not a move. Short-dated offers are not prices, because they are not what the
 * pharmacy will pay next week.
 */
export function priceMoves(history: PricePoint[]): Move[] {
  const byKey = new Map<string, PricePoint[]>();
  for (const p of history) {
    if (p.shortDated) continue;
    const k = `${p.ndc11}|${p.supplier}`;
    byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }
  const moves: Move[] = [];
  for (const points of byKey.values()) {
    const byDay = new Map<string, PricePoint>();
    for (const p of [...points].sort((a, b) => a.on.localeCompare(b.on))) byDay.set(p.on, p);
    const days = [...byDay.keys()].sort();
    if (days.length < 2) continue;
    const to = byDay.get(days[days.length - 1])!;
    const from = byDay.get(days[days.length - 2])!;
    if (eff(to) === eff(from)) continue;
    moves.push({
      ndc11: to.ndc11, supplier: to.supplier,
      from: { on: from.on, unitMicros: eff(from) }, to: { on: to.on, unitMicros: eff(to) },
      deltaMicros: eff(to) - eff(from),
      percent: eff(from) > 0 ? ((eff(to) - eff(from)) / eff(from)) * 100 : 0,
    });
  }
  return moves;
}

/** The cheapest effective price per NDC as of a day, across suppliers: what the pharmacy would pay. */
function bestAsOf(history: PricePoint[], ndc11: string, on: string): PricePoint | null {
  let best: PricePoint | null = null;
  const latest = new Map<string, PricePoint>();
  for (const p of history) {
    if (p.ndc11 !== ndc11 || p.shortDated || p.on > on) continue;
    const cur = latest.get(p.supplier);
    if (!cur || p.on >= cur.on) latest.set(p.supplier, p);
  }
  for (const p of latest.values()) if (!best || eff(p) < eff(best)) best = p;
  return best;
}

function nadacAsOf(nadac: NadacPoint[], ndc11: string, on: string): NadacPoint | null {
  let best: NadacPoint | null = null;
  for (const n of nadac) {
    if (n.ndc11 !== ndc11 || n.on > on) continue;
    if (!best || n.on > best.on) best = n;
  }
  return best;
}

function cheaperAlternative(alts: Alternative[], groupKey: string | null, ndc11: string, belowMicros: number): Alternative | null {
  if (!groupKey) return null;
  let pick: Alternative | null = null;
  for (const a of alts) {
    if (a.groupKey !== groupKey || a.ndc11 === ndc11 || a.effectiveUnitMicros >= belowMicros) continue;
    if (!pick || a.effectiveUnitMicros < pick.effectiveUnitMicros) pick = a;
  }
  return pick;
}

/**
 * The rows: what a rise costs on this pharmacy's units, and what a NADAC fall under cost costs on
 * the units paid at NADAC. Each names the two points it was measured between.
 */
export function priceAlerts(input: PriceMovesInput): PriceMoves {
  const { history, usage } = input;
  const nadac = input.nadac ?? [];
  const alts = input.alternatives ?? [];
  const minMonthly = input.minMonthlyCents ?? 500;
  const minRise = input.minRisePercent ?? 1;
  const rows: MoneyRow[] = [];
  const quiet: PriceMoves["quiet"] = [];
  const use = new Map(usage.map((u) => [u.ndc11, u]));

  // Every day on which something changed for an NDC, latest first, so a transition is judged
  // between the state after the latest change and the state before it.
  const days = new Map<string, Set<string>>();
  for (const p of history) days.set(p.ndc11, (days.get(p.ndc11) ?? new Set()).add(p.on));
  for (const n of nadac) days.set(n.ndc11, (days.get(n.ndc11) ?? new Set()).add(n.on));

  for (const [ndc11, set] of days) {
    const u = use.get(ndc11);
    if (!u || u.unitsPerDay <= 0) continue;
    const sorted = [...set].sort();
    if (sorted.length < 2) continue;
    const now = sorted[sorted.length - 1];
    const before = sorted[sorted.length - 2];
    const costNow = bestAsOf(history, ndc11, now);
    const costBefore = bestAsOf(history, ndc11, before);
    const nadacNow = nadacAsOf(nadac, ndc11, now);
    const nadacBefore = nadacAsOf(nadac, ndc11, before);
    const label = u.name ?? ndc11;

    /*
     * A rise in what the pharmacy would pay: the cheapest source after against the cheapest
     * before. A rise at one supplier while another still lists the old price costs nothing and
     * is not a row.
     */
    if (costNow && costBefore && eff(costNow) > eff(costBefore)) {
      const delta = eff(costNow) - eff(costBefore);
      const percent = (delta / eff(costBefore)) * 100;
      const monthly = Math.round((delta * u.unitsPerDay * DAYS) / 10_000);
      if (percent < minRise) quiet.push({ ndc11, says: `${label}: up ${percent.toFixed(2)}% at ${costNow.supplier}, under the ${minRise}% line.` });
      else if (monthly < minMonthly) quiet.push({ ndc11, says: `${label}: up ${perUnit(delta)} a unit at ${costNow.supplier}, ${money(monthly)} a month on ${u.unitsPerDay.toFixed(1)} units a day.` });
      else {
        const alt = cheaperAlternative(alts, u.groupKey, ndc11, eff(costNow));
        const altSaving = alt ? Math.round(((eff(costNow) - alt.effectiveUnitMicros) * u.unitsPerDay * DAYS) / 10_000) : 0;
        rows.push({
          key: `price-up:${ndc11}`,
          says: `${label} costs ${money(monthly)} a month more: the cheapest source is ${costNow.supplier} at ${perUnit(eff(costNow))} a unit from ${now}, against ${perUnit(eff(costBefore))} at ${costBefore.supplier} on ${before}.`,
          todo: alt
            ? `Buy ${alt.name ?? alt.ndc11} from ${alt.supplier} at ${perUnit(alt.effectiveUnitMicros)} instead: ${money(altSaving)} a month back.`
            : `No cheaper NDC of this product is on file. Check the other catalogues for it, and whether the plans still pay over the new cost.`,
          amountCents: monthly,
          cadence: "recurring_monthly",
          confidence: "likely",
          basis: `Catalogue prices on ${before} and ${now}; ${u.unitsPerDay.toFixed(1)} units a day from the claims; ${DAYS} days.`,
          href: "/purchasing",
          overlapsWith: ["switch-supplier", "switch-ndc"],
        });
      }
    }

    /*
     * NADAC now under cost where it was not: the fills on floor plans are paid under what the
     * drug cost from the next remittance on.
     */
    if (costNow && nadacNow) {
      const underNow = nadacNow.unitMicros < eff(costNow);
      const underBefore = costBefore && nadacBefore ? nadacBefore.unitMicros < eff(costBefore) : false;
      if (underNow && !underBefore) {
        const gap = eff(costNow) - nadacNow.unitMicros;
        const share = u.floorShare ?? 1;
        const monthly = Math.round((gap * u.unitsPerDay * share * DAYS) / 10_000);
        if (monthly < minMonthly) quiet.push({ ndc11, says: `${label}: NADAC ${perUnit(nadacNow.unitMicros)} is now under cost ${perUnit(eff(costNow))}, ${money(monthly)} a month.` });
        else {
          const alt = cheaperAlternative(alts, u.groupKey, ndc11, nadacNow.unitMicros);
          const cause = nadacBefore && nadacBefore.unitMicros !== nadacNow.unitMicros
            ? `NADAC fell to ${perUnit(nadacNow.unitMicros)} on ${nadacNow.on} from ${perUnit(nadacBefore.unitMicros)}`
            : `the cost rose to ${perUnit(eff(costNow))} at ${costNow.supplier} on ${costNow.on}`;
          rows.push({
            key: `under-cost:${ndc11}`,
            says: `${label} is now paid under cost on the floor plans: ${cause}, against a cost of ${perUnit(eff(costNow))}. ${money(monthly)} a month${u.floorShare === null ? " if every unit is paid at NADAC" : ""}.`,
            todo: alt
              ? `Switch to ${alt.name ?? alt.ndc11} from ${alt.supplier} at ${perUnit(alt.effectiveUnitMicros)}, which is under the new NADAC.`
              : `No NDC of this product is under the new NADAC. Stop stocking it for floor-plan fills, or appeal the MAC with the invoice.`,
            amountCents: monthly,
            cadence: "recurring_monthly",
            confidence: u.floorShare === null ? "worth checking" : "likely",
            basis: u.floorShare === null
              ? `Cost ${perUnit(eff(costNow))} less NADAC ${perUnit(nadacNow.unitMicros)} on ${u.unitsPerDay.toFixed(1)} units a day, all of them, because the plans are not yet classified; ${DAYS} days.`
              : `Cost ${perUnit(eff(costNow))} less NADAC ${perUnit(nadacNow.unitMicros)} on ${(u.unitsPerDay * share).toFixed(1)} of ${u.unitsPerDay.toFixed(1)} units a day that are paid at NADAC; ${DAYS} days.`,
            href: "/purchasing",
            overlapsWith: ["switch-ndc", "dispensed-at-a-loss", `price-up:${ndc11}`],
          });
        }
      }
    }
  }

  rows.sort((a, b) => b.amountCents - a.amountCents);
  return { rows, quiet };
}
