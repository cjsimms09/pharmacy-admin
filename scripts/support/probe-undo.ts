import "dotenv/config";
async function main() {
  const { db } = await import("../../src/db");
  const c = (db as unknown as { $client: { execute: (s: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const l = await c.execute("select count(*) as n from payer_links where confirmed_by = 'an 835'");
  console.log(`machine-learned payer links remaining: ${l.rows[0]?.n}`);
  const cl = await c.execute("select count(*) as n from claims where pbm_name like '%Health Mart%'");
  console.log(`claims still named after the courier: ${cl.rows[0]?.n}`);
  const s = await c.execute("select value from settings where key = 'payer_links_learned_result'");
  console.log(`last learner run: ${String(s.rows[0]?.value ?? "never").slice(0, 160)}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
