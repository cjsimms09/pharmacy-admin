import "dotenv/config";
/** Throwaway, read-only: the business as the site can see it tonight. Figures only, nothing written. */
const $ = (c: number | null | undefined) => (c === null || c === undefined ? "—" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

async function main() {
  const { parsePeriod } = await import("../../src/lib/ledger");
  const { booksFor } = await import("../../src/lib/ledger-store");
  const sept = parsePeriod("2026-09")!;
  const books = await booksFor(sept).catch(() => null);
  if (books) {
    const a = books.accrual, c = books.cash;
    console.log(`SEPTEMBER, accrual: revenue ${$(a.revenueCents)}, cost of goods ${$(a.costOfGoodsCents)}, gross ${$(a.grossProfitCents)}, running costs ${$(a.operatingCents)}, net ${$(a.netProfitCents)}`);
    console.log(`SEPTEMBER, cash:    revenue ${$(c.revenueCents)}, cost of goods ${$(c.costOfGoodsCents)}, net ${$(c.netProfitCents)}`);
    console.log(`  accrual missing: ${a.missing.slice(0, 4).join(" | ") || "nothing"}`);
    console.log(`  cash missing:    ${c.missing.slice(0, 4).join(" | ") || "nothing"}`);
  }

  const { allFills } = await import("../../src/lib/claims");
  const fills = (await allFills({ from: "2026-09-01", to: "2026-09-30" })).filter((f) => f.dateFilled >= "2026-09-01");
  const sold = fills.filter((f) => f.soldOn);
  const priced = sold.filter((f) => f.marginCents !== null);
  const losers = priced.filter((f) => (f.marginCents ?? 0) < 0);
  const lossCents = losers.reduce((n, f) => n + (f.marginCents ?? 0), 0);
  const marginCents = priced.reduce((n, f) => n + (f.marginCents ?? 0), 0);
  const revenue = priced.reduce((n, f) => n + f.revenueCents, 0);
  console.log(`\nFILLS sold in September ${sold.length}; priced ${priced.length}; gross margin ${$(marginCents)} on ${$(revenue)} (${revenue ? ((marginCents / revenue) * 100).toFixed(1) : "—"}%)`);
  console.log(`  dispensed at a loss: ${losers.length} fills, ${$(lossCents)}; worst ${losers.sort((a, b) => (a.marginCents ?? 0) - (b.marginCents ?? 0)).slice(0, 5).map((f) => `${f.itemName?.slice(0, 22) ?? "?"} ${$(f.marginCents)}`).join("; ")}`);

  /* Margin by payer: who pays worst on the same drugs. */
  const byPayer = new Map<string, { n: number; rev: number; margin: number }>();
  for (const f of priced) {
    const name = f.payers[0]?.name ?? "(cash)";
    const v = byPayer.get(name) ?? { n: 0, rev: 0, margin: 0 };
    v.n++; v.rev += f.revenueCents; v.margin += f.marginCents ?? 0;
    byPayer.set(name, v);
  }
  const payers = [...byPayer].filter(([, v]) => v.n >= 20).sort((a, b) => a[1].margin / a[1].n - b[1].margin / b[1].n);
  console.log(`\nMARGIN PER FILL, payers with 20+ fills, worst first:`);
  for (const [name, v] of payers.slice(0, 6)) console.log(`  ${name.slice(0, 34).padEnd(34)} ${v.n.toString().padStart(4)} fills  ${$(Math.round(v.margin / v.n))} each  ${$(v.margin)} in all`);
  for (const [name, v] of payers.slice(-3)) console.log(`  best: ${name.slice(0, 28).padEnd(28)} ${v.n.toString().padStart(4)} fills  ${$(Math.round(v.margin / v.n))} each`);

  const { moneyFound } = await import("../../src/lib/money-found");
  const found = await moneyFound().catch(() => null);
  if (found) {
    console.log(`\nMONEY FOUND: first year ${$(found.firstYearCents)} (${$(found.recurringMonthlyCents)} a month, ${$(found.oneOffCents)} one-off) across ${found.rows.length} rows`);
    for (const r of found.rows.slice(0, 6)) console.log(`  ${$(r.amountCents)} ${r.cadence === "recurring_monthly" ? "/month" : "one-off"} — ${r.says.slice(0, 96)}`);
    if (found.blocked.length) console.log(`  blocked: ${found.blocked.slice(0, 3).map((b) => b.says.slice(0, 70)).join(" | ")}`);
  }

  const { moneyWaitingNow } = await import("../../src/lib/money-waiting-store");
  const w = await moneyWaitingNow();
  console.log(`\nWAITING: ${$(w.totalCents)} across ${w.rows.length}; never anything ${$(w.neverAnythingCents)}`);

  const { claimFlags } = await import("../../src/lib/claims");
  const flags = await claimFlags({ all: true }).catch(() => null);
  if (flags) console.log(`CLAIMS balance check: difference ${$(flags.balance.differenceCents)} across ${flags.balance.fillsOff} fills`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 600)); process.exit(1); });
