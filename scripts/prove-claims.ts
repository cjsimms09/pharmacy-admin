/**
 * Proves the claims table against the report files it came from.
 *
 * The owner, 8 September: "these things need to be right!! we need to make sure claims are matching
 * their info properly and continue to." A claim that looked wrong that day turned out to be a
 * neighbouring prescription, but the only way to know that was to open the stored report and look.
 * This does the looking for every stored report, every night (SESSION-RULES §1c): each file is read
 * again by the same reader, and every transaction it holds is set beside the claims table by its
 * transaction key — the same money, the same payer, the same day — with the report's own grand
 * total beside the sum of the rows read. Anything that differs is named. The result is a JSON
 * summary on stdout for Data health to show, and one line per disagreement.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/prove-claims.ts
 */
import "dotenv/config";
import { createClient } from "@libsql/client";

const db = createClient({ url: "file:" + (process.env.DATABASE_PATH || "./data/pharmacy-admin.db") });

type Row = { transaction_key: string | null; rx_number: string; fill_number: number | null; date_filled: string; bin: string | null; status: string | null; remit_cents: number | null; copay_cents: number | null; patient_total_cents: number | null; ndc11: string | null };

async function main() {
  const { readFile } = await import("../src/lib/files");
  const { parseRxTransactions } = await import("../src/lib/rx-transactions");
  const docs = (await db.execute(`select id, file_name, storage_key, uploaded_at from documents where category='report' and (file_name like 'Daily%' or file_name like 'Rx Transaction%') order by uploaded_at`)).rows as unknown as { id: string; file_name: string; storage_key: string; uploaded_at: string }[];
  const table = (await db.execute(`select transaction_key, rx_number, fill_number, date_filled, bin, status, remit_cents, copay_cents, patient_total_cents, ndc11 from claims`)).rows as unknown as Row[];
  const byKey = new Map<string, Row>();
  for (const r of table) if (r.transaction_key) byKey.set(r.transaction_key, r);

  const files: unknown[] = [];
  const disagreements: string[] = [];
  const seenKeys = new Set<string>();
  let totalRows = 0;
  let totalMatched = 0;
  for (const d of docs) {
    let text: string;
    try {
      text = (await readFile(d.storage_key)).toString("utf8");
    } catch (e) {
      disagreements.push(`${d.file_name}: the stored file could not be read (${e instanceof Error ? e.message : String(e)}).`);
      continue;
    }
    const parsed = parseRxTransactions(text);
    // P is paid, A adjusted (still a paid row), R and AR reversals.
    const paid = parsed.rows.filter((t) => t.status === "P" || t.status === "A");
    const reversed = parsed.rows.filter((t) => t.status === "R" || t.status === "AR");
    let matched = 0;
    let missing = 0;
    let differs = 0;
    let cancelled = 0;
    for (const t of paid) {
      seenKeys.add(t.transactionKey);
      const row = byKey.get(t.transactionKey);
      if (!row) {
        // A paid row the table does not hold is either cancelled by a reversal in a later file, or lost.
        const later = table.find((r) => r.rx_number === t.rxNumber && r.date_filled === t.dateFilled && r.bin === t.bin && r.status === "reversed");
        if (later) {
          cancelled++;
          continue;
        }
        missing++;
        disagreements.push(`${d.file_name}: paid row Rx ${t.rxNumber}-${t.fillNumber ?? 0} on ${t.dateFilled}, BIN ${t.bin ?? "?"}, $${((t.remitCents ?? 0) / 100).toFixed(2)} is not in the claims table.`);
        continue;
      }
      const same = (row.remit_cents ?? 0) === (t.remitCents ?? 0) && (row.copay_cents ?? 0) === (t.copayCents ?? 0) && (row.patient_total_cents ?? 0) === (t.patientTotalCents ?? 0) && (row.ndc11 ?? null) === (t.ndc11 ?? null);
      if (same) matched++;
      else {
        differs++;
        disagreements.push(`${d.file_name}: Rx ${t.rxNumber}-${t.fillNumber ?? 0} on ${t.dateFilled}, BIN ${t.bin ?? "?"} — file says remit $${((t.remitCents ?? 0) / 100).toFixed(2)}, copay $${((t.copayCents ?? 0) / 100).toFixed(2)}, NDC ${t.ndc11 ?? "none"}; table holds remit $${((row.remit_cents ?? 0) / 100).toFixed(2)}, copay $${((row.copay_cents ?? 0) / 100).toFixed(2)}, NDC ${row.ndc11 ?? "none"}.`);
      }
    }
    // The report's own bottom line against the rows read: remit alone, and remit plus what the patient paid.
    const readRemit = parsed.rows.reduce((n, t) => n + (t.remitCents ?? 0), 0);
    const readSales = parsed.rows.reduce((n, t) => n + (t.remitCents ?? 0) + (t.patientTotalCents ?? 0), 0);
    const reportSales = parsed.grandTotal?.salesCents ?? null;
    if (reportSales !== null && readSales !== reportSales && readRemit !== reportSales) disagreements.push(`${d.file_name}: the report's grand total ${(reportSales / 100).toFixed(2)} matches neither the remit summed over the rows read (${(readRemit / 100).toFixed(2)}) nor remit plus patient (${(readSales / 100).toFixed(2)}).`);
    totalRows += paid.length;
    totalMatched += matched;
    files.push({ file: d.file_name, uploadedAt: d.uploaded_at, period: parsed.period, rowsRead: parsed.rows.length, paid: paid.length, reversed: reversed.length, matched, cancelledLater: cancelled, differs, missing, reportSalesCents: reportSales, readRemitCents: readRemit, readSalesCents: readSales, skipped: parsed.skipped, problems: parsed.problems.length });
  }
  // Rows in the table that no stored file accounts for: real claims from a file the site no longer holds, or an error.
  const orphans = table.filter((r) => r.status === "paid" && (!r.transaction_key || !seenKeys.has(r.transaction_key)));
  const orphanDays = new Map<string, number>();
  for (const r of orphans) orphanDays.set(r.date_filled, (orphanDays.get(r.date_filled) ?? 0) + 1);
  const summary = {
    provedOn: new Date().toISOString().slice(0, 10),
    files,
    paidRowsInFiles: totalRows,
    matched: totalMatched,
    disagreements: disagreements.length,
    tableRowsNoFileAccountsFor: orphans.length,
    byDay: [...orphanDays.entries()].sort().map(([day, n]) => `${day}: ${n}`),
  };
  // Kept for Data health to show, beside the date it was proved: the summary and the first disagreements in words.
  await db.execute({ sql: `insert into settings (key, value) values ('claims_proof', ?) on conflict(key) do update set value = excluded.value`, args: [JSON.stringify({ ...summary, lines: disagreements.slice(0, 40) })] });
  console.log(JSON.stringify(summary));
  for (const line of disagreements.slice(0, 40)) console.log("DIFFERS " + line);
  await db.close();
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
