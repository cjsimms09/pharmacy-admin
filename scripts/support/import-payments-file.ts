import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
/* Reads a ProviderPay Payments export the owner dropped in, through the same door the sweep uses, and says what the gate did. */
async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("file?");
  const { db } = await import("../../src/db");
  const { importPayerPayments } = await import("../../src/lib/payer-payments-store");
  const user = await db.query.users.findFirst({ columns: { id: true, name: true } });
  if (!user) throw new Error("no user");
  const r = await importPayerPayments(readFileSync(file, "utf8"), { userId: user.id, userName: user.name, fileName: basename(file) });
  if (!r.ok) { console.log("NOT READ:", r.why); return; }
  console.log(`banked ${r.banked} ($${(r.bankedCents / 100).toFixed(2)}), already held ${r.alreadyHeld}, ${r.from}..${r.to}`);
  for (const x of r.refused) console.log("   refused:", String(x).replace(/\d{6,}/g, "#").slice(0, 200));
  for (const s of r.skipped) console.log("   skipped:", JSON.stringify(s).slice(0, 160));
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 600)); process.exit(1); });
