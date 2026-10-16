import "dotenv/config";
/* Links every receipt a bank line created or confirmed before bank_line_receipts carried the whole set. */
async function main() {
  const { db, schema } = await import("../../src/db");
  const { sql } = await import("drizzle-orm");
  const lines = (await db.all(sql`select id, key, "on", description, placed_as from bank_lines where placed_as in ('banks_remits','already_counted','confirms_deposit','deposit')`)) as { id: string; key: string; on: string; description: string; placed_as: string }[];
  let added = 0;
  for (const l of lines) {
    const desc = l.description.replace(/\s+/g, " ").trim();
    const made = (await db.all(sql`select id from cash_receipts where (notes like ${"From the bank statement line of " + l.on + " (" + desc + ")%"}) or source_key like ${"%|" + l.key} or source_key like ${"bank-decided|" + l.key}`)) as { id: string }[];
    for (const r of made) {
      const have = ((await db.all(sql`select count(*) n from bank_line_receipts where line_id = ${l.id} and receipt_id = ${r.id}`)) as { n: number }[])[0].n;
      if (!have) { await db.insert(schema.bankLineReceipts).values({ lineId: l.id, receiptId: r.id }).onConflictDoNothing(); added++; }
    }
  }
  console.log(`linked ${added} receipts`);
  const left = (await db.all(sql`select received_on, amount_cents, kind, payer, substr(source_key,1,16) sk from cash_receipts r where received_on >= '2026-09-01' and received_on <= '2026-09-30' and id not in (select receipt_id from bank_lines where receipt_id is not null) and id not in (select receipt_id from bank_line_receipts) order by amount_cents desc`)) as any[];
  console.log(`September receipts still without a bank line: ${left.length}, $${(left.reduce((n: number, r: any) => n + r.amount_cents, 0) / 100).toFixed(2)}`);
  for (const r of left) console.log(`   ${r.received_on} ${(r.amount_cents / 100).toFixed(2).padStart(10)} ${r.kind.padEnd(11)} ${String(r.payer).slice(0, 28).padEnd(28)} ${r.sk}`);
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 600)); process.exit(1); });
