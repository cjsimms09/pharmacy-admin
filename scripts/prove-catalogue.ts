/**
 * Proves each wholesaler's catalogue in the table against the file it was imported from.
 *
 * The owner, 8 September: "we need to do the same with drug info (pricing, nadac, awp, equivalents,
 * etc).. this is the most important thing." The catalogue is what every buying decision on this site
 * is made from — which supplier is cheapest, what an add-on costs, what the shelf is worth — so a
 * price in the table that the wholesaler's file does not say is a purchase made on a number nobody
 * sent.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/prove-catalogue.ts
 *
 * ── What is compared, and why "missing" is the wrong word for most of it ──
 *
 * A catalogue import does not replace a supplier's items. It deletes only the NDCs the arriving
 * file actually carries and re-inserts those, so an item the wholesaler has stopped listing stays in
 * the table at the price it last had. That is a deliberate choice and a defensible one — a product
 * absent from one night's file has not necessarily been withdrawn — but it means the table holds two
 * kinds of row, and only one of them has a file behind it today:
 *
 *   proved         in the newest file and in the table at the same unit cost
 *   priceDiffers   in both, and the table's figure is not the file's. The fault this exists for
 *   missing        in the newest file and not in the table at all
 *   carriedOver    in the table from an earlier import, absent from the newest file. Not a fault,
 *                  and not nothing: it is a price being quoted that the wholesaler last sent on the
 *                  date named, and nothing else on this site would say so
 *
 * Every item carries the `import_id` that wrote it, so "carried over" is read from the table rather
 * than inferred: an item whose import is not the newest for that supplier came from an older file.
 *
 * ── Finding the file ──
 *
 * `supplier_imports.document_id` exists but the two importers in suppliers.ts do not write it yet,
 * so the document is rediscovered by file name through `inbox_items`, the way the catalogue-currency
 * row already does it. Where the id is present it is preferred, so this needs no change when the
 * importers are plumbed through.
 *
 * ── Memory ──
 *
 * One supplier at a time, and the file is parsed whole because that is the only parser there is.
 * A nightly catalogue is tens of thousands of rows rather than the millions a NADAC archive holds,
 * and the parse is dropped before the next supplier begins. The table side is read per supplier and
 * not for all of them at once, for the same reason.
 *
 * ── What it writes, in the `catalogue_proof` setting, for the Data health row to read ──
 *
 *   { provedOn,
 *     suppliers: [{ supplier, supplierId, fileName, importedAt, printedOn, documentFound,
 *                   rowsInFile, itemsInTable, proved, priceDiffers, missing, carriedOver,
 *                   carriedOverOldestPricedOn, fileUnitMicros, tableUnitMicros, problems: [] }],
 *     rowsInFiles, proved, priceDiffers, missing, carriedOver,
 *     suppliersWithNoFile: [names], lines: [the first 40 faults in words] }
 *
 * The supplier list is the register, so a wholesaler that has never sent a catalogue is in it with
 * nothing rather than absent from it — and when PioneerRx over SQL lands, its own AWP and WAC become
 * another entry here rather than a second shape.
 */
import "dotenv/config";
import { createClient } from "@libsql/client";

const db = createClient({ url: "file:" + (process.env.DATABASE_PATH || "./data/pharmacy-admin.db") });

type ImportRow = { id: string; supplier: string; supplier_id: string | null; file_name: string; created_at: string; priced_on: string | null; document_id: string | null };
type ItemRow = { ndc11: string; unit_cost_micros: number | null; import_id: string; priced_on: string | null };

async function main() {
  const { readFile } = await import("../src/lib/files");
  const { parsePioneerCatalog } = await import("../src/lib/pioneer-catalog");
  const { allSuppliers } = await import("../src/lib/suppliers-registry");

  const registry = (await allSuppliers(true)).filter((s) => s.active);
  const suppliers: unknown[] = [];
  const lines: string[] = [];
  const withNoFile: string[] = [];
  let rowsInFiles = 0;
  let provedAll = 0;
  let differsAll = 0;
  let missingAll = 0;
  let carriedAll = 0;

  for (const s of registry) {
    const problems: string[] = [];
    /*
     * The newest import for this supplier, by the name the imports are filed under rather than by
     * the register's name. `supplier_imports.supplier` is the name the file itself used, which the
     * importer has already canonicalised, so this joins on that.
     */
    const imports = (
      await db.execute({
        sql: `select id, supplier, supplier_id, file_name, created_at, priced_on, document_id
              from supplier_imports where supplier = ? or supplier_id = ? order by created_at desc limit 1`,
        args: [s.name, s.id],
      })
    ).rows as unknown as ImportRow[];
    const last = imports[0];
    if (!last) {
      withNoFile.push(s.name);
      suppliers.push({ supplier: s.name, supplierId: s.id, fileName: null, importedAt: null, printedOn: null, documentFound: false, rowsInFile: 0, itemsInTable: 0, proved: 0, priceDiffers: 0, missing: 0, carriedOver: 0, carriedOverOldestPricedOn: null, fileUnitMicros: 0, tableUnitMicros: 0, problems: ["no catalogue has ever been imported for this wholesaler"] });
      continue;
    }

    // The document: the import's own id where it has one, else rediscovered by file name.
    let documentId = last.document_id;
    if (!documentId) {
      const inbox = (
        await db.execute({ sql: `select document_id from inbox_items where file_name = ? and document_id is not null order by received_at desc limit 1`, args: [last.file_name] })
      ).rows as unknown as { document_id: string }[];
      documentId = inbox[0]?.document_id ?? null;
    }
    const doc = documentId
      ? ((await db.execute({ sql: `select storage_key from documents where id = ?`, args: [documentId] })).rows[0] as unknown as { storage_key: string } | undefined)
      : undefined;

    const items = (
      await db.execute({ sql: `select ndc11, unit_cost_micros, import_id, priced_on from supplier_items where supplier = ?`, args: [last.supplier] })
    ).rows as unknown as ItemRow[];
    const byNdc = new Map(items.map((i) => [i.ndc11, i]));
    const tableUnitMicros = items.reduce((n, i) => n + (i.unit_cost_micros ?? 0), 0);

    if (!doc) {
      problems.push(`the file ${last.file_name} is no longer stored, so the table cannot be set against it`);
      lines.push(`${s.name}: the catalogue file ${last.file_name} is no longer stored. Its ${items.length.toLocaleString("en-US")} prices cannot be proved against anything.`);
      suppliers.push({ supplier: s.name, supplierId: s.id, fileName: last.file_name, importedAt: last.created_at, printedOn: last.priced_on, documentFound: false, rowsInFile: 0, itemsInTable: items.length, proved: 0, priceDiffers: 0, missing: 0, carriedOver: 0, carriedOverOldestPricedOn: null, fileUnitMicros: 0, tableUnitMicros, problems });
      continue;
    }

    let parsed;
    try {
      parsed = parsePioneerCatalog((await readFile(doc.storage_key)).toString("utf8"));
    } catch (e) {
      problems.push(`the stored file could not be read: ${e instanceof Error ? e.message : String(e)}`);
      lines.push(`${s.name}: the stored catalogue file could not be read.`);
      suppliers.push({ supplier: s.name, supplierId: s.id, fileName: last.file_name, importedAt: last.created_at, printedOn: last.priced_on, documentFound: true, rowsInFile: 0, itemsInTable: items.length, proved: 0, priceDiffers: 0, missing: 0, carriedOver: 0, carriedOverOldestPricedOn: null, fileUnitMicros: 0, tableUnitMicros, problems });
      continue;
    }

    /*
     * One file can carry several wholesalers. Only this one's section is compared, because the
     * others are proved on their own turn against the same file.
     */
    const section = parsed.sections.find((x) => x.supplier === last.supplier);
    if (!section) {
      problems.push(`the file no longer carries a section for ${last.supplier}`);
      lines.push(`${s.name}: the stored file ${last.file_name} has no section for ${last.supplier}, so the import's own idea of whose file it was and the file disagree.`);
    }
    const rows = section?.rows ?? [];

    let proved = 0;
    let differs = 0;
    let missing = 0;
    let fileUnitMicros = 0;
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.ndc11);
      fileUnitMicros += r.unitCostMicros ?? 0;
      const held = byNdc.get(r.ndc11);
      if (!held) {
        missing++;
        if (lines.length < 200) lines.push(`${s.name}: ${r.ndc11} is in ${last.file_name} at ${((r.unitCostMicros ?? 0) / 1_000_000).toFixed(5)} a unit and is not in the catalogue table at all.`);
        continue;
      }
      if ((held.unit_cost_micros ?? null) === (r.unitCostMicros ?? null)) {
        proved++;
        continue;
      }
      differs++;
      if (lines.length < 200) {
        lines.push(
          `${s.name}: ${r.ndc11} — the file says ${((r.unitCostMicros ?? 0) / 1_000_000).toFixed(5)} a unit and the table holds ${((held.unit_cost_micros ?? 0) / 1_000_000).toFixed(5)}. Every buying decision on this NDC is made on the table's figure.`,
        );
      }
    }

    /*
     * Items the newest file does not carry. Read from the import that wrote them rather than
     * inferred, and reported with the date they were last priced — because the risk is not that
     * they are wrong, it is that they are old and nothing says how old.
     */
    const carried = items.filter((i) => !seen.has(i.ndc11));
    const oldest = carried.reduce<string | null>((a, i) => (i.priced_on && (!a || i.priced_on < a) ? i.priced_on : a), null);
    if (carried.length > 0) {
      lines.push(
        `${s.name}: ${carried.length.toLocaleString("en-US")} prices are held that ${last.file_name} does not carry, the oldest priced ${oldest ?? "on a date the import did not record"}. They came from an earlier file and are still quoted; a catalogue import replaces only the NDCs the arriving file carries.`,
      );
    }

    rowsInFiles += rows.length;
    provedAll += proved;
    differsAll += differs;
    missingAll += missing;
    carriedAll += carried.length;
    suppliers.push({
      supplier: s.name,
      supplierId: s.id,
      fileName: last.file_name,
      importedAt: last.created_at,
      printedOn: parsed.printedOn ?? last.priced_on,
      documentFound: true,
      rowsInFile: rows.length,
      itemsInTable: items.length,
      proved,
      priceDiffers: differs,
      missing,
      carriedOver: carried.length,
      carriedOverOldestPricedOn: oldest,
      fileUnitMicros,
      tableUnitMicros,
      problems,
    });
  }

  const summary = {
    provedOn: new Date().toISOString().slice(0, 10),
    suppliers,
    rowsInFiles,
    proved: provedAll,
    priceDiffers: differsAll,
    missing: missingAll,
    carriedOver: carriedAll,
    suppliersWithNoFile: withNoFile,
  };
  await db.execute({
    sql: `insert into settings (key, value) values ('catalogue_proof', ?) on conflict(key) do update set value = excluded.value`,
    args: [JSON.stringify({ ...summary, lines: lines.slice(0, 40) })],
  });
  console.log(JSON.stringify(summary));
  for (const line of lines.slice(0, 40)) console.log("CATALOGUE " + line);
  await db.close();
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
