import "dotenv/config";

/** Runs the engine once on the live database and prints what it wrote: the first proof of stage 1 is this output. */
async function main(): Promise<void> {
  const proofs = process.argv.includes("--proofs");
  const { engineRefresh } = await import("../../src/lib/engine/run");
  const r = await engineRefresh("script", { proofs });
  console.log(`${r.kind} in ${r.ms} ms${r.error ? ` — ERROR ${r.error}` : ""}`);
  console.log(JSON.stringify(r.wrote, null, 1).slice(0, 1600));
  const { todayView } = await import("../../src/lib/engine/read");
  const v = await todayView();
  console.log(`\nTODAY: ${v.lines.length} lines; feeds ${v.feeds.length}; proofs ${v.proofs.length}; months ${v.months.map((m) => `${m.month}:${m.closeState}`).join(",")}`);
  for (const l of v.lines.slice(0, 40)) console.log(`   [${l.rank}] ${l.kind.padEnd(16)} ${l.title.slice(0, 95)}${l.amountCents ? `  (${(l.amountCents / 100).toFixed(2)})` : ""}`);
  for (const p of v.proofs) console.log(`   proof ${p.passed ? "PASS" : "FAIL"} ${p.proof}${p.scope ? ` ${p.scope}` : ""}: ${p.says.slice(0, 150)}`);
  for (const m of v.months) console.log(`   month ${m.month}: bank ${m.bankLines} lines/${m.bankOpenLines} open, opening ${m.bankOpeningCents}, closing ${m.bankClosingCents}, receipts gap ${m.receiptsGapCents} (${m.receiptsGapSays}), revenue ${m.accrualRevenueCents}, AR unpaid ${m.arUnpaidCents} due ${m.arDueCents}, ${m.closeState}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(String(e).slice(0, 900));
    process.exit(1);
  },
);
