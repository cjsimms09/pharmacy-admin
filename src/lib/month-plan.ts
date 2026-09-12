/**
 * The month's purchasing, decided with every variable at once.
 *
 * The decisions are coupled, and each of the simpler modules holds one of them still while it
 * solves the others. The buy list ranks NDCs at a fixed rebate rate; the rate depends on the band;
 * the band depends on where every generic and brand is bought; where a line is bought depends on
 * its effective price, which depends on the rate. The secondary's minimum pulls generics away from
 * McKesson, which lowers the ratio and shrinks the OneStop base. Which NDC of a product pays most
 * depends on which plans dispense it. Solved one at a time these give answers that are each right
 * and together wrong.
 *
 * ── How it is solved together ──
 *
 * The band is the only thing that couples the lines, and there are few bands. So:
 *
 *   for every band the pharmacy could land in this month (GCR band × GPR band):
 *     1. fix the rates that band pays: the OneStop generic rate, the GPR rate, the brand factor;
 *     2. for every product, for every NDC and supplier offer, the effective cost per unit at
 *        those rates and the expected reimbursement per unit on the product's plan mix
 *        (floor plans at NADAC, NADAC-tracking plans at their ratio, flat plans at what they pay,
 *        unknown plans left out and counted); choose the NDC and supplier with the best margin on
 *        the units to buy, and the quantity from the lean target less what is on hand;
 *     3. add those purchases to the month's position; if the ratio lands below the band, repair
 *        it with the cheapest real moves (a generic line from a secondary back to McKesson, a
 *        brand line from McKesson to a secondary), each priced at its own line's cost
 *        difference, until it does or the moves run out; landing above is fine, and the higher
 *        band is judged in its own turn;
 *     4. for every secondary under its minimum, either pull fast movers forward within the days
 *        cap (priced at the line's own saving and its ratio effect) or send its lines back to
 *        McKesson, whichever costs less;
 *     5. total the month: reimbursement less gross cost, plus the rebates the band actually pays
 *        on the actual OneStop base and brand base — once, at the end, never inside a line;
 *   take the band with the largest total.
 *
 * Every figure in the result names the band it assumed, so a person can see why a generic is at
 * McKesson this month and at IPC the next. Where an input is missing the plan says what it could
 * not do rather than guessing: no on-hand means quantities are usage alone; no minimum on file
 * means the secondary has none; unknown plans are units the reimbursement cannot price.
 *
 * Pure.
 */

import type { PayBasis } from "./pay-basis";
import { bandAt, type Band } from "./ratio-effect";

export type Offer = {
  supplier: string;
  /** Gross price per unit, in micros. */
  grossMicros: number;
  /** What the line earns at this supplier: OneStop generic, brand (the brand factor), or nothing. */
  earns: "onestop" | "brand" | "none";
  /** Whether the supplier's return policy would take it back, for pull-forward decisions. */
  returnable: boolean;
  /** Excluded from the ratio (flu, drop-ship, McKesson's scrub). */
  excluded?: boolean;
};

export type NdcOption = {
  ndc11: string;
  classification: "B" | "G";
  nadacMicros: number | null;
  packUnits: number;
  offers: Offer[];
};

export type PlanShare = { planKey: string; units: number; basis: PayBasis | "floor"; ratioToNadac: number | null; paidPerUnitMicros: number | null };

export type Product = {
  key: string;
  name: string | null;
  ndcs: NdcOption[];
  /** Units the month will dispense, from usage. */
  demandUnits: number;
  onHandUnits: number;
  /** Units a day, for pull-forward days. */
  unitsPerDay: number;
  mix: PlanShare[];
};

export type Ladder = {
  gcr: Band[];
  /** Measured by OS/Gx. Rate on OneStop. */
  gpr: Band[];
  /** Measured by GCR. Rate on brand purchases at the primary. */
  brand: Band[];
};

export type MonthPosition = {
  /** Purchases at the primary so far this month, in cents, on the scrubbed basis. */
  genericCents: number;
  brandCents: number;
  oneStopCents: number;
  totalGenericCents: number;
};

export type Supplier = { name: string; primary: boolean; minimumCents: number };

export type MonthPlanInput = {
  products: Product[];
  ladder: Ladder;
  position: MonthPosition;
  suppliers: Supplier[];
  maxPullForwardDays?: number;
};

export type LinePlan = {
  product: string;
  name: string | null;
  ndc11: string;
  supplier: string;
  units: number;
  grossCents: number;
  effectiveCents: number;
  reimbursementCents: number;
  /** Share of the product's units the reimbursement could price. */
  pricedShare: number;
  earns: Offer["earns"];
  classification: "B" | "G";
  note: string | null;
};

export type BandOutcome = {
  gcrBand: Band | null;
  gprBand: Band | null;
  feasible: boolean;
  lines: LinePlan[];
  moves: string[];
  gcrPercent: number;
  osGxPercent: number;
  reimbursementCents: number;
  grossCostCents: number;
  rebateCents: number;
  repairCostCents: number;
  totalCents: number;
  says: string;
};

export type MonthPlan = {
  best: BandOutcome | null;
  outcomes: BandOutcome[];
  blocked: string[];
  says: string;
};

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rate = (b: Band | null) => (b ? b.rebatePercent / 100 : 0);

function expectedPaidMicros(ndc: NdcOption, mix: PlanShare[]): { micros: number; pricedShare: number } {
  const total = mix.reduce((s, p) => s + p.units, 0);
  let priced = 0;
  let sum = 0;
  for (const p of mix) {
    let e: number | null = null;
    if (p.basis === "floor" || p.basis === "nadac_tracking") {
      const r = p.basis === "floor" ? 1 : p.ratioToNadac;
      if (ndc.nadacMicros !== null && r !== null) e = ndc.nadacMicros * r;
    } else if (p.basis === "flat_per_product") e = p.paidPerUnitMicros;
    if (e === null) continue;
    priced += p.units;
    sum += e * p.units;
  }
  return { micros: priced > 0 ? sum / priced : 0, pricedShare: total > 0 ? priced / total : 0 };
}

function effectiveMicros(o: Offer, primary: string, rates: { onestop: number; brand: number }): number {
  if (o.supplier !== primary) return o.grossMicros;
  if (o.earns === "onestop") return Math.round(o.grossMicros * (1 - rates.onestop));
  if (o.earns === "brand") return Math.round(o.grossMicros * (1 - rates.brand));
  return o.grossMicros;
}

/** The month's purchasing under one assumed band pair. */
export function planAtBand(input: MonthPlanInput, gcrBand: Band, gprBand: Band | null): BandOutcome {
  const primary = input.suppliers.find((s) => s.primary)?.name ?? "McKesson";
  const brandBand = bandAt(input.ladder.brand, gcrBand.thresholdPercent);
  const rates = { onestop: rate(gcrBand) + rate(gprBand), brand: rate(brandBand) };
  const maxDays = input.maxPullForwardDays ?? 7;
  const lines: LinePlan[] = [];
  const moves: string[] = [];

  // 1–2. Per product: best NDC and supplier at these rates, on the plan mix.
  for (const p of input.products) {
    const units = Math.max(0, p.demandUnits - p.onHandUnits);
    if (units <= 0) continue;
    let best: LinePlan | null = null;
    for (const n of p.ndcs) {
      const paid = expectedPaidMicros(n, p.mix);
      if (paid.pricedShare < 0.5) continue;
      for (const o of n.offers) {
        const eff = effectiveMicros(o, primary, rates);
        const buyUnits = Math.ceil(units / Math.max(1, n.packUnits)) * Math.max(1, n.packUnits);
        const line: LinePlan = {
          product: p.key, name: p.name, ndc11: n.ndc11, supplier: o.supplier, units: buyUnits,
          grossCents: Math.round((o.grossMicros * buyUnits) / 10_000), effectiveCents: Math.round((eff * buyUnits) / 10_000),
          reimbursementCents: Math.round((paid.micros * units) / 10_000), pricedShare: paid.pricedShare, earns: o.earns, classification: n.classification, note: null,
        };
        const margin = line.reimbursementCents - line.effectiveCents;
        if (!best || margin > best.reimbursementCents - best.effectiveCents) best = line;
      }
    }
    if (best) lines.push(best);
  }

  // The ratio after these purchases, on the scrubbed basis.
  const tally = () => {
    let G = input.position.genericCents;
    let D = input.position.genericCents + input.position.brandCents;
    let O = input.position.oneStopCents;
    let TG = input.position.totalGenericCents;
    let brandAtPrimary = input.position.brandCents;
    for (const l of lines) {
      const offer = offerOf(input, l);
      if (l.supplier !== primary || offer?.excluded) continue;
      if (l.classification === "G") { G += l.grossCents; D += l.grossCents; TG += l.grossCents; if (l.earns === "onestop") O += l.grossCents; }
      else { D += l.grossCents; brandAtPrimary += l.grossCents; }
    }
    return { G, D, O, TG, brandAtPrimary, gcr: D > 0 ? (G / D) * 100 : 0, osgx: TG > 0 ? (O / TG) * 100 : 0 };
  };

  // 3. Repair the ratio into the band with the cheapest real moves.
  let repairCost = 0;
  // Landing at or above the assumed band is fine: the rates assumed were paid at least. Landing
  // below is not, and is repaired upward; a higher band is judged in its own iteration.
  const inBand = (t: ReturnType<typeof tally>) =>
    (bandAt(input.ladder.gcr, t.gcr)?.thresholdPercent ?? -1) >= gcrBand.thresholdPercent &&
    (gprBand === null || (bandAt(input.ladder.gpr, t.osgx)?.thresholdPercent ?? -1) >= gprBand.thresholdPercent);
  let t = tally();
  let guard = 0;
  while (!inBand(t) && guard++ < 200) {
    const needUp = true;
    // Candidate moves: a generic at a secondary → primary (raises); a brand at primary → secondary (raises);
    // and the reverse pair when the ratio has overshot into a higher band than assumed (lowers).
    let bestMove: { line: LinePlan; to: Offer; cost: number; delta: number } | null = null;
    for (const l of lines) {
      const p = input.products.find((x) => x.key === l.product)!;
      const n = p.ndcs.find((x) => x.ndc11 === l.ndc11)!;
      for (const o of n.offers) {
        if (o.supplier === l.supplier) continue;
        const raises = (l.classification === "G" && o.supplier === primary && l.supplier !== primary) || (l.classification === "B" && l.supplier === primary && o.supplier !== primary);
        if (raises !== needUp) continue;
        const effNew = Math.round((effectiveMicros(o, primary, rates) * l.units) / 10_000);
        const cost = effNew - l.effectiveCents;
        const delta = Math.abs(l.grossCents);
        const perPoint = cost / Math.max(delta, 1);
        if (!bestMove || perPoint < bestMove.cost / Math.max(bestMove.delta, 1)) bestMove = { line: l, to: o, cost, delta };
      }
    }
    if (!bestMove) break;
    const l = bestMove.line;
    moves.push(`${l.name ?? l.ndc11}: ${l.supplier} → ${bestMove.to.supplier} to ${needUp ? "reach" : "stay in"} the ${gcrBand.thresholdPercent}% band (${bestMove.cost >= 0 ? "costs" : "saves"} ${money(bestMove.cost)})`);
    repairCost += bestMove.cost;
    l.supplier = bestMove.to.supplier;
    l.earns = bestMove.to.earns;
    l.grossCents = Math.round((bestMove.to.grossMicros * l.units) / 10_000);
    l.effectiveCents = Math.round((effectiveMicros(bestMove.to, primary, rates) * l.units) / 10_000);
    t = tally();
  }
  const feasible = inBand(t);

  // 4. Secondary minimums: pull forward within the cap, or send the supplier's lines back to the primary.
  for (const s of input.suppliers) {
    if (s.primary || s.minimumCents <= 0) continue;
    const spend = () => lines.filter((l) => l.supplier === s.name).reduce((n, l) => n + l.grossCents, 0);
    if (spend() === 0 || spend() >= s.minimumCents) continue;
    // Option A: pull forward the fastest movers cheaper at s, within maxDays, priced at their saving (negative cost) plus nothing for the ratio if generic (they were leaving the primary anyway only if chosen there; a pull-forward is extra stock, not a move).
    const candidates: { p: Product; n: NdcOption; o: Offer; saving: number; days: number }[] = [];
    for (const p of input.products) {
      for (const n of p.ndcs) {
        const o = n.offers.find((x) => x.supplier === s.name);
        const pr = n.offers.find((x) => x.supplier === primary);
        if (!o || !pr || !o.returnable || p.unitsPerDay <= 0) continue;
        const saving = effectiveMicros(pr, primary, rates) - effectiveMicros(o, primary, rates);
        if (saving <= 0) continue;
        const already = lines.filter((l) => l.product === p.key).reduce((u, l) => u + l.units, 0);
        const days = (p.onHandUnits + already + n.packUnits) / p.unitsPerDay;
        if (days <= maxDays) candidates.push({ p, n, o, saving, days });
      }
    }
    candidates.sort((a, b) => a.days - b.days);
    let pulled = 0;
    let pulledSaving = 0;
    const pulledLines: LinePlan[] = [];
    for (const c of candidates) {
      while (spend() + pulled < s.minimumCents) {
        const packCents = Math.round((c.o.grossMicros * c.n.packUnits) / 10_000);
        pulled += packCents;
        pulledSaving += Math.round((c.saving * c.n.packUnits) / 10_000);
        // Pulled-forward stock is dispensed later at the same expected reimbursement; it is bought now.
        const paidMicros = expectedPaidMicros(c.n, c.p.mix).micros;
        const reimb = Math.round((paidMicros * c.n.packUnits) / 10_000);
        const existing = pulledLines.find((l) => l.ndc11 === c.n.ndc11);
        if (existing) { existing.units += c.n.packUnits; existing.grossCents += packCents; existing.effectiveCents += packCents; existing.reimbursementCents += reimb; }
        else pulledLines.push({ product: c.p.key, name: c.p.name, ndc11: c.n.ndc11, supplier: s.name, units: c.n.packUnits, grossCents: packCents, effectiveCents: packCents, reimbursementCents: reimb, pricedShare: 1, earns: c.o.earns, classification: c.n.classification, note: `pulled forward to meet ${s.name}'s minimum` });
        const already = lines.filter((l) => l.product === c.p.key).reduce((u, l) => u + l.units, 0) + (existing?.units ?? c.n.packUnits);
        if ((c.p.onHandUnits + already + c.n.packUnits) / c.p.unitsPerDay > maxDays) break;
      }
      if (spend() + pulled >= s.minimumCents) break;
    }
    const optionA = spend() + pulled >= s.minimumCents ? -pulledSaving : null; // negative: it saves
    // Option B: send this supplier's lines to the primary at the effective cost difference.
    let optionB = 0;
    const movedBack: { l: LinePlan; to: Offer }[] = [];
    for (const l of lines.filter((x) => x.supplier === s.name)) {
      const p = input.products.find((x) => x.key === l.product)!;
      const n = p.ndcs.find((x) => x.ndc11 === l.ndc11)!;
      const pr = n.offers.find((x) => x.supplier === primary);
      if (!pr) { optionB = Number.POSITIVE_INFINITY; break; }
      optionB += Math.round((effectiveMicros(pr, primary, rates) * l.units) / 10_000) - l.effectiveCents;
      movedBack.push({ l, to: pr });
    }
    if (optionA !== null && optionA <= optionB) {
      lines.push(...pulledLines);
      moves.push(`${s.name}: ${money(spend())} against a ${money(s.minimumCents)} minimum; pulled forward ${pulledLines.length} line${pulledLines.length === 1 ? "" : "s"} within ${maxDays} days of stock, saving ${money(pulledSaving)}`);
    } else if (Number.isFinite(optionB)) {
      for (const m of movedBack) { m.l.supplier = primary; m.l.earns = m.to.earns; m.l.grossCents = Math.round((m.to.grossMicros * m.l.units) / 10_000); m.l.effectiveCents = Math.round((effectiveMicros(m.to, primary, rates) * m.l.units) / 10_000); }
      repairCost += optionB;
      moves.push(`${s.name}: its ${money(s.minimumCents)} minimum could not be met inside ${maxDays} days of stock; ${movedBack.length} line${movedBack.length === 1 ? "" : "s"} sent back to ${primary} (costs ${money(optionB)})`);
    }
  }

  // 5. Total the month, rebates once, on the actual bases.
  const final = tally();
  const gcrLanded = bandAt(input.ladder.gcr, final.gcr);
  const gprLanded = bandAt(input.ladder.gpr, final.osgx);
  const brandLanded = bandAt(input.ladder.brand, final.gcr);
  const reimbursementCents = lines.reduce((n, l) => n + l.reimbursementCents, 0);
  const grossCostCents = lines.reduce((n, l) => n + l.grossCents, 0);
  const rebateCents = Math.round(final.O * (rate(gcrLanded) + rate(gprLanded)) + final.brandAtPrimary * rate(brandLanded));
  const totalCents = reimbursementCents - grossCostCents + rebateCents;
  const says = feasible
    ? `At the ${gcrLanded?.thresholdPercent ?? 0}% band: ${lines.length} lines, ${money(grossCostCents)} bought, ${money(rebateCents)} rebate on ${money(final.O)} of contract generics, ${money(totalCents)} month margin${moves.length ? `; ${moves.length} move${moves.length === 1 ? "" : "s"} to get there` : ""}.`
    : `The ${gcrBand.thresholdPercent}% band cannot be reached this month with the lines available to move.`;
  return { gcrBand: gcrLanded, gprBand: gprLanded, feasible, lines, moves, gcrPercent: final.gcr, osGxPercent: final.osgx, reimbursementCents, grossCostCents, rebateCents, repairCostCents: repairCost, totalCents, says };
}

function offerOf(input: MonthPlanInput, l: LinePlan): Offer | undefined {
  return input.products.find((p) => p.key === l.product)?.ndcs.find((n) => n.ndc11 === l.ndc11)?.offers.find((o) => o.supplier === l.supplier);
}

/** Every band the month could land in, solved, and the best taken. */
export function monthPlan(input: MonthPlanInput): MonthPlan {
  const blocked: string[] = [];
  const unpriced = input.products.filter((p) => p.mix.length > 0 && expectedPaidMicros(p.ndcs[0], p.mix).pricedShare < 0.5);
  if (unpriced.length) blocked.push(`${unpriced.length} product${unpriced.length === 1 ? "" : "s"} left out: fewer than half their units are on plans whose pricing basis is known.`);
  if (input.products.every((p) => p.onHandUnits === 0)) blocked.push("No on-hand quantities: every line is sized from usage alone, as if the shelf were empty.");
  const gcrBands = [...input.ladder.gcr].sort((a, b) => a.thresholdPercent - b.thresholdPercent);
  const gprBands = input.ladder.gpr.length ? [...input.ladder.gpr].sort((a, b) => a.thresholdPercent - b.thresholdPercent) : [null];
  const outcomes: BandOutcome[] = [];
  for (const g of gcrBands) for (const q of gprBands) outcomes.push(planAtBand(structuredClone(input), g, q));
  const feasible = outcomes.filter((o) => o.feasible).sort((a, b) => b.totalCents - a.totalCents);
  const best = feasible[0] ?? null;
  // Two assumptions that produce the same lines are one plan; the next best is the first that differs.
  const nextBest = best ? feasible.find((o) => o.totalCents < best.totalCents || o.gcrBand?.thresholdPercent !== best.gcrBand?.thresholdPercent) ?? null : null;
  const says = best
    ? `${best.says}${nextBest ? ` The next best band (${nextBest.gcrBand?.thresholdPercent ?? 0}%) would have made ${money(nextBest.totalCents)}.` : ""}`
    : "No band is reachable with the lines available; buy each line where its effective cost is lowest.";
  return { best, outcomes, blocked, says };
}
