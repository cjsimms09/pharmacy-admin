import "dotenv/config";
async function main() {
  const { db } = await import("../../src/db");
  const c = (db as unknown as { $client: { execute: (s: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const shared = await c.execute(`
    select count(*) as n from (
      select storage_key from documents group by storage_key having count(*) > 1)`);
  console.log(`storage keys shared by more than one document row: ${shared.rows[0]?.n}`);
  const orphanShared = await c.execute(`
    select count(*) as n from documents d
     where d.category like 'invoice%'
       and not exists (select 1 from supplier_invoices i where i.document_id = d.id)
       and exists (select 1 from documents k where k.storage_key = d.storage_key and k.id <> d.id
                     and exists (select 1 from supplier_invoices i2 where i2.document_id = k.id))`);
  console.log(`orphans sharing a storage key with a kept document: ${orphanShared.rows[0]?.n}`);
  const other = await c.execute(`
    select count(*) as n from documents d
     where d.category like 'invoice%'
       and not exists (select 1 from supplier_invoices i where i.document_id = d.id)
       and (exists (select 1 from expenses e where e.document_id = d.id)
         or exists (select 1 from cash_receipts r where r.document_id = d.id)
         or exists (select 1 from claim_payments p where p.document_id = d.id))`);
  console.log(`orphans referenced by an expense, receipt or payment: ${other.rows[0]?.n}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
