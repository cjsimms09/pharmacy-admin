import "dotenv/config";
import { accountsFor } from "../../src/lib/profit-and-loss";

const m = (c: number | null) => (c === null ? "null" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function show(tag: string, p: import("../../src/lib/profit-and-loss").MonthlyPL, i: import("../../src/lib/profit-and-loss").PLInputs) {
  console.log(`\n--- ${tag} (${p.month}/${p.basis}) ---`);
  console.log(`  claimsCount        ${p.claimsCount}`);
  console.log(`  claimsRemit        ${m(i.claimsRemitCents ?? null)}`);
  console.log(`  claimsPatient      ${m(i.claimsPatientCents ?? null)}`);
  console.log(`  laterMoney         ${m(i.laterMoneyCents)}`);
  console.log(`  dispensedCost      ${m(i.dispensedCostCents)}`);
  console.log(`  purchases(lines)   ${m(i.purchasesCents)}`);
  console.log(`  billedPurchases    ${m(i.billedPurchasesCents)}`);
  console.log(`  waitingFills       ${i.waitingFills}  rev ${m(i.waitingRevenueCents ?? 0)} cost ${m(i.waitingCostCents ?? 0)}`);
  console.log(`  revenue            ${m(p.revenueCents)}  cogs ${m(p.costOfGoodsCents)}  gross ${m(p.grossProfitCents)}  net ${m(p.netProfitCents)}`);
  console.log(`  stockMovement      ${m(p.stockMovementCents)}`);
  for (const l of p.revenue) console.log(`     rev  ${l.label.padEnd(40)} ${m(l.amountCents)}`);
  for (const l of p.costOfGoods) console.log(`     cogs ${l.label.padEnd(40)} ${m(l.amountCents)}`);
  for (const l of p.operating) console.log(`     op   ${l.label.padEnd(40)} ${m(l.amountCents)}`);
  for (const c of p.reconciliation.cogs.checks) console.log(`     recon-cogs ${JSON.stringify(c)}`);
  for (const c of p.reconciliation.revenue) console.log(`     recon-rev  ${JSON.stringify(c)}`);
  for (const x of p.missing) console.log(`     MISSING ${x}`);
  for (const x of p.caveats) console.log(`     CAVEAT ${x}`);
}

async function main() {
  for (const basis of ["accrual", "cash"] as const) {
    const alone = await accountsFor(["2026-09"], basis);
    show(`SEPT ALONE (books page)`, alone.months[0], alone.inputs[0]);

    const pair = await accountsFor(["2026-08", "2026-09"], basis);
    show(`AUG inside the pair`, pair.months[0], pair.inputs[0]);
    show(`SEPT inside a 2-month period / trend`, pair.months[1], pair.inputs[1]);

    const augAlone = await accountsFor(["2026-08"], basis);
    show(`AUG ALONE (books page)`, augAlone.months[0], augAlone.inputs[0]);

    const sept = alone.months[0];
    const septInPeriod = pair.months[1];
    console.log(`\n### ${basis}: September revenue alone ${m(sept.revenueCents)} vs inside a period ${m(septInPeriod.revenueCents)}  DIFF ${m(septInPeriod.revenueCents - sept.revenueCents)}`);
    console.log(`### ${basis}: September cogs    alone ${m(sept.costOfGoodsCents)} vs inside a period ${m(septInPeriod.costOfGoodsCents)}  DIFF ${m(septInPeriod.costOfGoodsCents - sept.costOfGoodsCents)}`);
    console.log(`### ${basis}: September net     alone ${m(sept.netProfitCents)} vs inside a period ${m(septInPeriod.netProfitCents)}  DIFF ${m(septInPeriod.netProfitCents - sept.netProfitCents)}`);
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
