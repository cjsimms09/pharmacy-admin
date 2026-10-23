/**
 * Reads every 835 on disk again and keeps what the first reading threw away: the CAS adjustments behind each
 * payment (payment_adjustments) and the PLB lines taken at remittance level (remittance_holdbacks). Idempotent: a
 * payment that already has its reasons, and a holdback already held, are left alone. Prints counts only.
 *
 *   npx tsx --tsconfig tsconfig.script.json scripts/support/backfill-835-detail.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../../src/db";
import { parse835Sets } from "../../src/lib/x12-835";
import { isOutOfBooks } from "../../src/lib/books-start";
import { newId } from "../../src/lib/crypto";

/** The folders the sweep reads (claim-payments.ts): the MTF folder where one is configured, the folder beside the database, the synced ProviderPay folder. */
async function dirs(): Promise<string[]> {
  const { remittanceDirs } = await import("../../src/lib/claim-payments");
  return remittanceDirs();
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/835|\.era$|\.rmt$|\.txt$|\.edi$/i.test(e.name)) out.push(p);
  }
  return out;
}

async function main() {
  const files = (await Promise.all((await dirs()).map(walk))).flat();
  const c = { files: 0, sets: 0, payments: 0, rowsFound: 0, adjustmentsKept: 0, alreadyHad: 0, noRow: 0, holdbacksKept: 0, notAn835: 0 };
  for (const f of files) {
    const text = await fs.readFile(f, "utf8");
    if (!/ST\*835\*/.test(text)) {
      c.notAn835++;
      continue;
    }
    c.files++;
    const fileName = path.basename(f);
    for (const r of parse835Sets(text)) {
      c.sets++;
      for (const p of r.payments) {
        if (p.paidCents === null || p.paidCents === 0) continue;
        c.payments++;
        const reference = [r.traceNumber, p.reference].filter(Boolean).join("/") || fileName;
        const rows = await db.query.claimPayments.findMany({ where: (t, { and, eq }) => and(eq(t.reference, reference), eq(t.amountCents, p.paidCents!)), columns: { id: true } });
        if (rows.length === 0) {
          c.noRow++;
          continue;
        }
        c.rowsFound += rows.length;
        if (p.adjustments.length === 0) continue;
        for (const row of rows) {
          const held = await db.query.paymentAdjustments.findFirst({ where: eq(schema.paymentAdjustments.paymentId, row.id), columns: { id: true } });
          if (held) {
            c.alreadyHad++;
            continue;
          }
          await db.insert(schema.paymentAdjustments).values(p.adjustments.map((a) => ({ id: newId(), paymentId: row.id, groupCode: a.groupCode, reasonCode: a.reasonCode, amountCents: a.amountCents, quantity: a.quantity, loop: a.loop })));
          c.adjustmentsKept += p.adjustments.length;
        }
      }
      for (const a of r.providerAdjustments) {
        const res = await db
          .insert(schema.remittanceHoldbacks)
          .values({ id: newId(), traceNumber: r.traceNumber ?? null, payer: r.payer ?? null, reasonCode: a.reasonCode, reference: a.reference, amountCents: a.amountCents, receivedOn: r.paidOn ?? null, documentId: null, fileName, outOfBooks: isOutOfBooks(r.paidOn) })
          .onConflictDoNothing();
        c.holdbacksKept += res.rowsAffected ?? 0;
      }
    }
  }
  console.log(JSON.stringify(c));
  const by = await db.all<{ g: string; r: string; n: number; cents: number }>(sql`select group_code g, reason_code r, count(*) n, sum(amount_cents) cents from payment_adjustments group by 1, 2 order by cents desc limit 12`);
  console.log("adjustments by group/reason:", by.map((b) => `${b.g}-${b.r} ${b.n} ${(b.cents / 100).toFixed(2)}`).join(" | "));
  const hb = await db.all<{ r: string; n: number; cents: number }>(sql`select reason_code r, count(*) n, sum(amount_cents) cents from remittance_holdbacks group by 1 order by cents desc`);
  console.log("holdbacks by reason:", hb.map((b) => `${b.r} ${b.n} ${(b.cents / 100).toFixed(2)}`).join(" | "));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
