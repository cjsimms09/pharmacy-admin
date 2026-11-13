import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Reads a scanned bank statement end to end: OCR, then the statement reader, then the solver.
 *
 * The OCR words are cached beside the model so a second run of the reader does not pay for the
 * recognition again — thirteen pages take minutes, the reading takes milliseconds.
 */
async function main(): Promise<void> {
  const fileName = process.argv[2] ?? "9-2026_8855.pdf";
  const { db, schema } = await import("../../src/db");
  const { eq } = await import("drizzle-orm");
  const { readFile } = await import("../../src/lib/files");
  const { scanItemsFromScannedPdf } = await import("../../src/lib/ocr");
  const { readRaw, rowsOf } = await import("../../src/lib/scanned-bank-statement");
  const { solveStatement } = await import("../../src/lib/scanned-bank-solve");

  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.fileName, fileName) });
  if (!doc) {
    console.log(`no document named ${fileName}`);
    return;
  }
  mkdirSync("./data/ocr", { recursive: true });
  const cache = `./data/ocr/${doc.id}.items.json`;
  let items;
  if (existsSync(cache)) {
    items = JSON.parse(readFileSync(cache, "utf8"));
    console.log(`items from cache: ${items.length}`);
  } else {
    const t0 = Date.now();
    const r = await scanItemsFromScannedPdf(await readFile(doc.storageKey), (i, n) => console.log(`  page ${i} of ${n}  (${((Date.now() - t0) / 1000).toFixed(0)}s, rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB)`));
    items = r.items;
    writeFileSync(cache, JSON.stringify(items));
    console.log(`pages ${r.pages}, words ${r.words}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  const rows = rowsOf(items);
  console.log(`\nrows: ${rows.length} across ${new Set(rows.map((r) => r.page)).size} pages`);
  const show = (page: number, n: number) =>
    rows
      .filter((r) => r.page === page)
      .slice(0, n)
      .forEach((r) => console.log(`   p${r.page} y=${r.y.toFixed(0)}  ${r.cells.map((c) => `[${c.x.toFixed(0)}]${c.text}`).join(" ")}`.slice(0, 180)));
  console.log("first page, first 18 rows:");
  show(1, 18);

  const raw = readRaw(items);
  console.log(`\nsummary: ${JSON.stringify(raw.summary)}`);
  const bySection: Record<string, number> = {};
  for (const l of raw.lines) bySection[l.section] = (bySection[l.section] ?? 0) + 1;
  console.log(`lines by section: ${JSON.stringify(bySection)}  balances: ${raw.balances.length}`);

  const solved = solveStatement(raw, { known: [], confirmed: {} });
  if (!solved.ok) {
    console.log(`\nNOT SOLVED: ${solved.why}`);
    return;
  }
  console.log(`\nSOLVED: ${solved.lines.length} lines, unproven stretches ${solved.unproven.length}`);
  for (const n of solved.notes ?? []) console.log("   note: " + n);
  for (const u of solved.unproven.slice(0, 8)) console.log(`   unproven ${u.from}..${u.to}: ${JSON.stringify(u).slice(0, 200)}`);
  const sum = (sign: 1 | -1) => solved.lines.filter((l) => Math.sign(l.amountCents) === sign).reduce((n, l) => n + l.amountCents, 0);
  console.log(`   in ${(sum(1) / 100).toFixed(2)}  out ${(sum(-1) / 100).toFixed(2)}`);
  console.log("   first 6 lines:");
  for (const l of solved.lines.slice(0, 6)) console.log(`     ${l.on}  ${(l.amountCents / 100).toFixed(2).padStart(12)}  ${l.description.slice(0, 60)}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(String(e).slice(0, 800));
    process.exit(1);
  },
);
