import "server-only";

/**
 * The current NADAC for every drug, and only the current one.
 *
 * NADAC is the largest table this site holds: every NDC the federal file carries, at every date it
 * has ever carried one, growing by a file a week. A year of weekly files is well over a million
 * rows. The purchasing ledger was loading all of them on every request — Today, the money page and
 * Purchasing each — and then throwing almost all of them away, because the only thing it does with
 * them is keep the newest date per NDC.
 *
 * That is the reason the site became unusable rather than merely slow: a page that has to pull a
 * million rows out of SQLite before it can render takes long enough that pressing a button looks
 * like nothing happening at all.
 *
 * So the newest row per NDC is asked for in SQL, which is what was wanted in the first place. In
 * SQLite a bare column selected alongside `max()` in a grouped query comes from the row that
 * produced the maximum — a documented guarantee, not an accident — so one grouped pass over the
 * `(ndc11, effective_on)` index answers it. Thirty thousand rows instead of a million and a half.
 *
 * And it is held between requests, keyed on the newest file loaded, because a weekly benchmark
 * does not change between two page loads.
 */

export type NadacNow = {
  ndc11: string;
  unitMicros: number;
  effectiveOn: string;
  description: string | null;
  /** EA, ML, GM — which unit the price is per, and the reason a pack cannot be compared to it raw. */
  pricingUnit: string | null;
  /** Brand or generic, as CMS classifies it. */
  classification: string | null;
  /** Over the counter, as the file flags it. */
  otc: boolean | null;
};

let held: { key: string; at: number; rows: NadacNow[] } | null = null;

/** The newest file loaded, and how many rows are held with it: one indexed row, not a scan. */
async function currentKey(): Promise<string> {
  const { db } = await import("@/db");
  const latest = await db.query.nadacPrices.findFirst({
    orderBy: (n, { desc }) => [desc(n.fileAsOf)],
    columns: { fileAsOf: true },
  });
  return latest?.fileAsOf ?? "empty";
}

export async function nadacNow(): Promise<NadacNow[]> {
  const key = await currentKey();
  // Held until a new file loads: a weekly benchmark does not change between two page loads, and
  // the grouped pass over a year of files is a second and a half that must not repeat on a clock.
  if (held && held.key === key) return held.rows;

  const { db } = await import("@/db");
  const client = (db as unknown as { $client: { execute: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const r = await client.execute(
    // The bare columns come from the row holding max(effective_on); see the note above.
    "select ndc11, max(effective_on) as effective_on, unit_micros, description, pricing_unit, classification, otc from nadac_prices group by ndc11",
  );
  const rows: NadacNow[] = [];
  for (const row of r.rows) {
    const ndc11 = String(row.ndc11 ?? "");
    const unitMicros = Number(row.unit_micros);
    const effectiveOn = String(row.effective_on ?? "");
    if (!ndc11 || !Number.isFinite(unitMicros)) continue;
    const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
    rows.push({ ndc11, unitMicros, effectiveOn, description: text(row.description), pricingUnit: text(row.pricing_unit), classification: text(row.classification), otc: row.otc === null || row.otc === undefined ? null : Number(row.otc) === 1 });
  }
  held = { key, at: Date.now(), rows };
  return rows;
}

/** Forget it, for the import that has just changed the benchmark. */
export function forgetNadac(): void {
  held = null;
}
