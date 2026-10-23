import "dotenv/config";

/**
 * Records what a cheque is for before the bank shows it, backfills the whole-set receipt links for lines placed
 * before bank_line_receipts existed, and re-places the month.
 *
 *   tsx scripts/support/expect-cheque.ts <amount> <invoice number or -> <note…>
 *
 * The invoice number is typed here, never written into this file: it is the supplier's own number, which the
 * repository must not carry.
 */
async function main(): Promise<void> {
  const [amount, invoiceNumber, ...noteWords] = process.argv.slice(2);
  const { db, schema } = await import("../../src/db");
  const { sql } = await import("drizzle-orm");
  const { expectCheque, chequeExpectations } = await import("../../src/lib/cheque-expectations");
  const { chequeCandidates } = await import("../../src/lib/bank-statement");
  const { replaceUnplaced, lastStatementLines } = await import("../../src/app/(app)/money/bank");
  const user = await db.query.users.findFirst({ columns: { id: true, name: true } });
  if (!user) throw new Error("no user");

  if (amount) {
    const cents = Math.round(Number(amount) * 100);
    await expectCheque({ amountCents: cents, invoiceNumber: invoiceNumber && invoiceNumber !== "-" ? invoiceNumber : null, note: noteWords.join(" ") });
    console.log(`expected: ${(await chequeExpectations()).map((e) => `$${(e.amountCents / 100).toFixed(2)} ${e.invoiceNumber ? "invoice …" + e.invoiceNumber.slice(-3) : "(no invoice)"} said ${e.saidOn}`).join("; ")}`);
  }

  /* Backfill: lines that confirmed several receipts recorded only the first. The run lines name their days; the sum lines name each receipt. */
  const lines = (await db.all(sql`select id, "on", amount_cents, why from bank_lines where placed_as = 'confirms_deposit' and why is not null`)) as { id: string; on: string; amount_cents: number; why: string }[];
  let added = 0;
  for (const l of lines) {
    const run = /register's (?:day|\d+ days) (\d{4}-\d{2}-\d{2})(?: to (\d{4}-\d{2}-\d{2}))?/.exec(l.why);
    const ids: string[] = [];
    if (run) {
      const to = run[2] ?? run[1];
      for (const r of (await db.all(sql`select id from cash_receipts where source_key like 'register|%' and received_on >= ${run[1]} and received_on <= ${to}`)) as { id: string }[]) ids.push(r.id);
    }
    for (const m of l.why.matchAll(/(\d[\d,]*\.\d{2}) from ([^+]+?) on (\d{4}-\d{2}-\d{2})/g)) {
      const cents = Math.round(Number(m[1].replace(/,/g, "")) * 100);
      for (const r of (await db.all(sql`select id from cash_receipts where amount_cents = ${cents} and received_on = ${m[3]}`)) as { id: string }[]) ids.push(r.id);
    }
    for (const id of new Set(ids)) {
      const before = ((await db.all(sql`select count(*) n from bank_line_receipts where line_id = ${l.id} and receipt_id = ${id}`)) as { n: number }[])[0].n;
      if (!before) { await db.insert(schema.bankLineReceipts).values({ lineId: l.id, receiptId: id }).onConflictDoNothing(); added++; }
    }
  }
  console.log(`backfilled ${added} receipt links`);

  const oct = await chequeCandidates("2026-10");
  console.log("October's cheque candidates:", oct.map((c) => `${c.name} $${(c.amountCents / 100).toFixed(2)}${c.month ? ` (${c.month})` : ""}`).join(" | "));

  const r = await replaceUnplaced(["2026-09"], user);
  console.log(`${r.tried} re-placed: ${r.said}`);
  const { unplaced } = await lastStatementLines(["2026-09"]);
  console.log(`still open: ${unplaced.length}`);
  for (const u of unplaced.sort((a, b) => a.on.localeCompare(b.on))) console.log(`   ${u.on} ${(u.amountCents / 100).toFixed(2).padStart(11)}  ${u.description.slice(0, 40)}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(String(e).slice(0, 900));
    process.exit(1);
  },
);
