/**
 * The buying logic's findings, as rows for the one money list.
 *
 * `money-found.ts` is where the pharmacist looks in the morning: every row an amount and an
 * instruction, nothing invented, nothing counted twice, one-offs kept apart from what recurs. The
 * modules under `buying-logic.md` produce findings of exactly that kind — a better NDC for a
 * product, a rebate band about to be lost, plans whose units cannot be priced — and this turns
 * each into a row of that list, or into a "blocked" line where the money cannot yet be seen.
 *
 * ── Two rules the rows keep ──
 *
 * **A figure over the claims held is not a figure per month.** The claims accumulate from the day
 * the feed started; a saving worked out over all of them grows with the calendar, not with the
 * business. Every recurring row here is scaled to thirty days by the span of claims it was
 * measured on (`perMonthCents`), and says so in its basis. A row measured on less than a week is
 * not offered as recurring at all — a week is a guess about a month.
 *
 * **Confidence never scales the money.** A gap worked out on an estimated scrub is the same
 * dollars as one on the statement's figure; it is marked "worth checking", not halved.
 *
 * Pure. Takes the modules' results and returns rows; the caller loads the data and decides what
 * to show.
 */

import type { MoneyRow } from "./money-found";
import type { UnderNadac, ProductPick } from "./under-nadac";
import { switchNdc, notYetBought } from "./under-nadac";
import type { TierEffect, Band } from "./ratio-effect";
import type { PlanBasis } from "./pay-basis";

export type Blocked = { says: string; todo: string; href: string };
export type Watch = { says: string; todo: string; href: string };

export type RecommendationInput = {
  /** The buy list, where the ledger could build one. */
  under?: UnderNadac | null;
  /** Days between the earliest and latest fill in the claims the buy list was measured on. */
  periodDays?: number | null;
  /** The month's position on the primary's ladder, where the drill-down and the ladder are held. */
  tier?: { supplierName: string; effect: TierEffect; baseCents: number; bands: Band[] } | null;
  /** How each plan pays, with the units each dispensed in the period, for the "cannot price" line. */
  plans?: { basis: PlanBasis; units: number }[] | null;
};

export type Recommendations = { rows: MoneyRow[]; blocked: Blocked[]; watch: Watch[] };

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Scales an amount measured over `periodDays` to thirty days. Null under a week: too short to call recurring. */
export function perMonthCents(amountCents: number, periodDays: number | null | undefined): number | null {
  if (!periodDays || periodDays < 7) return null;
  return Math.round((amountCents * 30) / periodDays);
}

/** Days between two ISO dates, inclusive of both, so one day of claims is one day, not zero. */
export function spanDays(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

export function recommendations(input: RecommendationInput, opts: { materialityCents?: number; watchUnderPercent?: number } = {}): Recommendations {
  const materiality = opts.materialityCents ?? 500;
  const rows: MoneyRow[] = [];
  const blocked: Blocked[] = [];
  const watch: Watch[] = [];

  // ── A better NDC for a product already dispensed ──
  if (input.under) {
    const picks: ProductPick[] = switchNdc(input.under, materiality);
    const total = picks.reduce((n, p) => n + p.gainCents, 0);
    const monthly = perMonthCents(total, input.periodDays);
    if (picks.length > 0 && total > 0) {
      const top = picks[0];
      if (monthly !== null) {
        rows.push({
          key: "switch-ndc",
          says: `${money(monthly)} a month more on ${picks.length} product${picks.length === 1 ? "" : "s"} by buying a different NDC of the same drug.`,
          todo: top.says,
          amountCents: monthly,
          cadence: "recurring_monthly",
          confidence: picks.some((p) => p.pick.rebateRateMissing) ? "worth checking" : "likely",
          basis:
            `For each product, the NDC furthest under NADAC after the rebate against the NDC dispensed most today, on the units dispensed over ${input.periodDays} days, scaled to thirty. ` +
            "It is the answer for a plan that pays NADAC; a plan on a fixed schedule pays every NDC the same, and for those only the cost matters.",
          href: "/purchasing",
          overlapsWith: ["switch-supplier"],
        });
      } else {
        watch.push({
          says: `${money(total)} on ${picks.length} product${picks.length === 1 ? "" : "s"} from buying a different NDC, measured on too few days to call a month.`,
          todo: top.says,
          href: "/purchasing",
        });
      }
    }

    const shelf = notYetBought(input.under, opts.watchUnderPercent ?? 20);
    if (shelf.length > 0) {
      const top = shelf[0];
      watch.push({
        says: `${shelf.length} NDC${shelf.length === 1 ? "" : "s"} offered well under NADAC that you neither buy nor dispense.`,
        todo: `${top.name ?? top.ndc11}: ${top.underNadacPercent}% under NADAC at ${top.buy.supplier}. Worth something only if a plan pays on NADAC and you would dispense it.`,
        href: "/purchasing",
      });
    }

    const packUnknown = input.under.excluded.filter((e) => /pack size/.test(e.reason)).length;
    if (packUnknown > 0) {
      blocked.push({
        says: `${packUnknown} NDC${packUnknown === 1 ? "" : "s"} bought on invoice cannot be compared with anything: no catalogue carries a pack size for them.`,
        todo: "Load the supplier's catalogue that lists them, or enter the pack size on the item.",
        href: "/purchasing",
      });
    }
  }

  // ── A rebate band about to be lost ──
  if (input.tier) {
    const { effect, supplierName, baseCents, bands } = input.tier;
    const after = effect.after;
    if (after && effect.headroom) {
      const below = effect.headroom.percentPoints;
      // Within a point of the floor, or within a tenth of the month's purchases in brand.
      const close = below < 1 || effect.headroom.denominatorRoomCents < effect.projection.denominatorCents * 0.1;
      if (close) {
        const rateNow = after.rebatePercent / 100;
        // What the band is worth over the band below it, on the base paid at this rate.
        const lower = [...bands].filter((b) => b.thresholdPercent < after.thresholdPercent).sort((a, b) => b.thresholdPercent - a.thresholdPercent)[0] ?? null;
        const atRisk = Math.round(baseCents * (rateNow - (lower ? lower.rebatePercent / 100 : 0)));
        if (atRisk > 0) {
          rows.push({
            key: `rebate-band-risk-${supplierName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            says: `${money(atRisk)} of this month's rebate at ${supplierName} rides on ${money(effect.headroom.denominatorRoomCents)} of headroom.`,
            todo: `You are ${below.toFixed(2)} points above the ${after.thresholdPercent}% band. ${money(effect.headroom.denominatorRoomCents)} more brand through ${supplierName} this month loses it; buying that brand elsewhere, or ${money(effect.next?.numeratorNeededCents ?? 0)} more generics there, keeps it.`,
            amountCents: atRisk,
            cadence: "one_off",
            confidence: effect.projection.scrub === "statement" ? "certain" : "worth checking",
            basis:
              `Generic share of purchases at ${supplierName} this month (${effect.projection.afterPercent.toFixed(2)}%, ` +
              (effect.projection.scrub === "statement" ? "on the statement's scrub" : effect.projection.scrub === "estimated" ? "restated to the statement's scrub, estimated" : "on the drill-down's own exclusions, which is not the figure that selects the band") +
              `) against the ladder; the rebate is the band rate on the month's contract generics (${money(baseCents)}).`,
            href: "/suppliers",
          });
        }
      }
    }
  }

  // ── Plans whose units cannot be priced ──
  if (input.plans && input.plans.length > 0) {
    const unknown = input.plans.filter((p) => p.basis.basis === "unknown");
    const total = input.plans.reduce((n, p) => n + p.units, 0);
    const unknownUnits = unknown.reduce((n, p) => n + p.units, 0);
    if (total > 0 && unknownUnits / total >= 0.2) {
      blocked.push({
        says: `${Math.round((unknownUnits / total) * 100)}% of units dispensed are on ${unknown.length} plan${unknown.length === 1 ? "" : "s"} whose pricing basis the claims have not shown yet, so the NDC choice cannot price them.`,
        todo: "Nothing to do but wait for more claims, or ask PioneerRx to add Basis of Reimbursement (NCPDP 522-FM) to the daily report, which settles it outright.",
        href: "/plans",
      });
    }
  }

  return { rows, blocked, watch };
}
