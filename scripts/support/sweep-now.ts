import "dotenv/config";
async function main() {
  const { db } = await import("../../src/db");
  const { sql } = await import("drizzle-orm");
  const { sweepMailbox } = await import("../../src/lib/mailbox");
  const user = await db.query.users.findFirst({ columns: { id: true, name: true } });
  const r = await sweepMailbox({ userId: user?.id ?? null, userName: user?.name ?? null });
  console.log("sweep:", JSON.stringify(r).replace(/\d{6,}/g, "#").slice(0, 400));
  const rows = (await db.all(sql`select received_at, from_address, subject, file_name, status, routed_as, imported, substr(route_result,1,400) r from inbox_items where received_at >= '2026-10-01T18' order by received_at desc limit 6`)) as any[];
  for (const x of rows) console.log(`${x.received_at.slice(0, 16)} ${String(x.from_address).split("@")[1] ?? x.from_address} | ${String(x.subject).slice(0, 60)} | ${String(x.file_name ?? "").slice(0, 50)} | ${x.status}/${x.routed_as}/${x.imported} | ${String(x.r).replace(/\d{6,}/g, "#")}`);
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 600)); process.exit(1); });
