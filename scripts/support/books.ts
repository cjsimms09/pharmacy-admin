/** The month's account on both bases, as the site draws it. For checking, not for the site. */
import { parsePeriod } from "../../src/lib/ledger";
import { booksFor } from "../../src/lib/ledger-store";

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const period = parsePeriod(process.argv[2] ?? "2026-09");
  if (!period) throw new Error("not a period");
  const b = await booksFor(period);
  for (const basis of ["accrual", "cash"] as const) {
    const p = b[basis];
    console.log(`\n== ${basis} ==`);
    console.log(`revenue ${money(p.revenueCents)}  cogs ${money(p.costOfGoodsCents)}  gross ${money(p.grossProfitCents)}  operating ${money(p.operatingCents)}  net ${money(p.netProfitCents)}`);
    for (const l of p.operating) console.log(`   ${l.label.padEnd(32)} ${money(l.amountCents)}`);
    for (const m of p.missing) console.log(`   missing: ${m}`);
  }
  console.log(`\nbalances accrual ${JSON.stringify(b.balances.accrual)}`);
  console.log(`balances cash    ${JSON.stringify(b.balances.cash)}`);
}
main().then(() => process.exit(0));
