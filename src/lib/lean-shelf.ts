/**
 * What is on the shelf that should not be, and what it is worth sending back today.
 *
 * The pharmacy wants to hold one to two days of stock and return the rest at the best moment. That
 * is three numbers put together and none of them alone: what is on the shelf (on-hand.ts), how fast
 * it leaves (usage.ts), and what the supplier will still credit for it (returns-due.ts, which runs
 * on the invoice clock rather than the expiry date).
 *
 * Held apart they say nothing useful. "Two hundred tablets on hand" is a good position or a dead
 * write-off depending entirely on whether anything dispenses it. "Ninety days left to return this"
 * is worth knowing only if the bottle is surplus. Together they produce the one sentence worth
 * acting on: *you hold 34 days of this, 32 days of it is surplus, McKesson credits $214 of it in
 * full until Friday and 75% after.*
 *
 * ── Why it is ordered by money and not by days ──
 *
 * A hundred days of stock of a $4 bottle is a rounding error, and three days of stock of a GLP-1
 * is four thousand dollars. Ordering by days of stock puts the cheap junk at the top of the list
 * every morning and buries the one line that matters. Ordering by the credit at risk — what the
 * surplus is worth today, and what falls off it at the next step — puts the pharmacist's attention
 * where the money is.
 *
 * ── The classification, and the one that is not obvious ──
 *
 * "dead" is stock with no movement at all in the window. It is deliberately separated from
 * "overstocked", because they need opposite handling: overstock is a quantity mistake and comes
 * back to the same supplier next week; dead stock is a *stocking* mistake and the only question is
 * whether it can still go back at all. A list that merges them reports the same urgency for both
 * and the dead lines are the ones that quietly expire.
 *
 * ── What it refuses to do ──
 *
 * It never sizes a return from a days-of-stock target alone where no count is held: with no
 * on-hand figure the row says the count is missing, rather than assuming zero (which reads as "buy
 * more") or assuming the invoice quantity (which reads as "send it all back"). And it never
 * invents a return window — where no policy is on file for the supplier, the surplus is reported
 * and the credit is stated as unknown, because a return raised outside a window the site made up
 * is a return refused with the stock still here.
 *
 * Pure.
 */

import { daysOfStock } from "./usage";

export type ShelfInput = {
  onHand: { ndc11: string; description: string | null; quantityThousandths: number; valueCents: number | null }[];
  movement: { ndc11: string; name: string | null; perDayThousandths: number; steady: boolean; lastOn: string | null }[];
  /**
   * The open return windows, keyed by NDC, from returns-due.ts. Absent means either no invoice
   * carries it or the supplier has no policy on file — the row says which is not knowable here.
   */
  returns?: Map<string, {
    supplier: string;
    creditPercentNow: number;
    dropsInDays: number | null;
    dropsToPercent: number | null;
    closesInDays: number | null;
  }>;
  /** Days of stock the pharmacy intends to hold. One to two, here. */
  targetDays: number;
  /** Under this, a surplus is not worth an authorisation. */
  materialityCents: number;
};

export type ShelfRow = {
  ndc11: string;
  name: string | null;
  onHandThousandths: number;
  perDayThousandths: number;
  /** Infinity where nothing moves — which is the finding, not a missing value. */
  daysOfStock: number;
  targetDays: number;
  /** Units held beyond the target, in thousandths. Zero where at or under it. */
  surplusThousandths: number;
  /** What the whole holding is worth, and what the surplus part of it is worth. */
  valueCents: number | null;
  surplusValueCents: number | null;
  state: "out" | "short" | "lean" | "overstocked" | "dead";
  /** The supplier that would take it back, and on what terms. Null where nothing is known. */
  ret: {
    supplier: string;
    creditPercentNow: number;
    creditNowCents: number | null;
    dropsInDays: number | null;
    dropsToPercent: number | null;
    /** What walks out of the door if the authorisation is not raised before the step. */
    atRiskCents: number | null;
    closesInDays: number | null;
  } | null;
  /** The sentence to put in front of a person. */
  says: string;
  urgency: "today" | "this week" | "this month" | "later" | "none";
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const units = (thousandths: number) => Math.round(thousandths / 100) / 10;

/**
 * The state of one line.
 *
 * Separated so the boundaries can be checked directly. "short" is under the target with movement;
 * "out" is nothing on the shelf at all for something that moves, which is a lost sale rather than
 * a lean position and is never reported as good.
 */
export function stateOf(onHandThousandths: number, perDayThousandths: number, targetDays: number): ShelfRow["state"] {
  if (perDayThousandths <= 0) return onHandThousandths > 0 ? "dead" : "out";
  if (onHandThousandths <= 0) return "out";
  const days = onHandThousandths / perDayThousandths;
  if (days < targetDays) return "short";
  if (days <= targetDays * 2) return "lean";
  return "overstocked";
}

export function leanShelf(input: ShelfInput): ShelfRow[] {
  const moveBy = new Map(input.movement.map((m) => [m.ndc11, m]));
  const rows: ShelfRow[] = [];

  for (const h of input.onHand) {
    const m = moveBy.get(h.ndc11);
    const perDay = m?.perDayThousandths ?? 0;
    const state = stateOf(h.quantityThousandths, perDay, input.targetDays);
    if (state === "lean" || state === "short" || state === "out") continue; // Nothing to send back.

    const keep = state === "dead" ? 0 : Math.round(perDay * input.targetDays);
    const surplus = Math.max(0, h.quantityThousandths - keep);
    if (surplus <= 0) continue;

    /*
     * The surplus's share of the holding's value, not a unit price re-derived from somewhere else.
     * The on-hand file already values the line at what this pharmacy's own system says it paid;
     * pricing the surplus off a catalogue would report a credit the supplier is not going to give.
     */
    const surplusValueCents =
      h.valueCents === null || h.quantityThousandths <= 0
        ? null
        : Math.round((h.valueCents * surplus) / h.quantityThousandths);

    const r = input.returns?.get(h.ndc11) ?? null;
    const creditNowCents =
      r && surplusValueCents !== null ? Math.round((surplusValueCents * r.creditPercentNow) / 100) : null;
    const atRiskCents =
      r && creditNowCents !== null && r.dropsToPercent !== null && surplusValueCents !== null
        ? creditNowCents - Math.round((surplusValueCents * r.dropsToPercent) / 100)
        : null;

    const ret = r
      ? {
          supplier: r.supplier,
          creditPercentNow: r.creditPercentNow,
          creditNowCents,
          dropsInDays: r.dropsInDays,
          dropsToPercent: r.dropsToPercent,
          atRiskCents,
          closesInDays: r.closesInDays,
        }
      : null;

    const urgency = urgencyOf({ state, dropsInDays: r?.dropsInDays ?? null, closesInDays: r?.closesInDays ?? null, atRiskCents, materialityCents: input.materialityCents, surplusValueCents });

    rows.push({
      ndc11: h.ndc11,
      name: m?.name ?? h.description ?? null,
      onHandThousandths: h.quantityThousandths,
      perDayThousandths: perDay,
      daysOfStock: daysOfStock(h.quantityThousandths, perDay),
      targetDays: input.targetDays,
      surplusThousandths: surplus,
      valueCents: h.valueCents,
      surplusValueCents,
      state,
      ret,
      says: sentence({ state, name: m?.name ?? h.description ?? h.ndc11, days: daysOfStock(h.quantityThousandths, perDay), targetDays: input.targetDays, surplus, ret, lastOn: m?.lastOn ?? null }),
      urgency,
    });
  }

  /*
   * Money at risk first — the credit that falls at the next step — and then the size of the
   * surplus, so a line with no policy on file still surfaces above a trivial one.
   */
  rows.sort((a, b) => {
    const risk = (r: ShelfRow) => r.ret?.atRiskCents ?? 0;
    if (risk(b) !== risk(a)) return risk(b) - risk(a);
    return (b.surplusValueCents ?? 0) - (a.surplusValueCents ?? 0);
  });
  return rows;
}

export function urgencyOf(a: {
  state: ShelfRow["state"];
  dropsInDays: number | null;
  closesInDays: number | null;
  atRiskCents: number | null;
  surplusValueCents: number | null;
  materialityCents: number;
}): ShelfRow["urgency"] {
  const worth = a.atRiskCents ?? a.surplusValueCents ?? 0;
  if (worth < a.materialityCents) return "none";
  const soonest = [a.dropsInDays, a.closesInDays].filter((d): d is number => d !== null);
  if (soonest.length === 0) return a.state === "dead" ? "this month" : "later";
  const d = Math.min(...soonest);
  if (d <= 1) return "today";
  if (d <= 7) return "this week";
  if (d <= 30) return "this month";
  return "later";
}

function sentence(a: {
  state: ShelfRow["state"];
  name: string;
  days: number;
  targetDays: number;
  surplus: number;
  ret: ShelfRow["ret"];
  lastOn: string | null;
}): string {
  const head =
    a.state === "dead"
      ? `Nothing dispensed in the window${a.lastOn ? ` (last on ${a.lastOn})` : ""}. All ${units(a.surplus)} units are surplus.`
      : `${Math.round(a.days)} days of stock against a ${a.targetDays}-day target — ${units(a.surplus)} units surplus.`;

  if (!a.ret) return `${head} No return window on file for it, so raise it with the supplier by hand.`;

  const credit = a.ret.creditNowCents === null ? `${a.ret.creditPercentNow}%` : `${money(a.ret.creditNowCents)} (${a.ret.creditPercentNow}%)`;
  const tail =
    a.ret.dropsInDays !== null && a.ret.dropsToPercent !== null
      ? ` ${a.ret.supplier} credits ${credit} today, falling to ${a.ret.dropsToPercent}% in ${a.ret.dropsInDays} day${a.ret.dropsInDays === 1 ? "" : "s"}.`
      : a.ret.closesInDays !== null
        ? ` ${a.ret.supplier} credits ${credit}; the window shuts in ${a.ret.closesInDays} day${a.ret.closesInDays === 1 ? "" : "s"}.`
        : ` ${a.ret.supplier} credits ${credit}.`;
  return head + tail;
}

/** What the whole shelf looks like, for the tile at the top of the page. */
export function shelfTotals(rows: ShelfRow[], allOnHandValueCents: number | null): {
  lines: number;
  surplusValueCents: number;
  atRiskCents: number;
  deadLines: number;
  deadValueCents: number;
  /** The surplus as a share of everything held, where the whole is known. */
  surplusShare: number | null;
} {
  let surplus = 0;
  let atRisk = 0;
  let deadLines = 0;
  let deadValue = 0;
  for (const r of rows) {
    surplus += r.surplusValueCents ?? 0;
    atRisk += r.ret?.atRiskCents ?? 0;
    if (r.state === "dead") {
      deadLines++;
      deadValue += r.surplusValueCents ?? 0;
    }
  }
  return {
    lines: rows.length,
    surplusValueCents: surplus,
    atRiskCents: atRisk,
    deadLines,
    deadValueCents: deadValue,
    surplusShare: allOnHandValueCents && allOnHandValueCents > 0 ? surplus / allOnHandValueCents : null,
  };
}
