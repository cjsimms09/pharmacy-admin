import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * Files a wholesaler's statement of account the owner dropped in by hand, keeps its lines, and re-places the month.
 *
 *   tsx scripts/support/keep-statement.ts <month> <pdf>…
 */
async function main(): Promise<void> {
  const [month, ...files] = process.argv.slice(2);
  if (!month || files.length === 0) throw new Error("month and at least one PDF");
  const { db, schema } = await import("../../src/db");
  const { eq } = await import("drizzle-orm");
  const { storeFile } = await import("../../src/lib/files");
  const { newId } = await import("../../src/lib/crypto");
  const { pdfText } = await import("../../src/lib/pdf-text");
  const { readSupplierStatement } = await import("../../src/lib/supplier-statement");
  const { storeSupplierStatement } = await import("../../src/lib/supplier-statement-store");
  const { replaceUnplaced, lastStatementLines } = await import("../../src/app/(app)/money/bank");
  const user = await db.query.users.findFirst({ columns: { id: true, name: true } });
  if (!user) throw new Error("no user");

  for (const f of files) {
    const buf = readFileSync(f);
    const name = basename(f).replace(/^[0-9a-f]{8}-/, "");
    const stored = await storeFile(new File([buf], name, { type: "application/pdf" }), { allowReportTypes: true });
    const twin = await db.query.documents.findFirst({ where: eq(schema.documents.sha256, stored.sha256), columns: { id: true } });
    const read = readSupplierStatement(pdfText(buf));
    const docId = twin?.id ?? newId();
    if (!twin) {
      await db.insert(schema.documents).values({
        id: docId,
        category: "supplier_statement",
        title: `${read.supplier ?? "Supplier"} statement of account as of ${read.statementDate ?? "?"} (${read.accountNumber ? "account …" + read.accountNumber.slice(-3) : "account unknown"})`,
        fileName: name,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        storageKey: stored.storageKey,
        notes: "Dropped in by the owner on 1 October 2026.",
        uploadedBy: user.id,
      });
    }
    const kept = await storeSupplierStatement(read, docId);
    console.log(`${name}: ${kept.says}${read.unreadable.length ? ` UNREADABLE: ${read.unreadable.map((u) => u.replace(/\d{6,}/g, "#")).join(" | ")}` : ""}`);
  }
  const r = await replaceUnplaced([month], user);
  console.log(`${r.tried} re-placed: ${r.said}`);
  const { unplaced } = await lastStatementLines([month]);
  console.log(`still open: ${unplaced.length}`);
  for (const u of unplaced.sort((a, b) => a.on.localeCompare(b.on))) console.log(`   ${u.on} ${(u.amountCents / 100).toFixed(2).padStart(11)}  ${u.description.slice(0, 40)}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(String(e).slice(0, 900));
    process.exit(1);
  },
);
