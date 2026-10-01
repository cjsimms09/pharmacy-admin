import "dotenv/config";
async function main(): Promise<void> {
  const { db, schema } = await import("../../src/db");
  const { eq } = await import("drizzle-orm");
  const { readFile } = await import("../../src/lib/files");
  const { parseSystemSales } = await import("../../src/lib/system-sales");
  const item = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.routedAs, "accrual_sales") });
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, item!.documentId!) });
  const r = parseSystemSales((await readFile(doc!.storageKey)).toString("utf8"));
  const m = (c: number | null) => (c === null ? "—" : `$${(c / 100).toFixed(2)}`);
  console.log(`period ${r.period?.from} .. ${r.period?.to}  month=${r.month}`);
  console.log(`retail ${m(r.retailCents)}  tax ${m(r.retailTaxCents)}  rx ${m(r.rxCents)}  rxPatient ${m(r.rxPatientCents)}  rxRemit ${m(r.rxRemitCents)}  total ${m(r.totalCents)}`);
  console.log(`problems: ${r.problems.length === 0 ? "none" : r.problems.join(" | ")}`);
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
