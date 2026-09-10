/**
 * Recomputes what can be offered for each plan on the register, and stores it.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/refresh-plan-proposals.ts
 *
 * The same thing the "Look again" button on /payers/plans does, from the command line, so a feed
 * can run it after the nightly PioneerRx pull. A proposal is not a classification and prices
 * nothing: it sits beside the plan with the sentence it came from until somebody confirms it.
 */
import "dotenv/config";

async function main() {
  const { refreshProposals, planCandidates } = await import("../src/lib/plan-proposals-store");
  const { SOURCE_LABEL } = await import("../src/lib/plan-evidence");
  const r = await refreshProposals();
  console.log(`${r.proposed} plans have an offer; ${r.unproposable} do not and say why.`);

  const rows = await planCandidates();
  const offered = rows.filter((x) => x.proposed);
  console.log(`fills behind the offers: ${offered.reduce((n, x) => n + x.fills, 0).toLocaleString("en-US")}`);

  const by = new Map<string, number>();
  for (const o of offered) {
    const k = `${SOURCE_LABEL[o.proposedSource!]} (${o.proposedConfidence})`;
    by.set(k, (by.get(k) ?? 0) + o.fills);
  }
  for (const [k, v] of [...by].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)} fills  ${k}`);

  const gov = rows.filter((x) => x.governmentHint);
  if (gov.length) {
    console.log(`\n${gov.length} plan${gov.length === 1 ? " is" : "s are"} filed Government in PioneerRx — which would put them IN reach of the Kansas floor, and each needs the plan document:`);
    for (const g of gov) console.log(`  ${g.bin} / ${g.pcn ?? "—"} / ${g.groupNumber ?? "—"}  ${g.payerLabel ?? ""}  (${g.fills} fills)`);
  }
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
