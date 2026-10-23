import "dotenv/config";
/** Every remittance the site has received, and whether it settled anything. */
import { db, schema } from "../../src/db";
const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
async function main() {
  const pays = await db.select().from(schema.claimPayments);
  console.log(`claim payments on file: ${pays.length}`);
  const by = new Map<string, { n: number; cents: number; matched: number }>();
  for (const p of pays) {
    const e = by.get(p.source) ?? { n: 0, cents: 0, matched: 0 };
    by.set(p.source, { n: e.n + 1, cents: e.cents + p.amountCents, matched: e.matched + (p.claimId ? 1 : 0) });
  }
  for (const [s, e] of by) console.log(`   ${s.padEnd(12)} ${String(e.n).padStart(4)} payments ${money(e.cents).padStart(14)}  ${e.matched} matched`);

  const docs = await db.select().from(schema.documents);
  const remits = docs.filter((d) => /835|remit|remittance/i.test(`${d.category} ${d.title} ${d.fileName}`));
  console.log(`\ndocuments filed that look like a remittance: ${remits.length}`);
  for (const d of remits.slice(-10)) console.log(`   ${d.uploadedAt}  ${d.category}  ${d.fileName}`);
  const { getSettings } = await import("../../src/lib/settings");
  const s = await getSettings();
  console.log(`\nSFTP mailbox ${s.sftp_user}@${s.sftp_host}${s.sftp_folder}`);
  console.log(`   last checked: ${s.sftp_last_result || "never"}`);
}
main().then(() => process.exit(0));
