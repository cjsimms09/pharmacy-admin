/**
 * McKesson's daily Purchase Drill Down, checked against itself.
 *
 * The report is read by the model (`readPurchaseDrillDown` in ai.ts), because its text layer
 * interleaves the columns. A figure read into the wrong column is the failure to fear: it is a
 * plausible percentage with a month beside it, and it selects a rebate band. So every month row
 * that comes back is checked here the way the rebate statement is checked in rebate-report.ts —
 * the report prints the money under each ratio, and the money must reproduce the ratio:
 *
 *   GCR    = generic Rx (excluding MPB) ÷ (total Rx − exclusions)     — exclusions are not printed,
 *                                                                        so the denominator implied
 *                                                                        by the ratio must be at
 *                                                                        most total Rx, and near it
 *   OS/Rx  = OneStop ÷ total Rx
 *   OS/Gx  = OneStop ÷ total generic (Rx and OTC generics together)
 *
 * and total brand + total generic = net purchases, with total Rx being net purchases less OTC.
 *
 * On the pharmacy's own six-month report every month reproduces to the printed hundredth, with
 * June's implied denominator two thousand dollars under total Rx: the flu pre-book, drop-shipped,
 * which is exactly the exclusion the report header names. A row that does not reproduce is not a
 * position; it is a misread, and it is refused with the arithmetic shown.
 *
 * ── What the report's GCR is not ──
 *
 * The drill-down's exclusions are whatever the report was scheduled with — "Flu or Dropship" on
 * the pharmacy's. The rebate statement's *scrubbed* GCR applies McKesson's own list, which is
 * wider, and on May it was 20.64% against the drill-down's 10.13%. The band is selected by the
 * statement's figure. A site that selected the band from the drill-down as scheduled would put
 * this pharmacy in the bottom band while McKesson pays it at the top one — and would then tell the
 * buyer every contract generic costs fourteen points more than it does. So `positionFrom` records
 * which exclusions the figure carries, and only `withScrub` (ratio-effect.ts), given the same
 * month on both reports, restates it to the statement's basis, labelled as an estimate.
 *
 * Pure.
 */

import type { Position } from "./ratio-effect";

export type DrillDownMonth = {
  /** YYYY-MM. */
  month: string;
  netPurchasesCents: number | null;
  totalRxCents: number | null;
  totalBrandCents: number | null;
  totalGenericCents: number | null;
  /** "Generic Rx ($) (excluding MPB)": the GCR numerator. */
  genericRxExMpbCents: number | null;
  oneStopCents: number | null;
  multiSourceCents: number | null;
  gcrPercent: number | null;
  osRxPercent: number | null;
  osGxPercent: number | null;
};

export type DrillDownHeader = {
  generatedOn: string | null;
  /** The report's own filter line, e.g. "Flu or Dropship". Null where the header was not read. */
  gcrExclusions: string | null;
  osRxExclusions: string | null;
  /** "Invoice/Credit Date is in the last 6 months", as printed. */
  dateFilter: string | null;
};

export type Check = { what: string; ok: boolean; detail: string };

const pct = (n: number) => `${n.toFixed(2)}%`;
const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A printed percentage to two places covers a range; a computed figure is right if it rounds to it. */
function roundsTo(computedPercent: number, printedPercent: number): boolean {
  return Math.abs(Math.round(computedPercent * 100) / 100 - printedPercent) < 0.0051;
}

/**
 * Checks one month row. Every check that can be made is made; a check whose figures are missing
 * is reported as not made rather than passed.
 */
export function checkMonth(m: DrillDownMonth): { ok: boolean; checks: Check[]; impliedExclusionsCents: number | null } {
  const checks: Check[] = [];
  let impliedExclusionsCents: number | null = null;

  if (m.oneStopCents !== null && m.totalRxCents !== null && m.osRxPercent !== null && m.totalRxCents > 0) {
    const c = (m.oneStopCents / m.totalRxCents) * 100;
    checks.push({ what: "OS/Rx is OneStop over total Rx", ok: roundsTo(c, m.osRxPercent), detail: `${money(m.oneStopCents)} ÷ ${money(m.totalRxCents)} = ${pct(c)}; printed ${pct(m.osRxPercent)}` });
  } else checks.push({ what: "OS/Rx is OneStop over total Rx", ok: false, detail: "not checked: OneStop, total Rx or OS/Rx missing" });

  if (m.oneStopCents !== null && m.totalGenericCents !== null && m.osGxPercent !== null && m.totalGenericCents > 0) {
    const c = (m.oneStopCents / m.totalGenericCents) * 100;
    checks.push({ what: "OS/Gx is OneStop over total generic", ok: roundsTo(c, m.osGxPercent), detail: `${money(m.oneStopCents)} ÷ ${money(m.totalGenericCents)} = ${pct(c)}; printed ${pct(m.osGxPercent)}` });
  } else checks.push({ what: "OS/Gx is OneStop over total generic", ok: false, detail: "not checked: OneStop, total generic or OS/Gx missing" });

  if (m.genericRxExMpbCents !== null && m.totalRxCents !== null && m.gcrPercent !== null && m.gcrPercent > 0 && m.totalRxCents > 0) {
    // The denominator the printed ratio implies, against total Rx: at most total Rx (the exclusions
    // only ever remove). The printed figure rounds from a range, so the smallest denominator the
    // range allows must fit under total Rx, and the largest exclusion it allows must be small.
    const hi = m.gcrPercent + 0.005;
    const lo = m.gcrPercent - 0.005;
    const smallestDen = (m.genericRxExMpbCents / hi) * 100;
    const largestDen = (m.genericRxExMpbCents / lo) * 100;
    const asPrinted = (m.genericRxExMpbCents / m.totalRxCents) * 100;
    const exclusions = m.totalRxCents - (m.genericRxExMpbCents / m.gcrPercent) * 100;
    const withinTotal = smallestDen <= m.totalRxCents * 1.0001;
    const nearTotal = m.totalRxCents - Math.min(largestDen, m.totalRxCents) <= m.totalRxCents * 0.1; // a tenth excluded would not be flu and drop-ship
    impliedExclusionsCents = Math.max(0, Math.round(exclusions));
    checks.push({
      what: "GCR is generic Rx over total Rx less exclusions",
      ok: withinTotal && nearTotal,
      detail: roundsTo(asPrinted, m.gcrPercent)
        ? `${money(m.genericRxExMpbCents)} ÷ ${money(m.totalRxCents)} = ${pct(asPrinted)}; printed ${pct(m.gcrPercent)}; nothing excluded this month`
        : `${money(m.genericRxExMpbCents)} ÷ ${money(m.totalRxCents)} = ${pct(asPrinted)} but printed ${pct(m.gcrPercent)}, which implies ${money(impliedExclusionsCents)} excluded from the denominator${withinTotal && nearTotal ? " (flu or drop-ship)" : " — more than exclusions explain"}`,
    });
  } else checks.push({ what: "GCR is generic Rx over total Rx less exclusions", ok: false, detail: "not checked: generic Rx, total Rx or GCR missing" });

  if (m.totalBrandCents !== null && m.totalGenericCents !== null && m.netPurchasesCents !== null) {
    const sum = m.totalBrandCents + m.totalGenericCents;
    const ok = Math.abs(sum - m.netPurchasesCents) <= Math.max(100, m.netPurchasesCents * 0.0005);
    checks.push({ what: "brand plus generic is net purchases", ok, detail: `${money(m.totalBrandCents)} + ${money(m.totalGenericCents)} = ${money(sum)}; net purchases ${money(m.netPurchasesCents)}` });
  }

  return { ok: checks.every((c) => c.ok), checks, impliedExclusionsCents };
}

/**
 * The GCR position a month row gives, on the drill-down's own exclusions.
 *
 * The denominator is the one the printed ratio implies, not total Rx, so that projecting a line
 * onto it reproduces the report's own arithmetic. Null where the row did not check.
 */
export function positionFrom(m: DrillDownMonth): Position | null {
  const r = checkMonth(m);
  if (!r.ok || m.gcrPercent === null || m.genericRxExMpbCents === null) return null;
  const denominatorCents = Math.round((m.genericRxExMpbCents / m.gcrPercent) * 100);
  return { ratioPercent: m.gcrPercent, denominatorCents, definition: "generics_over_rx", scrub: "drill-down" };
}

/**
 * What the site needs off this report, and what it has been recording. For the handoff and the
 * reader's schema: every field named here is on the report, month by month.
 */
export const FIELDS_WANTED: { field: keyof DrillDownMonth | keyof DrillDownHeader; printedAs: string; why: string }[] = [
  { field: "gcrExclusions", printedAs: "GCR Denominator Exclusions is …", why: "says which exclusions the ratio carries; without it the figure cannot be told from the statement's scrubbed one" },
  { field: "generatedOn", printedAs: "Generated on …", why: "a re-sent older report must not overwrite a newer position" },
  { field: "month", printedAs: "Invoice/Credit Month Year", why: "the month in progress is the position; the rest is the trend" },
  { field: "gcrPercent", printedAs: "Net Purchases - GCR", why: "the ratio, on the report's exclusions" },
  { field: "genericRxExMpbCents", printedAs: "Net Purchases - Generic Rx ($) (excluding MPB)", why: "the GCR numerator; with the ratio it gives the denominator, so an order can be projected" },
  { field: "totalRxCents", printedAs: "Net Purchases - Total Rx ($)", why: "checks the ratio and bounds the exclusions" },
  { field: "totalBrandCents", printedAs: "Net Purchases - Total Brand ($)", why: "what drags the ratio; checks brand + generic = net purchases" },
  { field: "totalGenericCents", printedAs: "Net Purchases - Total Generic ($)", why: "the OS/Gx denominator, and the same check" },
  { field: "oneStopCents", printedAs: "Net Purchases - One Stop ($)", why: "the base the band's rate is paid on: what the month's rebate is worth" },
  { field: "osRxPercent", printedAs: "Net Purchases - OS/Rx (%)", why: "checks OneStop against total Rx" },
  { field: "osGxPercent", printedAs: "Net Purchases - OS/Gx (%)", why: "the figure the GPR ladder is measured by" },
  { field: "multiSourceCents", printedAs: "Net Purchases - MultiSource Program ($)", why: "a second generics programme the statement may pay on" },
  { field: "netPurchasesCents", printedAs: "Net Purchases ($)", why: "the trend, and the statement's net purchases to reconcile against" },
];
