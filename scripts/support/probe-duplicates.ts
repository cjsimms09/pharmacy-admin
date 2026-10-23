/**
 * Runs the real counting half of the duplicate clean-up against the real database, and touches nothing.
 *
 * `duplicateInvoiceDocuments()` and `removeDuplicateInvoiceDocuments()` both call the same private
 * `plan()`, so what this prints is exactly what the button would delete. Read-only by construction:
 * this file never imports the removal.
 */
import "dotenv/config";

async function main() {
  const { duplicateInvoiceDocuments } = await import("../../src/lib/duplicate-documents-store");
  const r = await duplicateInvoiceDocuments();
  console.log(`removable: ${r.removable} rows, across ${r.files} distinct files`);
  console.log("drawers:");
  for (const d of r.drawers) console.log(`  ${d.category}: ${d.rows} rows / ${d.files} files`);
  console.log("kept:");
  for (const k of r.keptBecause) console.log(`  ${k.count}  ${k.reason}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
