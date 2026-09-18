import "dotenv/config";
/**
 * How far the bracketed-pack fault could have reached an appeal.
 *
 * A pack size printed "(5) 1 ML" is five vials of one millilitre. Read as 1, an invoice's
 * per-package price becomes a per-unit acquisition cost — $18.75 a box submitted as $18.75 a
 * millilitre. Counted here: NDCs on a real claim, that have a bracketed pack on file, and that the
 * pharmacy has actually bought.
 */
import { db, schema } from "../../src/db";
import { and, gte, eq, isNotNull } from "drizzle-orm";

const BRACKET = /^\s*\(\s*(\d+)\s*\)/;

async function main() {
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
  const cash = await db.query.cashPlans.findMany({ columns: { bin: true, pcn: true, name: true } });
  const { cashPlanFor } = await import("../../src/lib/cash-plans");

  const claims = await db.select().from(schema.claims).where(and(gte(schema.claims.dateFilled, since), eq(schema.claims.status, "paid"), isNotNull(schema.claims.ndc11)));
  const billable = claims.filter((c) => c.ndc11 && c.pbmName && !cashPlanFor(c.bin, c.pcn, cash));
  const ndcs = new Set(billable.map((c) => c.ndc11!));

  const items = await db.select().from(schema.supplierItems);
  const bracketed = new Map<string, { packs: Set<string> }>();
  for (const it of items) {
    const n = it.ndc11;
    if (!n || !ndcs.has(n)) continue;
    const m = BRACKET.exec(it.packSize ?? "");
    if (!m || Number(m[1]) <= 1) continue;
    const e = bracketed.get(n) ?? { packs: new Set<string>() };
    e.packs.add(it.packSize!);
    bracketed.set(n, e);
  }

  const lines = await db.select().from(schema.invoiceLines);
  const bought = new Set(lines.map((l) => l.ndc11).filter(Boolean) as string[]);
  const exposed = [...bracketed.keys()].filter((n) => bought.has(n));

  console.log(`paid claims since ${since} with a PBM and not on a cash plan: ${billable.length.toLocaleString("en-US")} over ${ndcs.size.toLocaleString("en-US")} NDCs`);
  console.log(`of those NDCs, carrying a multi-pack bracket on a supplier item: ${bracketed.size}`);
  console.log(`and actually bought (an invoice line exists): ${exposed.length}  <- the exposure`);
  const claimsOn = billable.filter((c) => exposed.includes(c.ndc11!));
  console.log(`claims on those NDCs: ${claimsOn.length}`);
  for (const n of exposed.slice(0, 12)) {
    const name = billable.find((c) => c.ndc11 === n)?.itemName ?? "?";
    console.log(`   ${n}  ${String(name).slice(0, 38).padEnd(40)} ${[...bracketed.get(n)!.packs].slice(0, 2).join(", ")}`);
  }
}
main().then(() => process.exit(0));
