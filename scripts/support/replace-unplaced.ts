import "dotenv/config";
/* Re-places a month's unplaced bank lines with what the matcher now knows, and lists what is still open. */
async function main() {
  const months = process.argv.slice(2).length ? process.argv.slice(2) : ["2026-09"];
  const { db } = await import("../../src/db");
  const { replaceUnplaced, lastStatementLines } = await import("../../src/app/(app)/money/bank");
  const user = await db.query.users.findFirst({ columns: { id: true, name: true } });
  if (!user) throw new Error("no user");
  const r = await replaceUnplaced(months, user);
  console.log(`${r.tried} lines re-placed: ${r.said}`);
  const { sql } = await import("drizzle-orm");
  const counts = (await db.all(sql`select placed_as p, count(*) n, sum(amount_cents) cents from bank_lines where substr("on",1,7) in (${sql.join(months.map((m) => sql`${m}`), sql`, `)}) group by placed_as order by n desc`)) as any[];
  for (const c of counts) console.log(`   ${String(c.p).padEnd(18)} ${String(c.n).padStart(4)} ${(c.cents / 100).toFixed(2).padStart(12)}`);
  const { unplaced } = await lastStatementLines(months);
  console.log(`\nstill open: ${unplaced.length}`);
  for (const u of unplaced.sort((a, b) => a.on.localeCompare(b.on))) console.log(`   ${u.on} ${(u.amountCents / 100).toFixed(2).padStart(11)}  ${u.description.slice(0, 40).padEnd(40)}  ${(u.why ?? "").slice(0, 120)}`);
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 900)); process.exit(1); });
