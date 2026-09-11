import "server-only";
import { db, schema } from "@/db";
import { readZip } from "./zip-read";
import { parseDirectoryProducts, parseDirectoryPackages, parseOrangeBook, buildDirectory, packageUnits, fdaClassification, type DrugDirectoryRow } from "./drug-directory";
import { newId } from "./crypto";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

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

/**
 * Loads both files from their zips, replacing every row. Either zip may be omitted to keep what is held for it.
 *
 * `say` is optional and is where this reports its progress. It runs for a minute or more on the
 * real files, and a screen that shows nothing for a minute is one the owner presses again.
 */
export async function loadDrugDirectory(
  files: { ndcDirectoryZip?: Buffer; orangeBookZip?: Buffer },
  by: { userId: string | null; origin: string },
  say: (text: string) => void = () => {},
): Promise<DirectoryLoad> {
  let products: ReturnType<typeof parseDirectoryProducts> | null = null;
  let packages: ReturnType<typeof parseDirectoryPackages> | null = null;
  let orangeBook: ReturnType<typeof parseOrangeBook> | null = null;
  try {
    if (files.ndcDirectoryZip) {
      say("Reading the NDC Directory");
      const entries = readZip(files.ndcDirectoryZip);
      const productTxt = pick(entries, "product.txt");
      const packageTxt = pick(entries, "package.txt");
      if (!productTxt || !packageTxt) return { ok: false, why: `The NDC Directory zip holds ${entries.map((e) => e.name).join(", ") || "nothing"}; product.txt and package.txt were expected.` };
      products = parseDirectoryProducts(decode(productTxt));
      packages = parseDirectoryPackages(decode(packageTxt));
      if (products.length < 1000 || packages.length < 1000) return { ok: false, why: `The NDC Directory read ${products.length} products and ${packages.length} packages; the real file carries tens of thousands of each, so this is not it.` };
    }
    if (files.orangeBookZip) {
      say("Reading the Orange Book");
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
   */
  /*
   * Read only when something held is wanted, and only the columns that path actually rebuilds from.
   *
   * This read every row and every column unconditionally — 217,773 rows, eighteen columns, 106 MB —
   * including on the ordinary path where both files arrived and nothing held is needed at all. A's
   * memory audit puts that read and its three derivations at 178 MB of a 430 MB peak, inside the
   * web server's own process, on a machine with 7.3 GB.
   *
   * One correction to the audit, which recommends five columns whenever it is read: five is right
   * for one of the two paths and would break the other. `heldOrangeBook` wants the application, the
   * TE code and enough to name the product; `heldProducts` rebuilds a whole product row and wants
   * nearly everything. So the columns follow the path rather than a single list:
   *
   *   both files          nothing held is needed — no read at all, which is the common case
   *   directory, no OB    the held TE codes are carried forward — the narrow read
   *   OB alone            the directory is rebuilt from what is held — the wide read
   */
  if (!products && orangeBook) say("Rebuilding the packages already held, so a rating refresh does not blank them");
  const needOrangeBookOnly = Boolean(products && packages && !orangeBook);
  const needEverything = Boolean(!products && orangeBook);
  const held = needEverything
    ? await db.query.drugDirectory.findMany()
    : needOrangeBookOnly
      ? await db.query.drugDirectory.findMany({
          columns: { application: true, teCode: true, strength: true, substances: true, brandName: true, labeler: true },
        })
      : [];
  const rows: DrugDirectoryRow[] =
    products && packages
      ? buildDirectory(products, packages, orangeBook ?? heldOrangeBook(held as (typeof schema.drugDirectory.$inferSelect)[]))
      : orangeBook
        ? buildDirectory(heldProducts(held as (typeof schema.drugDirectory.$inferSelect)[]), heldPackages(held as (typeof schema.drugDirectory.$inferSelect)[]), orangeBook)
        : [];
  if (rows.length === 0) return { ok: false, why: "The files joined to nothing: no package matched a product." };

  say(`Writing ${rows.length.toLocaleString()} packages`);
  await db.transaction(async (tx) => {
    await tx.delete(schema.drugDirectory);
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(schema.drugDirectory).values(rows.slice(i, i + 500));
      // Every twenty thousand, so the page moves without the parent writing a settings row per slice.
      if (i > 0 && i % 20_000 === 0) say(`Writing ${rows.length.toLocaleString()} packages — ${i.toLocaleString()} so far`);
    }
    if (products) await tx.insert(schema.drugDirectoryLoads).values({ id: newId(), source: "ndc_directory", origin: by.origin, rows: packages!.length, fileAsOf: null, loadedBy: by.userId });
    if (orangeBook) await tx.insert(schema.drugDirectoryLoads).values({ id: newId(), source: "orange_book", origin: by.origin, rows: orangeBook.length, fileAsOf: null, loadedBy: by.userId });
  });
  forgetDirectory();
  const rated = rows.filter((r) => r.teCode).length;

  /*
   * ── The proof, written here because here is the only place it is free ──
   *
   * BACKLOG 30 wants every dataset set against the file behind it. For the directory the obvious
   * way — re-read the two zips nightly and count — is the most expensive thing on the machine: it
   * is the 430 MB peak, on 7.3 GB that ran out twice on 8 September, every night, to prove a file
   * the FDA changes once a week.
   *
   * At this point in the load, all of it is already in hand. The parsed counts, the joined rows,
   * the bytes of both zips: nothing has to be read again, and the measurement is closer to the
   * source than any later re-read could be, because it is the source. So the loader says what it
   * parsed and what it wrote, and the row sets that against what the table holds today.
   *
   * The date is the load's, which is the second half of it. A weekly fetch that silently stops
   * leaves this proof ageing where somebody can see it, and an old proof over a directory that
   * still counts correctly is exactly the failure a nightly re-read would hide by refreshing.
   *
   * `sha256` and the byte counts identify the files themselves, so two loads of the same zip are
   * distinguishable from two loads of different ones — which is what says whether an unchanged row
   * count means "nothing changed" or "the same file was loaded twice".
   */
  await writeDirectoryProof({
    parsed: { products: products?.length ?? null, packages: packages?.length ?? null, orangeBook: orangeBook?.length ?? null },
    wrote: { rows: rows.length, rated },
    origin: by.origin,
    files: {
      ndcDirectory: files.ndcDirectoryZip ? fileMark(files.ndcDirectoryZip) : null,
      orangeBook: files.orangeBookZip ? fileMark(files.orangeBookZip) : null,
    },
  });

  return { ok: true, rows: rows.length, products: products?.length ?? 0, packages: packages?.length ?? 0, orangeBook: orangeBook?.length ?? 0, rated };
}

/** A file's identity without keeping the file: how big it was and what it hashed to. */
function fileMark(buf: Buffer): { bytes: number; sha256: string } {
  return { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}

/**
 * Records what this load parsed and wrote, for the Data health row to set against the table.
 *
 * Never allowed to fail the load. A directory that loaded and could not write its own proof is a
 * directory that loaded; refusing it because the bookkeeping failed would be the tail wagging the
 * dog, and the row says "not proved" which is true and visible.
 */
async function writeDirectoryProof(p: Omit<DirectoryProof, "provedOn">): Promise<void> {
  try {
    const { setSetting } = await import("./settings");
    await setSetting("drug_directory_proof", JSON.stringify({ ...p, provedOn: new Date().toISOString() } satisfies DirectoryProof));
  } catch {
    // The load stands. The row will say it is unproved, which is the honest answer.
  }
}

/** What the loader knew at the moment it wrote. The shape `data-health-directory-proof.ts` reads. */
export type DirectoryProof = {
  /** ISO datetime of the load. Its age is the age of the last successful fetch or hand-load. */
  provedOn: string;
  /** Null where that file was not part of this load, which is not the same as it having no rows. */
  parsed: { products: number | null; packages: number | null; orangeBook: number | null };
  wrote: { rows: number; rated: number };
  origin: string;
  files: { ndcDirectory: { bytes: number; sha256: string } | null; orangeBook: { bytes: number; sha256: string } | null };
};

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
  /*
   * Rebuilt from the stored copy, which does not carry every column the FDA file has.
   *
   * `sample` and `marketedFrom` are not stored, so they come back null — unknown — rather than
   * as a confident false and a confident nothing. A rebuild that invents an answer is worse than
   * one that admits the column is missing, because the invention is indistinguishable from a
   * measurement.
   */
  return held.map((r) => ({ ndc11: r.ndc11, productNdc: r.productNdc, packageDescription: r.packageDescription, marketedFrom: null, marketedTo: r.marketedTo, sample: null }));
}
function heldOrangeBook(held: (typeof schema.drugDirectory.$inferSelect)[]) {
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

/**
 * Downloads both files from the FDA and loads them, here, in whatever process calls it.
 *
 * This is the work itself and the child process runs exactly this. Nothing in the web server should
 * call it: `fetchDrugDirectory` below is the door, and it spawns.
 */
export async function fetchDrugDirectoryHere(
  by: { userId: string | null },
  opts: { fetchImpl?: typeof fetch; say?: (text: string) => void } = {},
): Promise<DirectoryLoad> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const say = opts.say ?? (() => {});
  const get = async (url: string) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(120_000), redirect: "follow" });
    if (!res.ok) throw new Error(`${url} answered ${res.status}.`);
    return Buffer.from(await res.arrayBuffer());
  };
  try {
    say("Downloading ndctext.zip and the Orange Book from fda.gov");
    const [ndcDirectoryZip, orangeBookZip] = await Promise.all([get(NDC_DIRECTORY_URL), get(ORANGE_BOOK_URL)]);
    return await loadDrugDirectory({ ndcDirectoryZip, orangeBookZip }, { userId: by.userId, origin: "fda.gov" }, say);
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : "The FDA could not be reached." };
  }
}

/** Where the child process lives, or null where this machine cannot run one. */
export function directoryProcessPlan(
  root: string,
  userId: string,
  exists: (f: string) => boolean = (f) => fsSync.existsSync(f),
): { command: string; args: string[] } | null {
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const script = path.join(root, "scripts", "load-drug-directory.ts");
  const tsconfig = path.join(root, "tsconfig.script.json");
  if (!exists(tsx) || !exists(script) || !exists(tsconfig)) return null;
  return { command: process.execPath, args: [tsx, "--tsconfig", tsconfig, script, userId] };
}

/**
 * Downloads both files from the FDA and loads them, in a process of its own.
 *
 * A's memory audit measured this function at a 430 MB peak — eight full-size copies of the
 * directory alive at once — and then 217,773 rows inserted in slices inside a transaction, all on
 * the event loop of the web server. V8 does not hand freed pages back promptly, so that peak became
 * the site's resident figure and stayed there. On 8 September the pharmacy's machine ran out of
 * memory twice with the owner at the counter.
 *
 * A child process fixes it completely, because the operating system takes the memory back when the
 * process exits. It is the treatment `scripts/make-claude-copy.ts` and `scripts/import-claims.ts`
 * already demonstrate, and this is the largest thing in the site that had not had it.
 *
 * `onStep` is fed the child's own progress lines, so a page can show where it has got to rather
 * than showing nothing for two minutes.
 *
 * Where the child cannot be started — no tsx, no script — the work runs here rather than not at
 * all, and says so through `onStep`. A directory that loads slowly beats one that never loads.
 */
export async function fetchDrugDirectory(
  by: { userId: string | null },
  opts: { onStep?: (text: string) => void | Promise<void> } = {},
): Promise<DirectoryLoad> {
  const plan = directoryProcessPlan(process.cwd(), by.userId ?? "scheduler");
  if (!plan) {
    await opts.onStep?.("Loading in the web server (the loader process could not be started)");
    return fetchDrugDirectoryHere(by);
  }

  const { spawn } = await import("node:child_process");
  return await new Promise<DirectoryLoad>((resolve) => {
    const child = spawn(plan.command, plan.args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let carried = "";
    let stderr = "";
    let result: DirectoryLoad | undefined;
    /*
     * Steps are written one after another rather than all at once.
     *
     * `onStep` writes a settings row, and four of those started together finish in whatever order
     * the database returns them, which shows the page a step it has already passed. Chaining them
     * costs nothing here — the child is doing the work — and the page only ever goes forwards.
     */
    let pending: Promise<void> = Promise.resolve();
    const say = (text: string) => {
      pending = pending.then(() => opts.onStep?.(text)).then(
        () => {},
        () => {},
      );
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const r = readDirectoryLines(carried, chunk);
      carried = r.carried;
      for (const m of r.messages) {
        if (m.step) say(m.step);
        if (m.result) result = m.result;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr = (stderr + c).slice(-2000);
    });

    // Nothing resolves until the steps already announced have been written, so the job record's
    // last step is not overwritten by one that arrived before it.
    const finish = (load: DirectoryLoad) => {
      void pending.then(() => resolve(load));
    };
    child.on("error", (e) => finish({ ok: false, why: `The directory loader could not be started: ${e.message}` }));
    child.on("close", (code) => {
      if (result) return finish(result);
      const tail = stderr.trim() ? ` It reported: ${stderr.trim().split("\n").slice(-3).join(" ")}` : "";
      finish({ ok: false, why: `The directory load stopped without saying why (exit ${code ?? "unknown"}).${tail}` });
    });
  });
}

/**
 * One JSON object per line from the child, read as it arrives.
 *
 * Its own rather than borrowed from `claude-copy-job`, which reads the same shape for a different
 * child: sharing it would put one type on two unrelated messages, and the first thing either child
 * changed would silently be a lie about the other.
 *
 * A chunk can split a line anywhere, so the tail is carried to the next call. Anything that is not
 * one of the child's own messages — a warning from a library, say — is passed over rather than
 * guessed at.
 */
export function readDirectoryLines(carried: string, chunk: string): { carried: string; messages: { step?: string; result?: DirectoryLoad }[] } {
  const lines = (carried + chunk).split("\n");
  const rest = lines.pop() ?? "";
  const messages: { step?: string; result?: DirectoryLoad }[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as { step?: string; result?: DirectoryLoad };
      if (m && (typeof m.step === "string" || m.result)) messages.push(m);
    } catch {
      // Not ours to interpret.
    }
  }
  return { carried: rest, messages };
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

let heldKnown: { at: number; set: Set<string> } | null = null;

export function forgetKnownNdcs(): void {
  heldKnown = null;
}

/**
 * Whether an eleven-digit code is a drug the FDA lists.
 *
 * The invoice reader needs a neutral party for one job it cannot do from the page alone: McKesson
 * prints front-end items with a UPC, a UPC is a prefix digit plus the ten-digit NDC, and the
 * ten-digit form can be padded back to eleven in three places. Only one of the three is a drug.
 * See `ndcFromUpc` in invoice-lines.ts, which does the padding and asks this which one landed.
 *
 * Handed in as a function so that file keeps knowing nothing about the database — it reads paper,
 * and every test of it runs without one.
 */
export async function knownNdcs(): Promise<(ndc11: string) => boolean> {
  if (!heldKnown || Date.now() - heldKnown.at >= MAX_AGE_MS) {
    const rows = await db.query.drugDirectory.findMany({ columns: { ndc11: true } });
    heldKnown = { at: Date.now(), set: new Set(rows.map((r) => r.ndc11)) };
  }
  const set = heldKnown.set;
  return (ndc11: string) => set.has(ndc11);
}
