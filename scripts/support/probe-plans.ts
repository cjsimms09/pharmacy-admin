/**
 * What the plan classifier can actually propose right now, and for how many fills. Read-only.
 *
 * The page was unreachable until today, so nobody has ever seen its output. Before telling the owner
 * it is the answer to "we still don't know how to classify all these plans", it is worth knowing
 * whether it proposes anything at all on his real register. (The first version of this probe read a
 * field called `proposal`, which does not exist, so everything looked unproposable — an object shape
 * guessed rather than read.)
 */
import "dotenv/config";

async function main() {
  const { planCandidates } = await import("../../src/lib/plan-proposals-store");
  const rows = await planCandidates();
  const can = rows.filter((r) => r.proposed);
  const cannot = rows.filter((r) => !r.proposed);
  const fills = (r: (typeof rows)[number]) => Number((r as unknown as { fills?: number }).fills ?? 0);
  console.log(`plans in the register: ${rows.length}`);
  console.log(`with a proposal the site can defend: ${can.length}, covering ${can.reduce((n, r) => n + fills(r), 0)} fills`);
  console.log(`needing a Form 5500 or the plan document: ${cannot.length}, covering ${cannot.reduce((n, r) => n + fills(r), 0)} fills`);
  const byClass = new Map<string, number>();
  for (const r of can) byClass.set(String(r.proposed), (byClass.get(String(r.proposed)) ?? 0) + 1);
  console.log("\nproposed classes:");
  for (const [k, n] of [...byClass].sort((a, b) => b[1] - a[1])) console.log(`  ${n} × ${k}`);
  console.log("\nthe ten biggest proposals:");
  for (const r of [...can].sort((a, b) => fills(b) - fills(a)).slice(0, 10)) {
    console.log(`  ${String(fills(r)).padStart(5)} fills  ${String(r.name ?? "").slice(0, 32).padEnd(32)} -> ${r.proposed}  (${String(r.proposedSource ?? "")})`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
