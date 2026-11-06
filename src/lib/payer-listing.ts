/**
 * The pharmacy's own payer list, as its reconciliation service exports it.
 *
 * Two columns — the payer's name and the BIN — one row per BIN the pharmacy has actually been
 * paid by. It is worth more than any published listing for one reason: it is this pharmacy's,
 * and it says which payers pay through the PSAO ("(HMA)" on the name: Health Mart Atlas) and
 * which pay direct. That is the difference between a contract the pharmacy holds and one the
 * PSAO holds on its behalf, and it decides which document governs a claim.
 *
 * The listing never overwrites a BIN the published crosswalk already names. Where the two agree
 * the listing's spelling is kept as an alias; where they disagree the BIN is named as a conflict
 * for a person, because the site cannot know which record is stale.
 *
 * Pure.
 */

import { parseCsv } from "./reference";

export type ListingRow = {
  bin: string;
  /** As the service wrote it: "OptumRx (HMA)". */
  rawName: string;
  /** With the PSAO marker removed: "OptumRx". */
  cleanName: string;
  /** The PSAO the payer is contracted through, read off the name. Null where the payer pays direct. */
  viaPsao: "HMA" | null;
};

const PSAO = /\(\s*HMA\s*\)|\bvia HMA\b|\bHMA\b/i;

export function parsePayerListing(text: string): ListingRow[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const cols = Object.keys(rows[0]);
  const nameCol = cols.find((c) => /payer|pbm|plan|name/i.test(c) && !/bin/i.test(c)) ?? cols[0];
  const binCol = cols.find((c) => /bin/i.test(c)) ?? cols[1];
  const out: ListingRow[] = [];
  for (const r of rows) {
    const rawName = (r[nameCol] ?? "").trim();
    const bin = (r[binCol] ?? "").replace(/\D/g, "");
    // A totals line, or a row with no BIN, is not a payer.
    if (!rawName || /^_?totals?$/i.test(rawName) || bin.length !== 6) continue;
    out.push({ bin, rawName, cleanName: rawName.replace(PSAO, "").replace(/\s{2,}/g, " ").replace(/[\s,\-–]+$/, "").trim(), viaPsao: PSAO.test(rawName) ? "HMA" : null });
  }
  return out;
}

export type Reconciled = {
  /** BINs the crosswalk does not carry: to add, named from the listing. */
  add: (ListingRow & { canonical: string })[];
  /** BINs the crosswalk carries under the same payer: the listing's spelling kept as an alias. */
  same: (ListingRow & { canonical: string })[];
  /** BINs the crosswalk carries under a different payer: a person decides which record is stale. */
  conflict: (ListingRow & { canonical: string; listedAs: string })[];
};

export function reconcileListing(rows: ListingRow[], existing: { bin: string; pbmName: string }[], canonical: (label: string) => string): Reconciled {
  const byBin = new Map<string, Set<string>>();
  for (const e of existing) byBin.set(e.bin, (byBin.get(e.bin) ?? new Set()).add(e.pbmName));
  const out: Reconciled = { add: [], same: [], conflict: [] };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const r of rows) {
    const c = canonical(r.cleanName) || r.cleanName;
    const held = byBin.get(r.bin);
    if (!held) out.add.push({ ...r, canonical: c });
    else if ([...held].some((h) => norm(h) === norm(c) || norm(h).includes(norm(c)) || norm(c).includes(norm(h)))) out.same.push({ ...r, canonical: c });
    else out.conflict.push({ ...r, canonical: c, listedAs: [...held].join(" / ") });
  }
  return out;
}
