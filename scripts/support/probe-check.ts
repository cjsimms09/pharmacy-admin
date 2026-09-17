import "dotenv/config";
async function main() {
  const { db } = await import("../../src/db");
  const c = (db as unknown as { $client: { execute: (s: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const q = async (l: string, s: string) => { try { const r = await c.execute(s); console.log(`== ${l} ==`); for (const x of r.rows) console.log("  " + JSON.stringify(x)); } catch (e) { console.log(`== ${l} == ${e instanceof Error ? e.message : e}`); } };
  await q("total arrivals now", `select count(*) rows, count(distinct message_id) arrivals from inbox_items`);
  await q("newest sweep", `select max(swept_at) last_sweep from inbox_items`);
  await q("anything new since the fix", `select subject, from_address, received_at, status, reason from inbox_items where swept_at >= '2026-09-17T15' order by swept_at desc limit 20`);
  await q("mail sweep result setting", `select key, substr(value,1,300) v from settings where key like '%mail%' and key like '%result%'`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
