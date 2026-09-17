import "dotenv/config";
async function main() {
  const { cogsProof } = await import("../../src/lib/cogs-proof-store");
  for (const [from, to] of [["2026-09-12", "2026-09-16"], ["2026-09-12", "2026-09-14"], ["2026-09-15", "2026-09-16"]]) {
    const r = await cogsProof(from, to);
    console.log(`\n===== ${from} to ${to} =====`);
    console.log(r.says);
    if (r.cannot.length) for (const c of r.cannot) console.log("  cannot: " + c);
    console.log(`  ok=${r.ok} opening=${r.terms.openingOn}/${r.terms.openingLines} closing=${r.terms.closingOn}/${r.terms.closingLines} typical=${r.terms.typicalLines}`);
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
