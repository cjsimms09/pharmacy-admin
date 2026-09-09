import "dotenv/config";
/** September claims the site holds, split by whether it knows the script was ever picked up. */
import { db, schema } from "../../src/db";
import { and, gte, lte, eq } from "drizzle-orm";
const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
async function main() {
  const rows = await db.select().from(schema.claims).where(and(gte(schema.claims.dateFilled, "2026-09-01"), lte(schema.claims.dateFilled, "2026-09-30"), eq(schema.claims.status, "paid")));
  let soldN = 0, soldRemit = 0, soldCopay = 0, unsoldN = 0, unsoldRemit = 0, unsoldCopay = 0, unsoldCost = 0;
  for (const c of rows) {
    if (c.soldOn) { soldN++; soldRemit += c.remitCents ?? 0; soldCopay += c.copayCents ?? 0; }
    else { unsoldN++; unsoldRemit += c.remitCents ?? 0; unsoldCopay += c.copayCents ?? 0; unsoldCost += c.acquisitionCents ?? 0; }
  }
  console.log(`September paid claims on the site: ${rows.length}`);
  console.log(`   with a sold date:    ${String(soldN).padStart(5)}  remit ${money(soldRemit)}  copay ${money(soldCopay)}`);
  console.log(`   with none:           ${String(unsoldN).padStart(5)}  remit ${money(unsoldRemit)}  copay ${money(unsoldCopay)}  cost ${money(unsoldCost)}`);
  console.log(`\nthe account counts all ${rows.length} as revenue: ${money(soldRemit + soldCopay + unsoldRemit + unsoldCopay)}`);
}
main().then(() => process.exit(0));
