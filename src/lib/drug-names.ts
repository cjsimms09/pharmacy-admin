import "server-only";

/**
 * The best name the site holds for a drug, whichever file it came from.
 *
 * Every claim in the pharmacy's archive carries no item name at all. The transaction report does
 * not export one, so the importer looked the name up in the supplier catalogue and stored what it
 * found — and the claims were loaded before any catalogue had been imported, so all fifteen hundred
 * of them were filed nameless and stayed that way. Nothing since has gone back to fix them, because
 * the name was decided once, at import, and never asked again.
 *
 * The visible cost was the buy list: a page whose whole job is to be acted on, listing fourteen
 * lines of bare eleven-digit numbers. Nobody can pick a bottle off a shelf from that.
 *
 * So the name is resolved when it is read, from whatever the site holds today. A catalogue imported
 * next Sunday names every claim already filed, without touching one of them.
 *
 * ── Which source wins ──
 *
 * The daily on-hand count first. It is PioneerRx's own item name — "Cyclobenzaprine 10 Mg Tablet" —
 * written the way the pharmacy writes it, and it arrives every day, so it is both the most readable
 * name and the freshest. The wholesaler's is the same drug squeezed into a fixed-width field:
 * "CYCLOBENZ HCL TB 10MGNSTR1000@". Both name the bottle; only one of them reads like English.
 *
 * Then whatever the claim itself carried, then the catalogue, then NADAC — each a step further from
 * the pharmacy and a step worse to read, and each better than eleven digits.
 */

/** Where a name can come from, worst last. */
export type NameSources = {
  /** The daily on-hand count: PioneerRx's own item name. */
  onHand?: string | null;
  /** Whatever the claim itself carried. */
  claim?: string | null;
  /** The supplier catalogue's description. */
  catalogue?: string | null;
  /** NADAC's description. */
  nadac?: string | null;
};

/**
 * Placeholders a file uses to hold a row open.
 *
 * McKesson's catalogue really does carry "TBD DO NOT DELETE OR RELEASE" as an item description.
 * Showing that in place of a drug name is worse than showing the NDC, because it looks like an
 * instruction.
 */
function real(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  if (/^tbd\b|do not (delete|release|use)|^n\/?a$|^unknown$/i.test(t)) return null;
  return t;
}

/** The best of what is held, or null where nothing names it. */
export function bestName(from: NameSources): string | null {
  return real(from.onHand) ?? real(from.claim) ?? real(from.catalogue) ?? real(from.nadac) ?? null;
}

let held: { key: string; at: number; names: Map<string, string> } | null = null;
const MAX_AGE_MS = 10 * 60_000;

/** What the naming sources look like from outside, so a new file is noticed without a scan. */
async function currentKey(): Promise<string> {
  const { db } = await import("@/db");
  const [count, imported] = await Promise.all([
    db.query.onHandImports.findFirst({ orderBy: (i, { desc }) => [desc(i.countedOn)], columns: { id: true, countedOn: true } }),
    db.query.supplierImports.findFirst({ orderBy: (i, { desc }) => [desc(i.createdAt)], columns: { id: true } }),
  ]);
  return `${count?.id ?? "none"}:${count?.countedOn ?? "-"}|${imported?.id ?? "none"}`;
}

/**
 * Every NDC the site can name, and the best name for it.
 *
 * The catalogue and NADAC are already held in memory for other screens, so they cost nothing here.
 * The on-hand descriptions are asked for as one grouped pass, taking the newest count's name per
 * NDC — the same `max()` grouping the NADAC benchmark uses, and for the same reason.
 */
export async function drugNames(): Promise<Map<string, string>> {
  const key = await currentKey();
  if (held && held.key === key && Date.now() - held.at < MAX_AGE_MS) return held.names;

  const { db } = await import("@/db");
  const { catalogueRows } = await import("./catalogue-cache");
  const { nadacNow } = await import("./nadac-latest");
  const client = (db as unknown as { $client: { execute: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;

  const [onHand, claims, catalogue, nadac] = await Promise.all([
    // The bare description comes from the row holding max(counted_on); see nadac-latest for the note.
    client.execute("select ndc11, max(counted_on) as counted_on, description from on_hand group by ndc11"),
    client.execute("select ndc11, item_name from claims where item_name is not null and item_name <> '' group by ndc11"),
    catalogueRows(),
    nadacNow(),
  ]);

  const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const byOnHand = new Map<string, string | null>();
  for (const r of onHand.rows) byOnHand.set(String(r.ndc11 ?? ""), text(r.description));
  const byClaim = new Map<string, string | null>();
  for (const r of claims.rows) byClaim.set(String(r.ndc11 ?? ""), text(r.item_name));
  const byCatalogue = new Map<string, string | null>();
  for (const r of catalogue) if (!byCatalogue.has(r.ndc11)) byCatalogue.set(r.ndc11, r.description);
  const byNadac = new Map<string, string | null>();
  for (const n of nadac) if (!byNadac.has(n.ndc11)) byNadac.set(n.ndc11, n.description);

  const names = new Map<string, string>();
  for (const ndc11 of new Set([...byOnHand.keys(), ...byClaim.keys(), ...byCatalogue.keys(), ...byNadac.keys()])) {
    const best = bestName({
      onHand: byOnHand.get(ndc11),
      claim: byClaim.get(ndc11),
      catalogue: byCatalogue.get(ndc11),
      nadac: byNadac.get(ndc11),
    });
    if (best) names.set(ndc11, best);
  }

  held = { key, at: Date.now(), names };
  return names;
}

/** Forget it, for an import that has just brought better names in. */
export function forgetDrugNames(): void {
  held = null;
}
