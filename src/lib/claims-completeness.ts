/**
 * Whether the site holds every fill the pharmacy system does.
 *
 * The owner asked it plainly: "are we confident every dollar that comes into and leaves pioneer is
 * accounted for?" The nightly pull has computed the answer for weeks. It wrote it into a setting
 * and no screen has ever read it — the same fault as the invoice price compare, where a real check
 * ran every night into a drawer.
 *
 * It matters more here than there, because the answer is no. On 11 September PioneerRx held 38
 * fills worth $4,563.35 that never reached this site, 25 of them on the 7th. That is revenue the
 * pharmacy earned and the account does not know about, and until now the only trace of it was one
 * sentence in a settings row.
 *
 * The reconciliation itself lives in `pioneer-claims.ts` and is tested there. This only reads back
 * what the last pull stored, so the page costs nothing to draw and can never disagree with the
 * feed — there is one computation of this, not two.
 */

import { getSettings } from "./settings";

export type ClaimsCompleteness = {
  /** When the pull last ran this. */
  readAt: string;
  /** The newest fill date the PioneerRx copy held. Everything is measured at or before it. */
  coverTo: string | null;
  pioneerFills: number;
  pioneerRemitCents: number;
  siteFills: number;
  siteRemitCents: number;
  /** PioneerRx less the site, inside the window. Positive means the site is short. */
  gapCents: number;
  /** Fills PioneerRx has that the site does not, worst day first. */
  missingByDay: { day: string; fills: number; cents: number }[];
  missingFills: number;
  missingCents: number;
  /** Fills the site holds that PioneerRx has dropped — reversed or replaced since. */
  onlyOnSite: number;
  /** Fills dated after the copy's horizon. Not a discrepancy; the ordinary state of a day-old copy. */
  aheadFills: number;
  aheadCents: number;
};

export async function claimsCompleteness(): Promise<ClaimsCompleteness | null> {
  const s = (await getSettings()) as Record<string, string | undefined>;
  const raw = (s.pioneer_claims_reconcile ?? "").trim();
  if (!raw) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* A setting that will not parse is not a reason to break the page it is shown on. */
    return null;
  }
  const n = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const days = Array.isArray(v.daysShort) ? (v.daysShort as { day: string; fills: number; cents: number }[]) : [];
  const missing = (v.missingTotal ?? {}) as { fills?: number; cents?: number };
  const ahead = (v.aheadOfTheCopy ?? {}) as { fills?: number; cents?: number };
  /*
   * A pull from before this was measured has no `coverTo`, and its figures were computed the old
   * way — against unequal windows. Showing them would put the very number this replaced back on a
   * screen, so an old row reads as nothing rather than as news.
   */
  if (typeof v.coverTo !== "string") return null;
  return {
    readAt: String(v.readAt ?? ""),
    coverTo: v.coverTo,
    pioneerFills: n(v.fills),
    pioneerRemitCents: n(v.pioneerInsuranceCents),
    siteFills: n(v.fills) - n(missing.fills) + n(v.fillsOnlyOnSite),
    siteRemitCents: n(v.siteRemitCents),
    gapCents: n(v.gapCents),
    missingByDay: days,
    missingFills: n(missing.fills),
    missingCents: n(missing.cents),
    onlyOnSite: n(v.fillsOnlyOnSite),
    aheadFills: n(ahead.fills),
    aheadCents: n(ahead.cents),
  };
}
