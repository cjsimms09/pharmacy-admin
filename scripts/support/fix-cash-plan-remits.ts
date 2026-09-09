import "dotenv/config";
/*
 * The claims already on file that carry a remit from a plan that never remits.
 *
 * The owner: "There is no third party remit from pharmd. Whatever the copay is is the only money we
 * receive." Three September claims held $418.22 between them. The importer now reads this correctly,
 * but rows loaded before it did are still wrong, and they are the ones in the account.
 */
import { db, schema } from "../../src/db";
import { readPayerMoney } from "../../src/lib/cash-plans";
import { eq } from "drizzle-orm";

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const apply = process.argv.includes("--apply");
  const plans = await db.query.cashPlans.findMany({ columns: { bin: true, pcn: true, name: true } });
  if (plans.length === 0) throw new Error("no cash plans on file");
  console.log(`cash plans: ${plans.map((p) => `${p.name} (BIN ${p.bin}${p.pcn ? ` PCN ${p.pcn}` : ""})`).join(", ")}\n`);

  const all = await db.select().from(schema.claims);
  let n = 0;
  let cents = 0;
  for (const c of all) {
    const r = readPayerMoney({ bin: c.bin, pcn: c.pcn, remitCents: c.remitCents, copayCents: c.copayCents }, plans);
    if (r.discountGivenCents === 0) continue;
    /*
     * Only a live claim is corrected. A reversed one is already out of revenue, and its reversal is
     * paired to it by a key built from the very figure this would change.
     */
    if (c.status !== "paid") { console.log(`Rx ${c.rxNumber}-${c.fillNumber ?? 0} left alone: status ${c.status}`); continue; }
    n++;
    cents += r.discountGivenCents;
    console.log(`Rx ${c.rxNumber}-${c.fillNumber ?? 0}  ${c.dateFilled}  ${c.itemName ?? ""}`);
    console.log(`   remit ${money(c.remitCents ?? 0)} -> $0.00, copay ${money(c.copayCents ?? 0)} unchanged`);
    if (apply) await db.update(schema.claims).set({ remitCents: 0 }).where(eq(schema.claims.id, c.id));
  }
  console.log(`\n${n} claim(s), ${money(cents)} that was never money.`);
  console.log(apply ? "Written." : "Nothing written — pass --apply to write.");
}
main().then(() => process.exit(0));
