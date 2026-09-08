/**
 * The drug directory, proved against what the loader actually wrote.
 *
 * ── Why this one is not a nightly re-read like the others ──
 *
 * Every other proof in BACKLOG 30 re-reads its stored file each night. For the directory that
 * would be the most expensive thing on the machine: a 430 MB peak, on 7.3 GB that ran out twice on
 * 8 September, every night, to prove two files the FDA changes once a week.
 *
 * So the loader proves it instead. At the moment `loadDrugDirectory` writes, it is holding the
 * parsed products, the parsed packages, the joined rows and the bytes of both zips — the whole
 * measurement, already in hand, for nothing. It stamps that into a setting and this reads it back
 * and sets it against what the table holds today.
 *
 * That makes this proof stronger than a re-read in one way and weaker in another, and both are
 * worth saying out loud. Stronger, because it measures the source at the instant it was believed
 * rather than a file on disk that may since have been replaced. Weaker, because it cannot notice
 * the FDA changing the file — only that the table still matches what was last loaded from it.
 *
 * The staleness is the other half. The date is the load's, so a weekly fetch that quietly stopped
 * shows here as an ageing proof over a directory whose counts are all perfectly correct — which is
 * precisely the failure a nightly re-read would have papered over by refreshing the date.
 *
 * Pure. The writing is in `drug-directory-store.ts`.
 */
import type { DirectoryProof } from "./drug-directory-store";

export type { DirectoryProof };

/** How long a directory may go unrefreshed before the row says so. The FDA publishes weekly. */
export const DIRECTORY_STALE_DAYS = 10;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

function mark(v: unknown): { bytes: number; sha256: string } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const bytes = num(o.bytes);
  const sha256 = str(o.sha256);
  return bytes === null || sha256 === null ? null : { bytes, sha256 };
}

/** Reads the setting, or null where no load has ever proved itself. */
export function parseDirectoryProof(raw: string | undefined | null): DirectoryProof | null {
  if (!raw) return null;
  let j: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    j = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const wrote = (j.wrote ?? {}) as Record<string, unknown>;
  const rows = num(wrote.rows);
  // A proof that cannot say how many rows it wrote proves nothing, and is not a proof of zero.
  if (rows === null) return null;
  const parsedCounts = (j.parsed ?? {}) as Record<string, unknown>;
  const files = (j.files ?? {}) as Record<string, unknown>;
  return {
    provedOn: str(j.provedOn) ?? "",
    parsed: { products: num(parsedCounts.products), packages: num(parsedCounts.packages), orangeBook: num(parsedCounts.orangeBook) },
    wrote: { rows, rated: num(wrote.rated) ?? 0 },
    origin: str(j.origin) ?? "an unrecorded source",
    files: { ndcDirectory: mark(files.ndcDirectory), orangeBook: mark(files.orangeBook) },
  };
}

/**
 * Calendar days between the load and today, or null where the proof carries no usable date.
 *
 * Days, not elapsed hours. Flooring the interval made a directory loaded at seven in the morning
 * on the 8th read as nought days old on the 9th, and — the case that matters — one loaded late on
 * a Monday read as nine days old on the second Wednesday rather than ten, so it slipped under the
 * allowance for a day. Staleness is a question about dates and is answered in dates, which is also
 * what the rest of the site means by a day.
 */
export function proofAgeDays(p: DirectoryProof, today: string): number | null {
  const a = Date.parse(`${p.provedOn.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * The fraction: rows the table holds now, out of rows the loader says it wrote.
 *
 * Both directions are covered by one number here, unlike the claims proof, because there is only
 * one place a directory row can come from. Fewer rows than were written means something removed
 * them; more means something added rows the loader never wrote. Either way the table is not what
 * the FDA's file says, and the numerator is capped so the second case reads as a fault rather than
 * as a hundred and three per cent.
 */
export function directoryProofFraction(p: DirectoryProof, tableRows: number): { numerator: number; denominator: number } {
  return { numerator: Math.min(tableRows, p.wrote.rows), denominator: Math.max(p.wrote.rows, tableRows) };
}

export function directoryProofGaps(p: DirectoryProof, tableRows: number, today: string): string[] {
  const gaps: string[] = [];
  const n = (x: number) => x.toLocaleString("en-US");
  if (tableRows !== p.wrote.rows) {
    const by = tableRows - p.wrote.rows;
    gaps.push(
      by < 0
        ? `The last load wrote ${n(p.wrote.rows)} packages and the table holds ${n(tableRows)} — ${n(-by)} fewer than were written. Something has removed rows since.`
        : `The last load wrote ${n(p.wrote.rows)} packages and the table holds ${n(tableRows)} — ${n(by)} more than were written. Something has added rows the loader did not.`,
    );
  }
  const age = proofAgeDays(p, today);
  if (age !== null && age > DIRECTORY_STALE_DAYS) {
    gaps.push(
      `The directory was last loaded ${age} days ago. The FDA publishes weekly, so the counts here can be perfectly correct and the contents ${age} days out of date.`,
    );
  }
  /*
   * A load of one file only is a fact worth printing, not a fault.
   *
   * Either zip may be refreshed alone, and the other's contribution is rebuilt from what is held.
   * That is correct, and it also means the packages in the table may be older than this proof's
   * date — so the date alone would overstate how fresh the directory is.
   */
  if (p.parsed.products === null && p.parsed.orangeBook !== null) {
    gaps.push("The last load refreshed the Orange Book alone; the packages were rebuilt from what was already held, so they are older than this proof's date.");
  }
  if (p.parsed.orangeBook === null && p.parsed.products !== null) {
    gaps.push("The last load refreshed the NDC Directory alone; the therapeutic equivalence codes were carried forward from what was already held.");
  }
  return gaps;
}

export function directoryProofNote(p: DirectoryProof, tableRows: number): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const bits: string[] = [];
  if (p.parsed.products !== null && p.parsed.packages !== null) {
    bits.push(`${n(p.parsed.products)} products and ${n(p.parsed.packages)} packages read from the NDC Directory`);
  }
  if (p.parsed.orangeBook !== null) bits.push(`${n(p.parsed.orangeBook)} Orange Book products`);
  const joined =
    bits.length > 0
      ? `${bits.join(" and ")} joined to ${n(p.wrote.rows)} rows, ${n(p.wrote.rated)} of them with a rating.`
      : `${n(p.wrote.rows)} rows written, ${n(p.wrote.rated)} of them with a rating.`;
  const held = tableRows === p.wrote.rows ? " The table holds exactly that." : ` The table holds ${n(tableRows)}.`;
  /*
   * The file's own fingerprint, shortened.
   *
   * Twelve characters of a sha256 is enough to tell two files apart by eye and short enough to sit
   * on a row. It answers the question the row cannot otherwise answer: whether an unchanged count
   * means nothing changed, or means the same file was loaded a second time.
   */
  const fingerprint = p.files.ndcDirectory
    ? ` The directory zip was ${(p.files.ndcDirectory.bytes / 1_048_576).toFixed(1)} MB, ${p.files.ndcDirectory.sha256.slice(0, 12)}.`
    : "";
  return `Loaded from ${p.origin} on ${p.provedOn.slice(0, 10) || "an unrecorded day"}: ${joined}${held}${fingerprint}`;
}
