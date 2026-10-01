import "dotenv/config";
async function main(): Promise<void> {
  const { db, schema } = await import("../../src/db");
  const { eq } = await import("drizzle-orm");
  const { rereadInboxItem } = await import("../../src/lib/mailbox");
  const u = await db.query.users.findFirst({ columns: { id: true, name: true } });
  const item = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.routedAs, "accrual_sales") });
  console.log(await rereadInboxItem(item!.id, { userId: u!.id, userName: u!.name }));
  const r = (await db.run((await import("drizzle-orm")).sql.raw(`select month, period_from, period_to, retail_cents, rx_cents, total_cents from sales_months order by month desc limit 3`))) as unknown as { rows?: Record<string, unknown>[] };
  console.log("\nsales_months:");
  for (const row of r.rows ?? []) console.log("   " + JSON.stringify(row));
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
