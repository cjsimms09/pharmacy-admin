import "server-only";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { getSettings, setSetting } from "./settings";
import { allSuppliers } from "./suppliers-registry";

/**
 * Where the pharmacy stands today, as against where it stood at the end of last month.
 *
 * Two documents carry the compliance ratio and they answer different questions. The monthly rebate
 * breakdown is a settlement: what was earned, on what, and paid when. The daily Purchase Drill Down
 * is a position: where the ratio has got to this month, with the month still running.
 *
 * The position is the one that prices an order. A pharmacist deciding this morning whether to buy
 * a generic from McKesson or from IPC needs the discount that will apply to it, and that discount
 * follows the band the ratio is in *now* — not the band it was in when last month closed. Held
 * apart, both can be shown for what they are: this is where you are, that is what you were paid.
 */

export type LatestRatio = {
  supplierId: string | null;
  supplierName: string | null;
  /** The scrubbed generic compliance ratio, as printed. */
  gcrPercent: number | null;
  osRxPercent: number | null;
  /** The month it belongs to, as YYYY-MM. */
  month: string | null;
  /** When the report itself was generated. */
  generatedOn: string | null;
  readAt: string;
  documentId: string | null;
  /** The by-month trend, most recent first. */
  months: { month: string; gcrPercent: number | null; osRxPercent: number | null; netPurchasesCents: number | null }[];
};

export async function latestRatio(): Promise<LatestRatio | null> {
  const raw = (await getSettings()).rebate_ratio_latest;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LatestRatio;
  } catch {
    return null;
  }
}

/**
 * Files a drill down: the ratio it reports, against the supplier whose report it is.
 *
 * Only ever replaces a reading with a newer one. These arrive daily and out of order is possible —
 * a re-sent report from Tuesday must not overwrite Thursday's position, or the site would quietly
 * price today's order off a stale ratio and nothing would look wrong.
 */
export async function filePurchaseDrillDown(
  read: {
    generatedOn: string | null;
    currentMonth: string | null;
    currentGcrPercent: number | null;
    currentOsRxPercent: number | null;
    months: { month: string; gcrPercent: number | null; osRxPercent: number | null; netPurchasesCents: number | null }[];
  },
  meta: { documentId?: string | null; supplierId?: string | null },
): Promise<{ stored: boolean; message: string; ratio: LatestRatio | null }> {
  if (read.currentGcrPercent === null) {
    return {
      stored: false,
      message: "The drill down was read but no compliance ratio could be found on it, so nothing was changed. The rate the comparison uses is still the one from the last rebate statement.",
      ratio: null,
    };
  }

  const rows = await allSuppliers(true);
  const supplier =
    (meta.supplierId ? rows.find((s) => s.id === meta.supplierId) : null) ??
    rows.find((s) => /mckesson/i.test(s.name)) ??
    rows.find((s) => /mckesson/i.test(s.catalogName ?? "")) ??
    null;

  const next: LatestRatio = {
    supplierId: supplier?.id ?? null,
    supplierName: supplier?.name ?? null,
    gcrPercent: read.currentGcrPercent,
    osRxPercent: read.currentOsRxPercent,
    month: read.currentMonth,
    generatedOn: read.generatedOn,
    readAt: new Date().toISOString(),
    documentId: meta.documentId ?? null,
    months: read.months,
  };

  const held = await latestRatio();
  const olderThanHeld =
    held !== null &&
    ((next.generatedOn && held.generatedOn && next.generatedOn < held.generatedOn) ||
      (next.month && held.month && next.month < held.month));
  if (olderThanHeld) {
    return {
      stored: false,
      message: `This drill down is dated ${next.generatedOn ?? next.month ?? "earlier"}, and a later one is already held (${held!.generatedOn ?? held!.month}). Nothing was changed — an out-of-order report must not put the site back on a stale ratio.`,
      ratio: held,
    };
  }

  await setSetting("rebate_ratio_latest", JSON.stringify(next));
  const moved = held?.gcrPercent != null && held.gcrPercent !== next.gcrPercent;
  return {
    stored: true,
    message:
      `Compliance ratio ${next.gcrPercent}%${next.month ? ` for ${next.month}` : ""}` +
      (moved ? `, up from ${held!.gcrPercent}%` : "") +
      `${supplier ? ` against ${supplier.name}` : ""}. Every price comparison now uses the band that ratio falls in.`,
    ratio: next,
  };
}

/** The supplier row the daily ratio belongs to, for the pages that show it. */
export async function ratioForSupplier(supplierId: string): Promise<LatestRatio | null> {
  const r = await latestRatio();
  if (!r) return null;
  if (r.supplierId && r.supplierId !== supplierId) return null;
  if (!r.supplierId) {
    const row = await db.query.suppliers.findFirst({ where: eq(schema.suppliers.id, supplierId), columns: { name: true } });
    if (!row || !/mckesson/i.test(row.name)) return null;
  }
  return r;
}
