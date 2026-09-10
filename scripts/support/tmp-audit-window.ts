import "dotenv/config";
import { accountsFor } from "../../src/lib/profit-and-loss";

const m = (c: number | null) => (c === null ? "null" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);

async function main() {
  for (const basis of ["accrual", "cash"] as const) {
    const one = (await accountsFor(["2026-09"], basis)).months[0];
    const many = (await accountsFor(["2026-07", "2026-08", "2026-09"], basis)).months.find((x) => x.month === "2026-09")!;
    console.log(`\n=== ${basis}: September drawn ALONE vs inside Q3 ===`);
    const rows: [string, number | null, number | null][] = [
      ["scripts", one.claimsCount, many.claimsCount],
      ["revenue", one.revenueCents, many.revenueCents],
      ["net revenue", one.netRevenueCents, many.netRevenueCents],
      ["cost of goods", one.costOfGoodsCents, many.costOfGoodsCents],
      ["gross profit", one.grossProfitCents, many.grossProfitCents],
      ["net profit", one.netProfitCents, many.netProfitCents],
    ];
    for (const [label, a, b] of rows) {
      const diff = a !== null && b !== null ? b - a : null;
      console.log(`  ${label.padEnd(16)} alone ${String(m(a)).padStart(14)}   inQ3 ${String(m(b)).padStart(14)}   diff ${m(diff)}`);
    }
    console.log(`  gross margin     alone ${one.grossMarginPercent}%   inQ3 ${many.grossMarginPercent}%`);
    console.log(`  caveats alone: ${one.caveats.length}, inQ3: ${many.caveats.length}`);
    for (const c of one.caveats) console.log(`     ALONE: ${c.slice(0, 110)}`);
    for (const c of many.caveats) console.log(`     INQ3 : ${c.slice(0, 110)}`);
    console.log(`  revenue lines alone: ${one.revenue.map((l) => `${l.label}=${m(l.amountCents)}`).join(" | ")}`);
    console.log(`  revenue lines inQ3 : ${many.revenue.map((l) => `${l.label}=${m(l.amountCents)}`).join(" | ")}`);
    console.log(`  cogs lines alone: ${one.costOfGoods.map((l) => `${l.label}=${m(l.amountCents)}`).join(" | ")}`);
  }
}
main().then(() => process.exit(0));
