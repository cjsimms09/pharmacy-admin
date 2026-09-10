import "server-only";
import { db, schema } from "@/db";
import { readZip } from "./zip-read";
import { parseDirectoryProducts, parseDirectoryPackages, parseOrangeBook, buildDirectory, packageUnits, fdaClassification, type DrugDirectoryRow } from "./drug-directory";
import { newId } from "./crypto";

/**
 * The drug directory, fetched, loaded and held.
 *
 * Two free federal files, refreshed weekly like NADAC: the NDC Directory (every marketed package,
 * with ingredient, strength, form, route, labeler and application) and the Orange Book (every
 * approved product's therapeutic equivalence code). Both are zips; both are read in memory and
 * replaced whole, because each is a complete listing rather than a delta and a stale row left
 * behind would be a package that no longer exists.
 *
 * The addresses are the FDA's current ones and are settings-free on purpose: when the FDA moves a
 * file the load fails by name on the feeds page, and a file can always be loaded by hand from the
 * same screen through exactly the same reader.
 */
export const NDC_DIRECTORY_URL = "https://www.accessdata.fda.gov/cder/ndctext.zip";
export const ORANGE_BOOK_URL = "https://www.fda.gov/media/76860/download";

export type DirectoryLoad = { ok: true; rows: number; products: number; packages: number; orangeBook: number; rated: number } | { ok: false; why: string };

const decode = (b: Buffer) => b.toString("latin1");

function pick(entries: { name: string; data: Buffer }[], file: string): Buffer | null {
  const hit = entries.find((e) => e.name.toLowerCase().endsWith(file));
  return hit ? hit.data : null;
}

/** Loads both files from their zips, replacing every row. Either zip may be omitted to keep what is held for it. */
export async function loadDrugDirectory(files: { ndcDirectoryZip?: Buffer; orangeBookZip?: Buffer }, by: { userId: string | null; origin: string }): Promise<DirectoryLoad> {
  let products: ReturnType<typeof parseDirectoryProducts> | null = null;
  let packages: ReturnType<typeof parseDirectoryPackages> | null = null;
  let orangeBook: ReturnType<typeof parseOrangeBook> | null = null;
  try {
    if (files.ndcDirectoryZip) {
      const entries = readZip(files.ndcDirectoryZip);
      const productTxt = pick(entries, "product.txt");
      const packageTxt = pick(entries, "package.txt");
      if (!productTxt || !packageTxt) return { ok: false, why: `The NDC Directory zip holds ${entries.map((e) => e.name).join(", ") || "nothing"}; product.txt and package.txt were expected.` };
      products = parseDirectoryProducts(decode(productTxt));
      packages = parseDirectoryPackages(decode(packageTxt));
      if (products.length < 1000 || packages.length < 1000) return { ok: false, why: `The NDC Directory read ${products.length} products and ${packages.length} packages; the real file carries tens of thousands of each, so this is not it.` };
    }
    if (files.orangeBookZip) {
      const entries = readZip(files.orangeBookZip);
      const productsTxt = pick(entries, "products.txt");
      if (!productsTxt) return { ok: false, why: `The Orange Book zip holds ${entries.map((e) => e.name).join(", ") || "nothing"}; products.txt was expected.` };
      orangeBook = parseOrangeBook(decode(productsTxt));
      if (orangeBook.length < 1000) return { ok: false, why: `The Orange Book read ${orangeBook.length} products; the real file carries tens of thousands, so this is not it.` };
    }
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : "The file could not be read." };
  }
  if (!products && !orangeBook) return { ok: false, why: "Nothing to load." };

  /*
   * Whichever file did not arrive this time is rebuilt from what is held, so a refresh of one
   * file alone never blanks the other's contribution. The Orange Book is rebuilt from the held
   * rows' codes only where the directory itself is not being replaced.
   *
   * ── Read only where a branch actually needs it, and only the columns that branch uses ──
   *
   * This read all 217,773 rows with every column, unconditionally, before deciding which of three
   * paths to take — and **the common path does not use them at all**. `fetchDrugDirectory` pulls
   * both zips from the FDA, so both files are present, so nothing has to be rebuilt from what is
   * held; the weekly automatic refresh took about 106 MB of rows out of the database and dropped
   * them on the floor.
   *
   * That matters here more than almost anywhere else in the site. This function already holds the
   * two zips, both files decoded to text, three parsed arrays and the 217,773-row directory it is
   * building, all at once, inside the web server's own process — roughly a 430 MB peak, on a 7.3 GB
   * machine shared with the dispensing system, and V8 does not hand freed pages back promptly, so
   * the peak becomes what the process is holding for the rest of the day. See
   * `docs/audits/2026-09-08-memory.md`.
   *
   * The right answer is still to run this in a child process the operating system can reclaim
   * whole. This is the part of it that needs no such change: not reading what the branch will not
   * look at.
   */
  let rows: DrugDirectoryRow[] = [];
  if (products && packages && orangeBook) {
    // Every file arrived. Nothing is rebuilt, so nothing held is read.
    rows = buildDirectory(products, packages, orangeBook);
  } else if (products && packages) {
    // The directory is being replaced and the Orange Book is not: six columns rebuild its codes.
    const held = await db.query.drugDirectory.findMany({
      columns: { application: true, teCode: true, strength: true, substances: true, brandName: true, labeler: true },
    });
    rows = buildDirectory(products, packages, heldOrangeBook(held));
  } else if (orangeBook) {
    /*
     * Only the Orange Book arrived, so the directory itself is rebuilt from the held rows — and
     * this is the one branch that genuinely wants every column, because it is reconstructing the
     * products and packages the FDA files would have supplied.
     */
    const held = await db.query.drugDirectory.findMany();
    rows = buildDirectory(heldProducts(held), heldPackages(held), orangeBook);
  }
  if (rows.length === 0) return { ok: false, why: "The files joined to nothing: no package matched a product." };

  await db.transaction(async (tx) => {
    await tx.delete(schema.drugDirectory);
    for (let i = 0; i < rows.length; i += 500) await tx.insert(schema.drugDirectory).values(rows.slice(i, i + 500));
    if (products) await tx.insert(schema.drugDirectoryLoads).values({ id: newId(), source: "ndc_directory", origin: by.origin, rows: packages!.length, fileAsOf: null, loadedBy: by.userId });
    if (orangeBook) await tx.insert(schema.drugDirectoryLoads).values({ id: newId(), source: "orange_book", origin: by.origin, rows: orangeBook.length, fileAsOf: null, loadedBy: by.userId });
  });
  forgetDirectory();
  return { ok: true, rows: rows.length, products: products?.length ?? 0, packages: packages?.length ?? 0, orangeBook: orangeBook?.length ?? 0, rated: rows.filter((r) => r.teCode).length };
}

/** Rebuild the pieces of a held directory so one file can be refreshed without the other. */
function heldProducts(held: (typeof schema.drugDirectory.$inferSelect)[]) {
  const seen = new Map<string, ReturnType<typeof parseDirectoryProducts>[number]>();
  for (const r of held) {
    if (seen.has(r.productNdc)) continue;
    const [strength, ...unit] = r.strength.split(" ");
    seen.set(r.productNdc, {
      productNdc: r.productNdc, productType: "", brandName: r.brandName, genericName: r.genericName, form: r.form, route: r.route,
      substances: r.substances, strength, strengthUnit: unit.join(" "), labeler: r.labeler, application: r.application,
      marketingCategory: r.marketingCategory, deaSchedule: r.deaSchedule, marketedFrom: null, marketedTo: r.marketedTo, excluded: r.excluded,
    });
  }
  return [...seen.values()];
}
function heldPackages(held: (typeof schema.drugDirectory.$inferSelect)[]) {
  return held.map((r) => ({ ndc11: r.ndc11, productNdc: r.productNdc, packageDescription: r.packageDescription, marketedFrom: null, marketedTo: r.marketedTo, sample: false }));
}
type HeldForOrangeBook = Pick<typeof schema.drugDirectory.$inferSelect, "application" | "teCode" | "strength" | "substances" | "brandName" | "labeler">;

function heldOrangeBook(held: HeldForOrangeBook[]) {
  // The held code, re-expressed as one Orange Book product per application so the join finds it again.
  const out: ReturnType<typeof parseOrangeBook> = [];
  const seen = new Set<string>();
  for (const r of held) {
    const m = /^(ANDA|NDA|BLA)\s*0*(\d+)$/i.exec(r.application ?? "");
    if (!m || !r.teCode) continue;
    const key = `${m[1]}${m[2]}|${r.strength}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ applType: m[1].toUpperCase() === "ANDA" ? "A" : "N", applNo: m[2].padStart(6, "0"), productNo: "000", ingredient: r.substances, formRoute: "", tradeName: r.brandName ?? "", applicant: r.labeler, strength: r.strength, teCode: r.teCode, rld: false, approvedOn: null });
  }
  return out;
}

/** Downloads both files from the FDA and loads them. */
export async function fetchDrugDirectory(by: { userId: string | null }, fetchImpl: typeof fetch = fetch): Promise<DirectoryLoad> {
  const get = async (url: string) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(120_000), redirect: "follow" });
    if (!res.ok) throw new Error(`${url} answered ${res.status}.`);
    return Buffer.from(await res.arrayBuffer());
  };
  try {
    const [ndcDirectoryZip, orangeBookZip] = await Promise.all([get(NDC_DIRECTORY_URL), get(ORANGE_BOOK_URL)]);
    return await loadDrugDirectory({ ndcDirectoryZip, orangeBookZip }, { userId: by.userId, origin: "fda.gov" });
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : "The FDA could not be reached." };
  }
}

/* ── Held between requests: the map every grouping reads ── */

let held: { at: number; count: number; keys: Map<string, { key: string; teCode: string | null; genericName: string; strength: string; form: string; labeler: string; classification: "B" | "G" | null; otc: boolean }> } | null = null;
const MAX_AGE_MS = 10 * 60_000;

export function forgetDirectory(): void {
  held = null;
  heldPacks = null;
}

/** Every NDC's equivalence key and rating, held for ten minutes. Empty until the files are loaded. */
export async function directoryKeys(): Promise<Map<string, { key: string; teCode: string | null; genericName: string; strength: string; form: string; labeler: string; classification: "B" | "G" | null; otc: boolean }>> {
  if (held && Date.now() - held.at < MAX_AGE_MS) return held.keys;
  const rows = await db.query.drugDirectory.findMany({ columns: { ndc11: true, equivalenceKey: true, teCode: true, genericName: true, strength: true, form: true, labeler: true, marketingCategory: true } });
  // Brand or generic from the FDA's marketing category, for the NDCs NADAC does not classify.
  const keys = new Map(rows.map((r) => [r.ndc11, { key: r.equivalenceKey, teCode: r.teCode, genericName: r.genericName, strength: r.strength, form: r.form, labeler: r.labeler, ...fdaClassification(r.marketingCategory) }]));
  held = { at: Date.now(), count: rows.length, keys };
  return keys;
}

/**
 * The product an NDC belongs to, for grouping: the directory's key where the NDC is in it, else
 * the caller's fallback (a description-derived key), else nothing. The directory's key is prefixed
 * so a description key can never collide with it.
 */
export async function groupResolver(fallback: (ndc11: string) => string | null): Promise<(ndc11: string) => string | null> {
  const keys = await directoryKeys();
  return (ndc11) => {
    const d = keys.get(ndc11);
    return d ? `fda:${d.key}` : fallback(ndc11);
  };
}

export async function directoryStatus(): Promise<{ rows: number; rated: number; lastLoad: { source: string; origin: string; rows: number; loadedAt: string }[] }> {
  const client = (db as unknown as { $client: { execute: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const r = await client.execute("select count(*) as n, sum(case when te_code is null then 0 else 1 end) as rated from drug_directory");
  const loads = await db.query.drugDirectoryLoads.findMany({ orderBy: (l, { desc }) => [desc(l.loadedAt)], limit: 4 });
  return {
    rows: Number(r.rows[0]?.n ?? 0),
    rated: Number(r.rows[0]?.rated ?? 0),
    lastLoad: loads.map((l) => ({ source: l.source, origin: l.origin, rows: l.rows, loadedAt: l.loadedAt })),
  };
}

/* ── What a package holds, settled by the FDA ── */

let heldPacks: { at: number; sizes: Map<string, string> } | null = null;

export function forgetPackageSizes(): void {
  heldPacks = null;
}

/**
 * Every NDC whose package the FDA states, as the pack size the rest of the site writes.
 *
 * This is the neutral party the catalogue never had. Twenty-four wholesalers describe one box at
 * whatever height their own file uses — "1 EA", "168 EA", "(6) 28 EA" — and until now the site
 * could only report that they disagreed and ask the pharmacist to open the bottle. 998 NDCs were
 * waiting on that. The FDA's package file states the contents per package NDC, and the FDA is not
 * selling anything.
 *
 * Only packages it can state exactly: a kit, or a description in a shape the reader does not
 * recognise, is left out rather than guessed at.
 */
export async function packageSizes(): Promise<Map<string, string>> {
  if (heldPacks && Date.now() - heldPacks.at < MAX_AGE_MS) return heldPacks.sizes;
  const rows = await db.query.drugDirectory.findMany({ columns: { ndc11: true, packageDescription: true } });
  const sizes = new Map<string, string>();
  for (const r of rows) {
    const u = packageUnits(r.packageDescription ?? "");
    if (u) sizes.set(r.ndc11, `${u.units} ${u.uom}`);
  }
  heldPacks = { at: Date.now(), sizes };
  return sizes;
}
