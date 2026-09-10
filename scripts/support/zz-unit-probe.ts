import "dotenv/config";
/** Read-only probe: does the unguarded floor (against-nadac) price ML/GM drugs on an EA quantity? TEMPORARY. */
import { db } from "../../src/db";
import { sql } from "drizzle-orm";

async function rows(text: string): Promise<any[]> {
  const r: any = await db.run(sql.raw(text));
  return r.rows ?? r;
}

async function main() {
  const r = await rows(`
    with nl as (
      select ndc11, pricing_unit, unit_micros, description,
             row_number() over (partition by ndc11 order by effective_on desc) rn
      from nadac_prices
    ), n as (select * from nl where rn = 1),
    pk as (select ndc11, min(pack_size) pack_size from supplier_items where pack_size is not null group by ndc11)
    select c.ndc11, c.item_name, n.pricing_unit, n.unit_micros, pk.pack_size,
           c.quantity_thousandths q, c.days_supply, c.remit_cents, c.copay_cents,
           c.date_filled, c.rx_number
    from claims c join n on n.ndc11 = c.ndc11 left join pk on pk.ndc11 = c.ndc11
    where c.status = 'paid' and c.cash_plan = 0 and n.pricing_unit in ('ML','GM') and c.quantity_thousandths > 0
  `);
  console.log("paid non-cash claims on an ML/GM-priced NDC:", r.length);
  console.log("\n ndc | drug | nadacUOM | pack | qty | $/unit | floor(ing) | received | ratio recd/floorIng");
  const scored = r
    .map((x: any) => {
      const floorIng = (x.unit_micros * x.q) / 1000 / 10_000; // cents
      const recd = (x.remit_cents ?? 0) + (x.copay_cents ?? 0);
      return { x, floorIng, recd, ratio: floorIng > 0 ? recd / floorIng : null };
    })
    .sort((a, b) => (a.ratio ?? 9) - (b.ratio ?? 9));
  for (const s of scored.slice(0, 20)) {
    console.log(
      `  ${s.x.ndc11} | ${(s.x.item_name ?? "").slice(0, 28)} | ${s.x.pricing_unit} | ${s.x.pack_size} | ${s.x.q / 1000} | $${(s.x.unit_micros / 1e6).toFixed(4)} | $${(s.floorIng / 100).toFixed(2)} | $${(s.recd / 100).toFixed(2)} | ${s.ratio === null ? "-" : s.ratio.toFixed(3)}`,
    );
  }
  const under = scored.filter((s) => s.ratio !== null && s.ratio < 0.5);
  console.log(`\n  claims where received is under half the NADAC ingredient floor: ${under.length}`);
  console.log(`  total apparent shortfall on those: $${(under.reduce((n, s) => n + (s.floorIng - s.recd), 0) / 100).toFixed(2)}`);

  // Pack size vs quantity: does the dispensed quantity look like ML/GM or like 'each'?
  console.log("\n### quantity vs pack size on ML/GM NDCs (distinct)");
  const seen = new Set<string>();
  for (const s of scored) {
    if (seen.has(s.x.ndc11)) continue;
    seen.add(s.x.ndc11);
    console.log(`  ${s.x.ndc11} ${(s.x.item_name ?? "").slice(0, 30)} | pack "${s.x.pack_size}" | qty ${s.x.q / 1000} | days ${s.x.days_supply}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
