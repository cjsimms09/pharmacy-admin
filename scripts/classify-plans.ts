/**
 * Where the plan classification stands, and the short list the owner still has to answer.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/classify-plans.ts
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/classify-plans.ts --settled
 *
 * Reads only. Nothing here classifies anything: the offers go to the register through
 * /payers/plans, where a person confirms them, because a class the Kansas floor turns on has to be
 * somebody's decision and not a script's.
 */
import "dotenv/config";

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const showSettled = process.argv.includes("--settled");
  const { planShortlist } = await import("../src/lib/plan-shortlist-store");
  const { CLASS_INFO } = await import("../src/lib/plans");
  const { SOURCE_LABEL } = await import("../src/lib/plan-evidence");
  const r = await planShortlist();
  const t = r.totals;

  const pct = (n: number, d: number) => (d === 0 ? "0%" : `${Math.round((n / d) * 100)}%`);
  console.log(`\n${t.plans} BIN/PCN pairs on ${t.claims.toLocaleString("en-US")} paid claims, ${money(t.receivedCents)} received.`);
  console.log(`  settled by evidence : ${r.settled.length} pairs, ${t.settledClaims.toLocaleString("en-US")} claims (${pct(t.settledClaims, t.claims)}), ${money(t.settledCents)}`);
  console.log(`  still open          : ${t.plans - r.settled.length} pairs, ${t.openClaims.toLocaleString("en-US")} claims (${pct(t.openClaims, t.claims)}), ${money(t.openCents)}`);

  const byClass = new Map<string, { n: number; c: number }>();
  const bySource = new Map<string, { n: number; c: number }>();
  for (const s of r.settled) {
    const k = CLASS_INFO[s.classification].label;
    const a = byClass.get(k) ?? { n: 0, c: 0 };
    byClass.set(k, { n: a.n + s.claims, c: a.c + s.receivedCents });
    const sk = `${SOURCE_LABEL[s.source]} (${s.confidence})`;
    const b = bySource.get(sk) ?? { n: 0, c: 0 };
    bySource.set(sk, { n: b.n + s.claims, c: b.c + s.receivedCents });
  }
  console.log("\nSettled, by class:");
  for (const [k, v] of [...byClass].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${String(v.n).padStart(5)}  ${money(v.c).padStart(13)}  ${k}`);
  console.log("\nSettled, by evidence:");
  for (const [k, v] of [...bySource].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${String(v.n).padStart(5)}  ${money(v.c).padStart(13)}  ${k}`);

  if (showSettled) {
    console.log("\nEvery settled pair:");
    for (const s of r.settled) {
      console.log(`\n  ${s.bin ?? "—"} / ${s.pcn || "(no PCN)"}  ${s.planName ?? s.payerLabel ?? ""}`);
      console.log(`    ${s.claims} claims, ${money(s.receivedCents)} → ${CLASS_INFO[s.classification].label}${s.detail ? ` (${s.detail})` : ""}  [${SOURCE_LABEL[s.source]}, ${s.confidence}]`);
      console.log(`    ${s.from}`);
    }
  }

  console.log(`\n\n── The short list: ${r.open.length} questions ──`);
  r.open.forEach((o, i) => {
    console.log(`\n${i + 1}. BIN ${o.bin ?? "—"} / PCN ${o.pcn || "(none)"}  ${o.planName ?? ""}`);
    console.log(`   ${o.claims} claims · ${money(o.receivedCents)} · ${o.pbmName ?? "unknown PBM"}${o.exampleDrug ? ` · e.g. ${o.exampleDrug}` : ""}`);
    if (o.groups.length) console.log(`   group${o.groups.length === 1 ? "" : "s"}: ${o.groups.slice(0, 4).join(", ")}${o.groups.length > 4 ? ` +${o.groups.length - 4} more` : ""}`);
    console.log(`   ASK: ${o.ask}`);
    console.log(`   why not settled: ${o.why}`);
    if (o.governmentHint) console.log(`   NOTE: ${o.governmentHint}`);
  });

  if (r.tail.plans) {
    console.log(`\nBelow the line: ${r.tail.plans} more pairs, ${r.tail.claims} claims, ${money(r.tail.receivedCents)} between them.`);
  }
  console.log("");
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
