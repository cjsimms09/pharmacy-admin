/**
 * One payment, one row: removes the second recording of the same money where it came through a different kind of
 * document (payment-origin.ts). Dry run by default; `--apply` deletes.
 *
 * Measured 1 October 2026 before the rule went into recordClaimPayment: 752 tied payments ($27,732.69) stood twice,
 * once from the 835 and once from ProviderPay's remittance detail or the AccessHealth report, and read as over-pays.
 * The 835's row is kept (it carries the trace and the CAS reasons); failing one, the AccessHealth report's; failing
 * that, the earliest. Rows of the same class in one group are all kept: those are the reader's own double lines.
 *
 *   npx tsx --tsconfig tsconfig.script.json scripts/support/dedup-payments.ts [--apply]
 */
import { inArray, sql } from "drizzle-orm";
import { db, schema } from "../../src/db";
import { originClass, legacyOrigin, type OriginClass } from "../../src/lib/payment-origin";

const RANK: Record<OriginClass, number> = { "835": 0, accesshealth: 1, "providerpay-detail": 2, copay: 3, veridikal: 3, rxrescue: 3, manual: 4, unknown: 5 };
const $ = (c: number) => (c / 100).toFixed(2);

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await db.all<{ id: string; claim_id: string | null; rx_number: string; amount_cents: number; received_on: string | null; source: string; notes: string | null; reference: string | null; payer: string | null; origin: string | null; created_at: string }>(
    sql`select id, claim_id, rx_number, amount_cents, received_on, source, notes, reference, payer, origin, created_at from claim_payments where received_on is not null`,
  );
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = r.claim_id ? `c|${r.claim_id}|${r.amount_cents}|${r.received_on}|${r.source}` : `u|${r.rx_number}|${r.amount_cents}|${r.received_on}|${r.source}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const drop: string[] = [];
  const tally = new Map<string, { n: number; cents: number }>();
  for (const [k, g] of groups) {
    const classes = new Set(g.map((r) => originClass(r.origin ?? legacyOrigin(r))));
    if (classes.size < 2) continue;
    const best = [...classes].sort((a, b) => RANK[a] - RANK[b] || a.localeCompare(b))[0];
    for (const r of g) {
      const c = originClass(r.origin ?? legacyOrigin(r));
      if (c === best) continue;
      drop.push(r.id);
      const tk = `${k.startsWith("c|") ? "tied" : "untied"} | keep ${best}, drop ${c}`;
      const t = tally.get(tk) ?? { n: 0, cents: 0 };
      t.n++;
      t.cents += r.amount_cents;
      tally.set(tk, t);
    }
  }
  console.log(`${rows.length} payment rows, ${groups.size} identities, ${drop.length} second recordings${apply ? " — deleting" : " (dry run; --apply to delete)"}`);
  for (const [k, t] of [...tally].sort((a, b) => b[1].cents - a[1].cents)) console.log(`  ${k.padEnd(50)} ${String(t.n).padStart(5)} ${$(t.cents).padStart(11)}`);
  if (apply && drop.length) {
    for (let i = 0; i < drop.length; i += 200) await db.delete(schema.claimPayments).where(inArray(schema.claimPayments.id, drop.slice(i, i + 200)));
    const left = await db.all<{ n: number }>(sql`select count(*) n from claim_payments`);
    console.log(`deleted ${drop.length}; ${left[0].n} rows remain`);
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
