/**
 * Lean stock: what to hold, what to order, and what to send back, and when.
 *
 * The owner's target is one to two days of stock. That is a number per product, not a policy, and
 * it comes from three things the site holds or can hold: how fast the product goes out (units a
 * day, from the claims), how long an order takes to arrive (per supplier), and what is on the
 * shelf today (the on-hand upload). Everything here is arithmetic on those three.
 *
 * ── Usage ──
 *
 * Units a day is the live claims over a window, divided by the days in the window. Reversals are
 * out; a fill billed to two payers is one bottle (fills.ts), so quantity is taken once. A product
 * dispensed twice in ninety days has a usage, but not one to order against: `sparse` says so and
 * the target for it is "order when prescribed", not a shelf quantity.
 *
 * ── Target ──
 *
 *     target units = usage per day × (lead time days + review days) + safety days × usage per day
 *
 * Lead time is the supplier's (McKesson next day; a secondary two or three); review days is how
 * often an order goes in (daily is one); safety is the owner's cushion, one day by default. A
 * product that must be on the shelf when asked for (the owner's list) gets a floor of one pack.
 *
 * ── Order quantity ──
 *
 * What brings the shelf back to target, rounded up to the pack, less what is already on order.
 * Zero when the shelf covers the target.
 *
 * ── What to send back, and when ──
 *
 * Excess is on hand less target less what will be dispensed before the credit changes. The
 * return policy gives steps (100% to day 30, 75% after); the best day to return is the last day
 * of the highest credit step on which the excess still exists. If usage will eat the excess
 * before the credit drops, nothing goes back; if not, it goes back before the drop, and the
 * sentence says the day. No policy on file means no return is proposed: a return raised outside
 * a window the site invented is a return refused.
 *
 * Pure.
 */

export type Usage = {
  ndc11: string;
  unitsPerDay: number;
  /** Fills in the window, so a usage built on two fills is not ordered against. */
  fills: number;
  windowDays: number;
  sparse: boolean;
};

/** Units a day per NDC over the claims, reversals out, quantity taken once per fill. */
export function usageFromFills(
  fills: { ndc11: string | null; quantityThousandths: number | null; dateFilled: string }[],
  windowDays: number,
  opts: { minFills?: number } = {},
): Map<string, Usage> {
  const minFills = opts.minFills ?? 3;
  const acc = new Map<string, { units: number; fills: number }>();
  for (const f of fills) {
    if (!f.ndc11 || !f.quantityThousandths || f.quantityThousandths <= 0) continue;
    const a = acc.get(f.ndc11) ?? { units: 0, fills: 0 };
    a.units += f.quantityThousandths / 1000;
    a.fills++;
    acc.set(f.ndc11, a);
  }
  const out = new Map<string, Usage>();
  for (const [ndc, a] of acc) out.set(ndc, { ndc11: ndc, unitsPerDay: windowDays > 0 ? a.units / windowDays : 0, fills: a.fills, windowDays, sparse: a.fills < minFills });
  return out;
}

export type StockPolicy = {
  leadTimeDays: number;
  reviewDays: number;
  safetyDays: number;
};

export type StockLine = {
  ndc11: string;
  name: string | null;
  onHandUnits: number;
  onOrderUnits: number;
  packUnits: number;
  usage: Usage | null;
  /** True where the owner wants at least one pack on the shelf regardless of usage. */
  mustStock?: boolean;
};

export type StockAdvice = {
  ndc11: string;
  name: string | null;
  unitsPerDay: number | null;
  daysOnHand: number | null;
  targetUnits: number;
  orderUnits: number;
  orderPacks: number;
  excessUnits: number;
  kind: "order" | "hold" | "excess" | "order when prescribed" | "no usage";
  says: string;
};

/** The target, the order and the excess for one line under one policy. */
export function adviseStock(line: StockLine, policy: StockPolicy): StockAdvice {
  const u = line.usage;
  const pack = Math.max(1, line.packUnits);
  if (!u || u.unitsPerDay <= 0) {
    const kind = line.onHandUnits > 0 ? "excess" : "no usage";
    return { ndc11: line.ndc11, name: line.name, unitsPerDay: null, daysOnHand: null, targetUnits: line.mustStock ? pack : 0, orderUnits: 0, orderPacks: 0, excessUnits: line.mustStock ? Math.max(0, line.onHandUnits - pack) : line.onHandUnits, kind, says: kind === "excess" ? `${line.name ?? line.ndc11}: ${line.onHandUnits} on hand and nothing dispensed in ${u?.windowDays ?? "the"} days.` : `${line.name ?? line.ndc11}: nothing on hand, nothing dispensed.` };
  }
  if (u.sparse && !line.mustStock) {
    return { ndc11: line.ndc11, name: line.name, unitsPerDay: u.unitsPerDay, daysOnHand: line.onHandUnits / u.unitsPerDay, targetUnits: 0, orderUnits: 0, orderPacks: 0, excessUnits: line.onHandUnits, kind: "order when prescribed", says: `${line.name ?? line.ndc11}: ${u.fills} fill${u.fills === 1 ? "" : "s"} in ${u.windowDays} days. Order when prescribed rather than shelve it.` };
  }
  const cover = policy.leadTimeDays + policy.reviewDays + policy.safetyDays;
  let target = u.unitsPerDay * cover;
  if (line.mustStock) target = Math.max(target, pack);
  const shortfall = target - line.onHandUnits - line.onOrderUnits;
  const orderPacks = shortfall > 0 ? Math.ceil(shortfall / pack) : 0;
  const orderUnits = orderPacks * pack;
  const excessUnits = Math.max(0, line.onHandUnits - target);
  const daysOnHand = line.onHandUnits / u.unitsPerDay;
  const kind: StockAdvice["kind"] = orderPacks > 0 ? "order" : excessUnits >= pack ? "excess" : "hold";
  const says =
    kind === "order"
      ? `${line.name ?? line.ndc11}: ${daysOnHand.toFixed(1)} days on hand at ${u.unitsPerDay.toFixed(1)} a day; ${cover} days of cover needs ${Math.ceil(target)}. Order ${orderPacks} pack${orderPacks === 1 ? "" : "s"} (${orderUnits}).`
      : kind === "excess"
        ? `${line.name ?? line.ndc11}: ${daysOnHand.toFixed(1)} days on hand against ${cover} days of cover: ${Math.floor(excessUnits)} units over.`
        : `${line.name ?? line.ndc11}: ${daysOnHand.toFixed(1)} days on hand; hold.`;
  return { ndc11: line.ndc11, name: line.name, unitsPerDay: u.unitsPerDay, daysOnHand, targetUnits: target, orderUnits, orderPacks, excessUnits, kind, says };
}

export type CreditStep = { fromDay: number; percent: number };

export type ReturnTiming = {
  ndc11: string;
  /** Units that will still be excess on the best day. */
  unitsToReturn: number;
  /** The day (days from the invoice) to raise it by, and the credit then. */
  byDay: number;
  byDate: string;
  creditPercent: number;
  creditCents: number;
  /** What waiting past that day would cost. */
  nextPercent: number | null;
  says: string;
};

const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86_400_000).toISOString().slice(0, 10);

/**
 * When to send the excess back.
 *
 * Steps are the supplier's credit schedule from the invoice date, descending. For each step, the
 * excess that will remain on its last day is on hand less target less usage until then; the first
 * step (highest credit) on which that excess is at least a pack is the answer, raised on its last
 * day so that every unit that can be dispensed at full margin first is. `today` is days since the
 * invoice; a step already past is skipped.
 */
export function returnTiming(
  line: { ndc11: string; onHandUnits: number; targetUnits: number; unitsPerDay: number; packUnits: number; unitCostCents: number; invoiceDate: string; today: string },
  steps: CreditStep[],
  closesAtDay: number | null,
): ReturnTiming | null {
  const sorted = [...steps].sort((a, b) => a.fromDay - b.fromDay);
  if (sorted.length === 0) return null;
  const todayDay = Math.round((Date.parse(line.today) - Date.parse(line.invoiceDate)) / 86_400_000);
  for (let i = 0; i < sorted.length; i++) {
    const step = sorted[i];
    const next = sorted[i + 1] ?? null;
    const lastDay = next ? next.fromDay - 1 : closesAtDay !== null ? closesAtDay - 1 : todayDay;
    if (lastDay < todayDay) continue;
    const excessThen = line.onHandUnits - line.targetUnits - line.unitsPerDay * Math.max(0, lastDay - todayDay);
    const units = Math.floor(excessThen / Math.max(1, line.packUnits)) * Math.max(1, line.packUnits);
    if (units < Math.max(1, line.packUnits)) continue;
    const creditCents = Math.round(units * line.unitCostCents * (step.percent / 100));
    const byDate = addDays(line.invoiceDate, lastDay);
    return {
      ndc11: line.ndc11,
      unitsToReturn: units,
      byDay: lastDay,
      byDate,
      creditPercent: step.percent,
      creditCents,
      nextPercent: next ? next.percent : null,
      says: `Return ${units} by ${byDate} at ${step.percent}% (${(creditCents / 100).toFixed(2)} dollars)${next ? `; after that it is ${next.percent}%` : closesAtDay !== null ? "; after that nothing" : ""}. Usage until then is covered.`,
    };
  }
  return null;
}
