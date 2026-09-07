import { db } from "../src/db";
const c = (db as unknown as { $client: { execute: (s: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
async function main() {
  for (const ndc of ["00555904358", "62332019960", "55111068002", "08021000152"]) {
    console.log(`\n=== ${ndc} ===`);
    const r = await c.execute(`select supplier, pack_size, unit_cost_micros, pack_cost_cents, awp_cents from supplier_items where ndc11='${ndc}' order by supplier`);
    console.table(r.rows.map((x) => ({
      supplier: x.supplier, pack: x.pack_size,
      unit: x.unit_cost_micros === null ? null : `$${(Number(x.unit_cost_micros)/1e6).toFixed(4)}`,
      packCost: x.pack_cost_cents === null ? null : `$${(Number(x.pack_cost_cents)/100).toFixed(2)}`,
      awp: x.awp_cents === null ? null : `$${(Number(x.awp_cents)/100).toFixed(2)}`,
    })));
  }
}
main();
