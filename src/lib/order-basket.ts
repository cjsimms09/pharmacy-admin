/**
 * Meeting a secondary supplier's order minimum without over-stocking.
 *
 * The secondary is cheaper on some lines, but will not ship under a minimum, and the lines that
 * are cheaper there do not add up to it. The game pharmacies play is to pull forward stock of
 * something they use a lot to fill the order. Done by feel it fills the shelf with the wrong
 * thing. Done by arithmetic it is a small optimisation:
 *
 *   choose lines for the secondary that
 *     maximise   saving  =  Σ (primary effective − secondary effective) × units
 *     subject to Σ secondary cost ≥ the minimum
 *     and each line's pull-forward ≤ the days of cover the owner allows.
 *
 * A line is a candidate only where the secondary is cheaper after the rebate the primary line
 * would earn (`effective`, product-ledger.ts), because a line moved at a loss to fill an order is
 * not a saving, it is the minimum bought with margin. Lines in the order already (needed today)
 * go first; then the fastest-moving cheaper lines are pulled forward one pack at a time, cheapest
 * pull-forward first, until the minimum is met. Pull-forward cost is the days of stock it adds:
 * a pack of a product that goes out ten a day is one day, a pack of one-a-week is months, and the
 * cap keeps the shelf lean. If the minimum cannot be met inside the cap the answer is to buy from
 * the primary this time, and it says what was short.
 *
 * Pure.
 */

export type BasketLine = {
  ndc11: string;
  name: string | null;
  /** Units the shelf needs today, from lean-stock.ts. Zero for a pure pull-forward candidate. */
  neededUnits: number;
  packUnits: number;
  unitsPerDay: number;
  /** On hand plus on order, so pull-forward days are counted from what is already there. */
  onHandUnits: number;
  /** Effective cost per unit at the primary and the secondary, in micros. Null where not offered. */
  primaryEffectiveMicros: number | null;
  secondaryEffectiveMicros: number | null;
  /** True where the secondary's return policy would take it back: a pull-forward that cannot go back is a bet. */
  returnable: boolean;
};

export type BasketPick = { ndc11: string; name: string | null; packs: number; units: number; secondaryCents: number; savingCents: number; pullForwardDays: number; reason: "needed" | "pulled forward" };

export type Basket = {
  picks: BasketPick[];
  secondaryCents: number;
  minimumCents: number;
  savingCents: number;
  met: boolean;
  /** Lines needed today that stay with the primary because the secondary is dearer or does not offer them. */
  primary: { ndc11: string; name: string | null; units: number; why: string }[];
  says: string;
};

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function buildBasket(lines: BasketLine[], minimumCents: number, opts: { maxPullForwardDays?: number; requireReturnable?: boolean } = {}): Basket {
  const maxDays = opts.maxPullForwardDays ?? 7;
  const requireReturnable = opts.requireReturnable ?? true;
  const picks: BasketPick[] = [];
  const primary: Basket["primary"] = [];
  let secondaryCents = 0;
  let savingCents = 0;

  const cheaperAtSecondary = (l: BasketLine) => l.secondaryEffectiveMicros !== null && l.primaryEffectiveMicros !== null && l.secondaryEffectiveMicros < l.primaryEffectiveMicros;
  const perUnitSaving = (l: BasketLine) => (l.primaryEffectiveMicros ?? 0) - (l.secondaryEffectiveMicros ?? 0);

  // 1. What is needed today goes to whichever is cheaper.
  for (const l of lines) {
    if (l.neededUnits <= 0) continue;
    const packs = Math.ceil(l.neededUnits / Math.max(1, l.packUnits));
    const units = packs * Math.max(1, l.packUnits);
    if (cheaperAtSecondary(l)) {
      const cents = Math.round((l.secondaryEffectiveMicros! * units) / 10_000);
      const saving = Math.round((perUnitSaving(l) * units) / 10_000);
      picks.push({ ndc11: l.ndc11, name: l.name, packs, units, secondaryCents: cents, savingCents: saving, pullForwardDays: 0, reason: "needed" });
      secondaryCents += cents;
      savingCents += saving;
    } else {
      primary.push({ ndc11: l.ndc11, name: l.name, units, why: l.secondaryEffectiveMicros === null ? "not offered by the secondary" : "cheaper at the primary after the rebate" });
    }
  }

  // 2. Pull forward, cheapest days-of-stock first, one pack at a time, until the minimum is met.
  const pulled = new Map<string, number>(); // packs pulled so far
  while (secondaryCents < minimumCents) {
    let best: { l: BasketLine; days: number } | null = null;
    for (const l of lines) {
      if (!cheaperAtSecondary(l) || l.unitsPerDay <= 0) continue;
      if (requireReturnable && !l.returnable) continue;
      const pack = Math.max(1, l.packUnits);
      const already = (picks.find((p) => p.ndc11 === l.ndc11)?.units ?? 0);
      const afterUnits = l.onHandUnits + already + pack;
      const days = afterUnits / l.unitsPerDay;
      if (days > maxDays) continue;
      if (!best || days < best.days) best = { l, days };
    }
    if (!best) break;
    const pack = Math.max(1, best.l.packUnits);
    const cents = Math.round((best.l.secondaryEffectiveMicros! * pack) / 10_000);
    const saving = Math.round((perUnitSaving(best.l) * pack) / 10_000);
    const existing = picks.find((p) => p.ndc11 === best!.l.ndc11 && p.reason === "pulled forward");
    if (existing) { existing.packs++; existing.units += pack; existing.secondaryCents += cents; existing.savingCents += saving; existing.pullForwardDays = best.days; }
    else picks.push({ ndc11: best.l.ndc11, name: best.l.name, packs: 1, units: pack, secondaryCents: cents, savingCents: saving, pullForwardDays: best.days, reason: "pulled forward" });
    pulled.set(best.l.ndc11, (pulled.get(best.l.ndc11) ?? 0) + 1);
    secondaryCents += cents;
    savingCents += saving;
  }

  const met = secondaryCents >= minimumCents;
  const pulledPicks = picks.filter((p) => p.reason === "pulled forward");
  const says = met
    ? `Secondary order ${money(secondaryCents)} against a ${money(minimumCents)} minimum, saving ${money(savingCents)} over the primary${pulledPicks.length ? `; ${pulledPicks.length} line${pulledPicks.length === 1 ? "" : "s"} pulled forward within ${maxDays} days of stock` : ""}.`
    : picks.length
      ? `The secondary's ${money(minimumCents)} minimum cannot be met this order without holding more than ${maxDays} days of anything: ${money(secondaryCents)} is what is cheaper there. Buy from the primary today and try again when more is needed.`
      : `Nothing needed today is cheaper at the secondary. Buy from the primary.`;
  return { picks, secondaryCents, minimumCents, savingCents, met, primary, says };
}
