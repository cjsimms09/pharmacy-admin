/**
 * Return soon: everything the site thinks should go back, in one list, ranked by the dollars.
 *
 * The owner's words, 8 September: "a return soon tool that shows everything the system thinks I
 * should return either based on return policy or non use, or expensive.. expensive things should
 * have a much quicker return time.. if not used we need to send back. cant have money sitting on
 * shelf." Three reasons, one list:
 *
 *   - a credit clock: the supplier's own policy says the credit on an invoice line drops on a day,
 *     or the window shuts (returns-due.ts, which needs the invoice);
 *   - not moving: counted on the shelf and nothing dispensed it in the claims window;
 *   - slow for what it is worth: days of stock beyond what a line of that value may hold. The
 *     more it is worth, the fewer days it may sit — the tiers below.
 *
 * The pure ranking is separate from the loading so it can be tested on made-up shelves.
 */

import { addDays } from "./dates";

export type ReturnTier = { atLeastCents: number; keepDays: number };

/** How long a line may sit, by what is on the shelf. Descending; the first tier that fits wins. */
export const RETURN_TIERS: ReturnTier[] = [
  { atLeastCents: 100_000, keepDays: 7 },
  { atLeastCents: 25_000, keepDays: 14 },
  { atLeastCents: 0, keepDays: 30 },
];

/** Below this, a return is not worth an authorisation form. */
export const RETURN_MATERIALITY_CENTS = 500;

export function tierFor(worthCents: number, tiers: ReturnTier[] = RETURN_TIERS): ReturnTier {
  return tiers.find((t) => worthCents >= t.atLeastCents) ?? tiers[tiers.length - 1];
}

export type ShelfForReturns = {
  ndc11: string;
  name: string | null;
  onHandThousandths: number;
  perDayThousandths: number;
  /** null where nothing was dispensed in the window. */
  daysOfStock: number | null;
  state: "out" | "short" | "lean" | "overstocked" | "dead";
  lastOn: string | null;
  /** What is on the shelf is worth, at the count's own cost where it carried one, else today's cheapest. */
  worthCents: number | null;
};

export type DueForReturns = {
  ndc11: string;
  supplier: string;
  invoiceDate: string;
  quantity: number;
  extendedCents: number;
  creditPercentNow: number;
  dropsInDays: number | null;
  dropsToPercent: number | null;
  closesInDays: number | null;
  dispensedSince: number;
};

export type Urgency = "today" | "this week" | "this month" | "later";

export type ReturnSoonRow = {
  ndc11: string;
  name: string | null;
  onHandThousandths: number;
  worthCents: number | null;
  /** What to send back, and what that part is worth. */
  sendBackThousandths: number;
  sendBackWorthCents: number | null;
  why: "credit" | "window" | "idle" | "slow";
  reasons: string[];
  /** Days until the soonest thing changes: a credit step, a window, or the tier's allowance. Null when nothing is dated. */
  deadlineDays: number | null;
  /** Who sold it, from the invoice line. Null when no invoice for it is on file. */
  supplier: string | null;
  invoiceDate: string | null;
  creditPercentNow: number | null;
  dropsToPercent: number | null;
  /** What the credit loses at the next step, on the part going back. */
  atRiskCents: number | null;
  urgency: Urgency;
  says: string;
  todo: string;
};

export type ReturnSoonView = {
  rows: ReturnSoonRow[];
  totals: { lines: number; sittingCents: number; thisWeek: number; withoutSupplier: number };
  /** Facts about what the list could not see, in words. */
  notes: string[];
};

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const units = (thousandths: number) => Math.round(thousandths / 100) / 10;
const URGENCY_RANK: Record<Urgency, number> = { today: 0, "this week": 1, "this month": 2, later: 3 };

function urgencyFromDays(days: number | null, worthCents: number): Urgency {
  if (days !== null) {
    if (days <= 2) return "today";
    if (days <= 7) return "this week";
    if (days <= 30) return "this month";
    return "later";
  }
  // Nothing dated: the dearer it is, the sooner. Money sitting on the shelf is the cost.
  if (worthCents >= 100_000) return "this week";
  if (worthCents >= 25_000) return "this month";
  return "later";
}

/** Under this many days of claims, "nothing dispensed" is not proof a line is dead: a monthly drug looks idle in a fortnight. */
export const SHORT_WINDOW_DAYS = 60;

export function rankReturns(input: { shelf: ShelfForReturns[]; due: DueForReturns[]; windowDays?: number | null; tiers?: ReturnTier[]; materialityCents?: number }): ReturnSoonRow[] {
  const shortWindow = input.windowDays !== null && input.windowDays !== undefined && input.windowDays < SHORT_WINDOW_DAYS;
  const tiers = input.tiers ?? RETURN_TIERS;
  const materiality = input.materialityCents ?? RETURN_MATERIALITY_CENTS;
  const rows: ReturnSoonRow[] = [];

  // The soonest clock per NDC, whichever invoice line it is on.
  const dueBy = new Map<string, DueForReturns>();
  for (const d of input.due) {
    const soonest = (x: DueForReturns) => Math.min(x.dropsInDays ?? Number.MAX_SAFE_INTEGER, x.closesInDays ?? Number.MAX_SAFE_INTEGER);
    const held = dueBy.get(d.ndc11);
    if (!held || soonest(d) < soonest(held)) dueBy.set(d.ndc11, d);
  }

  const seen = new Set<string>();
  for (const h of input.shelf) {
    seen.add(h.ndc11);
    if (h.onHandThousandths <= 0) continue;
    const worth = h.worthCents ?? 0;
    const tier = tierFor(worth, tiers);
    const d = dueBy.get(h.ndc11) ?? null;
    const reasons: string[] = [];
    let sendBack = 0;
    let why: ReturnSoonRow["why"] | null = null;
    let tierDays: number | null = null;

    if (h.state === "dead") {
      sendBack = h.onHandThousandths;
      why = "idle";
      reasons.push(
        h.lastOn ? `nothing dispensed since ${h.lastOn}` : shortWindow ? `nothing dispensed in the ${input.windowDays} days of claims held, which is too short to call it dead` : "nothing dispensed in the claims window",
      );
    } else if (h.daysOfStock !== null && h.daysOfStock > tier.keepDays) {
      const keep = Math.round(h.perDayThousandths * tier.keepDays);
      sendBack = Math.max(0, h.onHandThousandths - keep);
      why = "slow";
      tierDays = null; // Over its allowance now; how soon it matters is set by the dollars unless a policy dates it.
      reasons.push(`${Math.round(h.daysOfStock)} days of stock; a line worth ${money(worth)} should hold ${tier.keepDays}`);
    } else if (h.daysOfStock !== null && d && (d.dropsInDays !== null || d.closesInDays !== null)) {
      // Moving at a fair pace, but the credit is about to change: is any of it going to be left when it does?
      const clock = Math.min(d.dropsInDays ?? Number.MAX_SAFE_INTEGER, d.closesInDays ?? Number.MAX_SAFE_INTEGER);
      const leftThen = h.onHandThousandths - h.perDayThousandths * clock;
      if (leftThen > 0 && clock <= 30) {
        sendBack = Math.round(leftThen);
        why = d.dropsInDays !== null && d.dropsInDays <= (d.closesInDays ?? Number.MAX_SAFE_INTEGER) ? "credit" : "window";
        reasons.push(`${units(leftThen)} will still be here when the credit changes in ${clock} days`);
      }
    }
    if (!why || sendBack <= 0) continue;

    const sendBackWorth = h.worthCents === null ? null : Math.round((h.worthCents * sendBack) / h.onHandThousandths);
    if (sendBackWorth !== null && sendBackWorth < materiality && !d) continue;

    let deadlineDays: number | null = tierDays;
    if (d) {
      const clock = Math.min(d.dropsInDays ?? Number.MAX_SAFE_INTEGER, d.closesInDays ?? Number.MAX_SAFE_INTEGER);
      if (clock !== Number.MAX_SAFE_INTEGER) {
        deadlineDays = deadlineDays === null ? clock : Math.min(deadlineDays, clock);
        if (d.dropsInDays !== null && d.dropsToPercent !== null) reasons.push(`${d.supplier}'s credit drops from ${d.creditPercentNow}% to ${d.dropsToPercent}% in ${d.dropsInDays} days`);
        if (d.closesInDays !== null) reasons.push(`${d.supplier}'s window shuts in ${d.closesInDays} days`);
        if (why === "idle" || why === "slow") why = d.dropsInDays !== null && d.dropsInDays <= (d.closesInDays ?? Number.MAX_SAFE_INTEGER) && d.dropsInDays <= 7 ? "credit" : why;
      }
    }
    const atRisk = d && sendBackWorth !== null && d.dropsToPercent !== null ? Math.round((sendBackWorth * (d.creditPercentNow - d.dropsToPercent)) / 100) : null;
    let urgency = urgencyFromDays(deadlineDays, sendBackWorth ?? worth);
    // A short window can only say "check it", never "send it this week", unless a policy dates it.
    if (why === "idle" && shortWindow && deadlineDays === null && urgency === "this week") urgency = "this month";
    const name = h.name ?? h.ndc11;
    const says =
      why === "idle"
        ? `${name}: ${units(sendBack)} on the shelf and ${reasons[0]}. ${sendBackWorth !== null ? `${money(sendBackWorth)} sitting.` : ""}`.trim()
        : why === "slow"
          ? `${name}: ${reasons[0]}. Send back ${units(sendBack)}${sendBackWorth !== null ? `, ${money(sendBackWorth)}` : ""}.`
          : `${name}: ${reasons.join("; ")}.`;
    const todo = d
      ? `Ask ${d.supplier} for a return authorisation on the ${d.invoiceDate} invoice${atRisk ? ` before ${money(atRisk)} of credit falls away` : ""}.`
      : "No invoice for it is on file, so the site cannot say who sold it or what they still credit. Load the invoice, or send it back to whoever it came from.";
    rows.push({
      ndc11: h.ndc11,
      name: h.name,
      onHandThousandths: h.onHandThousandths,
      worthCents: h.worthCents,
      sendBackThousandths: sendBack,
      sendBackWorthCents: sendBackWorth,
      why,
      reasons,
      deadlineDays,
      supplier: d?.supplier ?? null,
      invoiceDate: d?.invoiceDate ?? null,
      creditPercentNow: d?.creditPercentNow ?? null,
      dropsToPercent: d?.dropsToPercent ?? null,
      atRiskCents: atRisk,
      urgency,
      says,
      todo,
    });
  }

  // Invoice lines with a clock on them that the count did not show at all: the policy still says so.
  for (const d of input.due) {
    if (seen.has(d.ndc11) || d.dispensedSince > 0) continue;
    const clock = Math.min(d.dropsInDays ?? Number.MAX_SAFE_INTEGER, d.closesInDays ?? Number.MAX_SAFE_INTEGER);
    if (clock === Number.MAX_SAFE_INTEGER || clock > 30) continue;
    const atRisk = d.dropsToPercent !== null ? Math.round((d.extendedCents * (d.creditPercentNow - d.dropsToPercent)) / 100) : null;
    rows.push({
      ndc11: d.ndc11,
      name: null,
      onHandThousandths: d.quantity * 1000,
      worthCents: d.extendedCents,
      sendBackThousandths: d.quantity * 1000,
      sendBackWorthCents: d.extendedCents,
      why: d.dropsInDays !== null && d.dropsInDays <= (d.closesInDays ?? Number.MAX_SAFE_INTEGER) ? "credit" : "window",
      reasons: [`bought from ${d.supplier} on ${d.invoiceDate}, nothing dispensed since, and the credit changes in ${clock} days`],
      deadlineDays: clock,
      supplier: d.supplier,
      invoiceDate: d.invoiceDate,
      creditPercentNow: d.creditPercentNow,
      dropsToPercent: d.dropsToPercent,
      atRiskCents: atRisk,
      urgency: urgencyFromDays(clock, d.extendedCents),
      says: `${d.ndc11}: bought from ${d.supplier} on ${d.invoiceDate}, nothing dispensed since; the credit changes in ${clock} days.`,
      todo: `Ask ${d.supplier} for a return authorisation on the ${d.invoiceDate} invoice.`,
    });
  }

  // The clock first, then the money: a credit dropping in three days beats a dearer line nothing dates.
  const dated = (r: ReturnSoonRow) => r.deadlineDays ?? Number.MAX_SAFE_INTEGER;
  rows.sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || dated(a) - dated(b) || (b.sendBackWorthCents ?? 0) - (a.sendBackWorthCents ?? 0));
  return rows;
}

export function returnTotals(rows: ReturnSoonRow[]): ReturnSoonView["totals"] {
  return {
    lines: rows.length,
    sittingCents: rows.reduce((n, r) => n + (r.sendBackWorthCents ?? 0), 0),
    thisWeek: rows.filter((r) => r.urgency === "today" || r.urgency === "this week").length,
    withoutSupplier: rows.filter((r) => r.supplier === null).length,
  };
}

/* ── The part that is allowed to interrupt somebody ───────────────────────── */

/**
 * How near a credit step has to be before the owner is told rather than shown.
 *
 * A page is looked at; a warning arrives. The bar for arriving is higher, and these two numbers
 * are the bar. Seven days for a credit about to drop, because a return authorisation, a box and a
 * carrier take most of a week. Fourteen for a window about to shut, because a window that shuts is
 * the whole credit rather than a step of it, and there is no second chance at it.
 */
export const WARN_CREDIT_DAYS = 7;
export const WARN_WINDOW_DAYS = 14;

/**
 * The rows a warning may be built from: only the ones a supplier's own policy has dated.
 *
 * This is the whole guard, and the reason for it is that the site's other two reasons for
 * returning something are judgments made against however many days of claims happen to be loaded.
 * With fifteen days of claims held, a drug dispensed once a month has not been dispensed in the
 * window — and "not moving" is then a statement about the claims file, not about the bottle. The
 * page says that out loud in its notes and shows those rows anyway, which is right for a page
 * somebody chose to open. Emailing it to the owner, or putting it in red on the screen he reads
 * from the doorway, would be telling him to send back stock he is dispensing.
 *
 * A dated clock has no such weakness. The supplier wrote the date on its own returns policy, and
 * the invoice says what was bought and when. Nothing about it depends on how much claims history
 * the site happens to hold, so it is safe to interrupt somebody with — and it is the case where
 * silence actually costs money, because the credit falls on the day it falls whether or not
 * anybody opened the page.
 */
export function warnableReturns(rows: ReturnSoonRow[], creditDays = WARN_CREDIT_DAYS, windowDays = WARN_WINDOW_DAYS): ReturnSoonRow[] {
  return rows.filter((r) => {
    if (r.deadlineDays === null) return false;
    if (r.why === "credit") return r.deadlineDays <= creditDays;
    if (r.why === "window") return r.deadlineDays <= windowDays;
    // "idle" and "slow" never warn, however dear they are. They are a list to check, not to ship.
    return false;
  });
}

/** One line of a warning: the bottle, who sold it, the money, and the day it changes. */
export type ReturnWarningLine = {
  key: string;
  ndc11: string;
  name: string | null;
  supplier: string | null;
  sendBackThousandths: number;
  sendBackWorthCents: number | null;
  /** What the credit loses at the next step, on the part going back. Null where the policy does not say. */
  atRiskCents: number | null;
  deadlineDays: number;
  /** The day itself, not a countdown, so it can be written in a diary. */
  changesOn: string;
  why: "credit" | "window";
  says: string;
};

export type ReturnWarning = {
  lines: ReturnWarningLine[];
  /** What the whole warning is worth sending back, at cost. */
  sendBackWorthCents: number;
  /** What falls away if nothing is done, where the policies say. */
  atRiskCents: number;
  /** The soonest day anything on it changes. */
  soonestDays: number;
};

/**
 * The warning itself, or null when there is nothing worth interrupting anybody about.
 *
 * Null rather than an empty shape on purpose: the digest's first rule is that nothing goes out
 * when there is nothing to say, and a caller that has to inspect a count to discover that is a
 * caller that will one day forget to.
 */
export function returnWarning(rows: ReturnSoonRow[], today: string, opts: { creditDays?: number; windowDays?: number } = {}): ReturnWarning | null {
  const warnable = warnableReturns(rows, opts.creditDays ?? WARN_CREDIT_DAYS, opts.windowDays ?? WARN_WINDOW_DAYS);
  if (warnable.length === 0) return null;
  const lines = warnable.map((r) => ({
    key: `${r.ndc11}|${r.invoiceDate ?? ""}`,
    ndc11: r.ndc11,
    name: r.name,
    supplier: r.supplier,
    sendBackThousandths: r.sendBackThousandths,
    sendBackWorthCents: r.sendBackWorthCents,
    atRiskCents: r.atRiskCents,
    deadlineDays: r.deadlineDays!,
    changesOn: addDays(today, r.deadlineDays!),
    why: r.why as "credit" | "window",
    says: warningLine(r, addDays(today, r.deadlineDays!)),
  }));
  return {
    lines,
    sendBackWorthCents: lines.reduce((n, l) => n + (l.sendBackWorthCents ?? 0), 0),
    atRiskCents: lines.reduce((n, l) => n + (l.atRiskCents ?? 0), 0),
    soonestDays: Math.min(...lines.map((l) => l.deadlineDays)),
  };
}

/**
 * One row in words, in the order somebody acts in: what it is, who to ring, what it is worth, when.
 *
 * The date is said as a date. "In 6 days" is read on the day it is read and is wrong by the time
 * the email is opened on Thursday; a date is still true on Thursday.
 */
function warningLine(r: ReturnSoonRow, changesOn: string): string {
  const what = r.name ?? r.ndc11;
  const who = r.supplier ? ` from ${r.supplier}` : " — no invoice on file, so the site cannot say who sold it";
  const worth = r.sendBackWorthCents !== null ? `, ${money(r.sendBackWorthCents)}` : "";
  const when =
    r.why === "credit"
      ? r.dropsToPercent !== null && r.creditPercentNow !== null
        ? `credit drops from ${r.creditPercentNow}% to ${r.dropsToPercent}% on ${changesOn}`
        : `credit drops on ${changesOn}`
      : `the return window shuts on ${changesOn}`;
  const risk = r.atRiskCents ? ` — ${money(r.atRiskCents)} of credit goes with it` : "";
  return `${units(r.sendBackThousandths)} of ${what}${who}${worth}: ${when}${risk}.`;
}

/**
 * The warning on the live data: the whole list, then only the part worth interrupting somebody for.
 *
 * One function for both the weekly email and the Today page, so the two can never come to disagree
 * about which returns are urgent — and so the thresholds live in one place when the owner decides
 * seven days is not long enough.
 */
export async function returnWarningNow(today?: string): Promise<ReturnWarning | null> {
  const view = await returnSoonNow();
  const { todayIso } = await import("./dates");
  return returnWarning(view.rows, today ?? todayIso());
}

/** The list on the live data. Server only; the ranking above is what the tests exercise. */
export async function returnSoonNow(): Promise<ReturnSoonView> {
  const [{ fullShelfNow }, { returnsDueNow }] = await Promise.all([import("./shelf"), import("./returns-due")]);
  const [shelf, due] = await Promise.all([fullShelfNow(), returnsDueNow()]);
  const { daysBetween } = await import("./dates");
  const windowDays = shelf.from && shelf.to ? daysBetween(shelf.from, shelf.to) + 1 : null;
  const rows = rankReturns({
    windowDays,
    shelf: shelf.rows.map((r) => ({
      ndc11: r.ndc11,
      name: r.name,
      onHandThousandths: r.onHandThousandths,
      perDayThousandths: r.perDayThousandths,
      daysOfStock: r.daysOfStock,
      state: r.state,
      lastOn: r.lastOn,
      worthCents: r.countValueCents ?? r.valueCents,
    })),
    due: due.rows.map((d) => ({
      ndc11: d.ndc11,
      supplier: d.supplier,
      invoiceDate: d.invoiceDate,
      quantity: d.quantity,
      extendedCents: d.extendedCents,
      creditPercentNow: d.creditPercentNow,
      dropsInDays: d.dropsInDays,
      dropsToPercent: d.dropsToPercent,
      closesInDays: d.closesInDays,
      dispensedSince: d.dispensedSince,
    })),
  });
  const notes: string[] = [];
  if (!shelf.countedOn) notes.push("No count of the shelf has been uploaded, so nothing can be judged idle or slow.");
  else notes.push(`The shelf as counted on ${shelf.countedOn}; the rate is the ${shelf.from ?? "?"} to ${shelf.to ?? "?"} claims.`);
  if (windowDays !== null && windowDays < SHORT_WINDOW_DAYS)
    /*
     * The claims history grows by a day each day, and nothing else will grow it.
     *
     * This said "the twelve-month claims export makes that judgment real". There is no such export:
     * the owner settled on 8 September 2026 that nothing before 1 September is being uploaded and
     * the site starts clean. A caveat that points at a file which is never going to arrive reads as
     * "this will be fixed" and is really "this will be true in a few months" — and the difference
     * matters, because the first invites him to leave the list alone until then.
     */
    notes.push(`Only ${windowDays} days of claims are held, so "not moving" means not dispensed in ${windowDays} days — a monthly drug looks idle. The site holds claims from 1 September 2026 onwards and the window widens by a day each day; until it is past ${SHORT_WINDOW_DAYS}, these rows are a list to check rather than to ship.`);
  notes.push(
    due.linesConsidered === 0
      ? "No supplier invoice lines are on file, so no credit clock can be timed and no line can say who sold it."
      : `${due.linesConsidered.toLocaleString()} invoice lines on file carry a credit clock. A line without an invoice here cannot say who sold it.`,
  );
  if (due.suppliersWithoutPolicy.length > 0) notes.push(`No returns policy on file for ${due.suppliersWithoutPolicy.join(", ")}: nothing bought from them can be given a credit clock.`);
  return { rows, totals: returnTotals(rows), notes };
}
