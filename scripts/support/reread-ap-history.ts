import "dotenv/config";
/* Reads the AP Transaction History that arrived before its reader existed, through the reader, and says so on the inbox row. */
async function main() {
  const { db, schema } = await import("../../src/db");
  const { eq, like, and } = await import("drizzle-orm");
  const { readFile } = await import("../../src/lib/files");
  const { readApHistory, looksLikeApHistory } = await import("../../src/lib/ap-history");
  const { storeSupplierStatement } = await import("../../src/lib/supplier-statement-store");
  const items = await db.query.inboxItems.findMany({ where: and(like(schema.inboxItems.subject, "%Transaction History%"), eq(schema.inboxItems.routedAs, "unrecognised")) });
  for (const it of items) {
    if (!it.documentId) continue;
    const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, it.documentId) });
    if (!doc) continue;
    const text = (await readFile(doc.storageKey)).toString("utf8");
    if (!looksLikeApHistory(text.slice(0, 4096))) {
      const says = "A totals sheet from a report whose detail is read separately. Filed, and deliberately not read — the same money added up is not more of it.";
      await db.update(schema.inboxItems).set({ routedAs: "report_summary", routeResult: says, imported: null }).where(eq(schema.inboxItems.id, it.id));
      console.log(`${it.fileName}: totals sheet`);
      continue;
    }
    const read = readApHistory(text, it.receivedAt.slice(0, 10));
    const r = await storeSupplierStatement(read, doc.id);
    const says = `${r.says}${read.unreadable.length ? ` ${read.unreadable.length} rows could not be read.` : ""}`;
    await db.update(schema.inboxItems).set({ routedAs: "ap_history", routeResult: says, imported: r.written + r.updated > 0 }).where(eq(schema.inboxItems.id, it.id));
    console.log(`${it.fileName}: ${says}`);
  }
  const { replaceUnplaced, lastStatementLines } = await import("../../src/app/(app)/money/bank");
  const user = await db.query.users.findFirst({ columns: { id: true, name: true } });
  const r = await replaceUnplaced(["2026-09"], user!);
  console.log(`${r.tried} re-placed: ${r.said}`);
  const { unplaced } = await lastStatementLines(["2026-09"]);
  console.log(`still open: ${unplaced.length}`);
  for (const u of unplaced.sort((a, b) => a.on.localeCompare(b.on))) console.log(`   ${u.on} ${(u.amountCents / 100).toFixed(2).padStart(11)}  ${u.description.slice(0, 40)}  ${(u.why ?? "").slice(0, 90)}`);
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 900)); process.exit(1); });
