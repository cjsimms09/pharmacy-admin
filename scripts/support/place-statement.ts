import "dotenv/config";

/**
 * Places September's statement with the one figure the scan dropped, then lists what did not match.
 *
 * The figure is not typed in: it is taken from the solver, which proves the 25th is short by exactly
 * one amount and finds exactly one line that day with none. Confirming it is reading the page's own
 * arithmetic back to it. Run again, it writes nothing: every line is keyed and already held.
 */
async function main(): Promise<void> {
  const fileName = process.argv[2] ?? "9-2026_8855.pdf";
  const { db, schema } = await import("../../src/db");
  const { eq } = await import("drizzle-orm");
  const { readFile } = await import("../../src/lib/files");
  const { scanItemsForDocument } = await import("../../src/lib/ocr");
  const { readRaw } = await import("../../src/lib/scanned-bank-statement");
  const { solveStatement } = await import("../../src/lib/scanned-bank-solve");
  const { storeScannedStatement, lastStatementLines } = await import("../../src/app/(app)/money/bank");

  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.fileName, fileName) });
  if (!doc) throw new Error(`no document named ${fileName}`);
  const user = await db.query.users.findFirst({ columns: { id: true, name: true } });
  if (!user) throw new Error("no user");

  const raw = readRaw(await scanItemsForDocument(doc.id, await readFile(doc.storageKey)));
  const first = solveStatement(raw, { known: [], confirmed: {} });
  const confirmed: Record<number, number> = {};
  if (first.ok) {
    for (const u of first.unproven) {
      const blank = u.lines.filter((l) => !l.amountText.trim());
      if (blank.length === 1 && u.differenceCents < 0) {
        confirmed[blank[0].index] = Math.abs(u.differenceCents);
        console.log(`confirming line ${blank[0].index} on ${u.from} as $${(Math.abs(u.differenceCents) / 100).toFixed(2)} — the one line that day with no amount, and the day's exact shortfall`);
      } else {
        console.log(`NOT confirming ${u.from}: ${blank.length} blank lines, difference ${u.differenceCents}`);
      }
    }
  }

  const r = await storeScannedStatement(doc.id, confirmed, user);
  if (!r.ok) {
    console.log(`NOT PLACED: ${r.why}`);
    return;
  }
  console.log(`\nPLACED: ${r.said}`);

  const { placed, unplaced } = await lastStatementLines(["2026-09"]);
  console.log(`\nSeptember: ${placed} placed, ${unplaced.length} not matched`);
  for (const u of unplaced.sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents))) {
    console.log(`   ${u.on}  ${(u.amountCents / 100).toFixed(2).padStart(12)}  ${u.description.slice(0, 58).padEnd(58)}  ${(u.why ?? "").slice(0, 110)}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(String(e).slice(0, 800));
    process.exit(1);
  },
);
