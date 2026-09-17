import "dotenv/config";
async function main() {
  const { db } = await import("../../src/db");
  const c = (db as unknown as { $client: { execute: (s: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const r = await c.execute(`select invoice_number, invoice_date, document_id from expenses where invoice_number like 'REBATE|%'`);
  console.log("rebate expenses:", JSON.stringify(r.rows));
  const docId = String(r.rows[0]?.document_id ?? "");
  if (!docId) return console.log("no document_id on the rebate expense — that is why nothing could be re-read");
  const d = await c.execute(`select id, storage_key, file_name from documents where id='${docId}'`);
  console.log("document:", JSON.stringify(d.rows));
  if (!d.rows[0]) return console.log("document row is gone");
  const { readFile } = await import("../../src/lib/files");
  const { pdfText } = await import("../../src/lib/pdf-text");
  const { looksLikeRebateReport, parseRebateReport } = await import("../../src/lib/rebate-report");
  const t = pdfText(await readFile(String(d.rows[0].storage_key)));
  console.log("looksLikeRebateReport:", looksLikeRebateReport(t));
  const rep = parseRebateReport(t);
  console.log("trustworthy:", rep.trustworthy, "periodTo:", rep.statement.periodTo, "rate:", rep.statement.gcrRatePercent);
  if (!rep.trustworthy) console.log("problems:", rep.problems);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
