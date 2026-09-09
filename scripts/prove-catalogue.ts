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
 *   proved                the table holds the listing the importer's own rule would pick
 *   matchedOtherListing   the table holds a different listing of the same NDC. Not a fault: the
 *                         file or the rule has changed since the import
 *   priceDiffers          the table's price is no listing in the file. The fault this exists for
 *   missing               in the newest file and not in the table at all
 *   carriedOver           in the table from an earlier import, absent from the newest file. Not a
 *                         fault, and not nothing: it is a price still being quoted that the
 *                         wholesaler last sent on the date named, and nothing else here says so
 *
 * Every item carries the `import_id` that wrote it, so "carried over" is read from the table rather
 * than inferred: an item whose import is not the newest for that supplier came from an older file.
 *
 * ── One NDC, several listings, and the rule that picks between them ──
 *
 * The first real run reported 239 prices as wrong across four wholesalers and not one of them was.
 * Every line was a second listing of the same NDC in the same file — McKesson lists 539 NDCs more
 * than once in a single catalogue, IPC 19, ANDA 5 — and comparing row by row asked of each listing
 * "does the table hold this one", when the table can only hold one.
 *
 * So the file is grouped by NDC and compared against the listing `suppliers.ts` would select. That
 * rule is not simply "cheapest": it prefers listings that are not short-dated, and falls back to
 * short-dated ones only where no priced full-dated listing exists. A short-dated lot is often the
 * cheaper line, so encoding "cheapest wins" would have replaced one false alarm with another.
 *
 * That rule lives in two files now, which is a coupling worth naming. It is bounded on purpose: if
 * `suppliers.ts` changes how it picks, this reports `matchedOtherListing` — a count, not a fault —
 * rather than a page of wrong prices.
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
 *                   rowsInFile, ndcsInFile, listedTwice, itemsInTable,
 *                   proved, matchedOtherListing, priceDiffers, missing,
 *                   carriedOver, carriedOverOldestPricedOn,
 *                   fileUnitMicros, tableUnitMicros, problems: [] }],
 *     rowsInFiles, ndcsInFiles, listedTwice, proved, matchedOtherListing, priceDiffers, missing,
 *     carriedOver, suppliersWithNoFile: [names], lines: [the first 40 faults in words] }
 *
 * `rowsInFile` and `ndcsInFile` are both reported because they differ by hundreds on the real
 * files, and every count that matters is per NDC.
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
  let ndcsInFiles = 0;
  let matchedOtherAll = 0;
  let listedTwiceAll = 0;

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

    /*
     * ── One NDC can be listed several times in one file, and the table keeps one of them ──
     *
     * The first run reported 239 prices as wrong across four wholesalers and not one of them was.
     * Every line was a second listing of the same NDC in the same file: McKesson lists 539 NDCs
     * more than once in a single catalogue, IPC 19, ANDA 5. Comparing row by row asked "does the
     * table hold this listing" of each of them, and the table can only hold one.
     *
     * So the file is grouped by NDC and the table is compared against the listing the importer's
     * own rule selects. That rule, from `suppliers.ts`, is not simply "cheapest": it prefers
     * listings that are not short-dated, and only falls back to short-dated ones where there is no
     * priced full-dated listing at all. A short-dated lot is often the cheaper line, so "cheapest
     * wins" would have produced a new false alarm in exactly the cases the old one was hiding.
     *
     * Three answers, so a rule that drifts is visible without being reported as a price fault:
     *
     *   proved                the table holds the listing the importer's rule would pick
     *   matchedOtherListing   the table holds a different listing of the same NDC. Not a fault —
     *                         the file or the rule has changed since the import — but worth a count
     *   priceDiffers          the table's price is no listing in the file. The real fault
     */
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const g = groups.get(r.ndc11);
      if (g) g.push(r);
      else groups.set(r.ndc11, [r]);
    }

    let proved = 0;
    let matchedOther = 0;
    let differs = 0;
    let missing = 0;
    let listedTwice = 0;
    let keptNotPreferred = 0;
    let fileUnitMicros = 0;
    const seen = new Set<string>();
    for (const [ndc11, group] of groups) {
      seen.add(ndc11);
      if (group.length > 1) listedTwice++;
      // The importer's own selection, replicated: full-dated before short-dated, then cheapest.
      const dated = group.filter((r) => !r.shortDated && r.unitCostMicros !== null);
      const short = group.filter((r) => r.shortDated && r.unitCostMicros !== null);
      const preferred = (dated.length ? dated : short).sort((a, b) => (a.unitCostMicros ?? 0) - (b.unitCostMicros ?? 0))[0] ?? group[0];
      fileUnitMicros += preferred.unitCostMicros ?? 0;

      const held = byNdc.get(ndc11);
      if (!held) {
        missing++;
        if (lines.length < 200) lines.push(`${s.name}: ${ndc11} is in ${last.file_name} at ${((preferred.unitCostMicros ?? 0) / 1_000_000).toFixed(5)} a unit and is not in the catalogue table at all.`);
        continue;
      }
      if ((held.unit_cost_micros ?? null) === (preferred.unitCostMicros ?? null)) {
        proved++;
        continue;
      }
      const other = group.find((r) => (r.unitCostMicros ?? null) === (held.unit_cost_micros ?? null));
      if (other) {
        matchedOther++;
        keptNotPreferred++;
        if (lines.length < 200 && keptNotPreferred <= 5) {
          lines.push(
            `${s.name}: ${ndc11} is listed ${group.length} times in ${last.file_name} and the table holds ${((held.unit_cost_micros ?? 0) / 1_000_000).toFixed(5)}, which is one of them but not the one the import rule would pick (${((preferred.unitCostMicros ?? 0) / 1_000_000).toFixed(5)}${other.shortDated ? ", the held line being short-dated" : ""}). Not a wrong price; the file or the rule has changed since the import.`,
          );
        }
        continue;
      }
      differs++;
      if (lines.length < 200) {
        lines.push(
          `${s.name}: ${ndc11} — the table holds ${((held.unit_cost_micros ?? 0) / 1_000_000).toFixed(5)} a unit and no listing in ${last.file_name} says that (${group.length === 1 ? `the file says ${((preferred.unitCostMicros ?? 0) / 1_000_000).toFixed(5)}` : `${group.length} listings, cheapest ${((preferred.unitCostMicros ?? 0) / 1_000_000).toFixed(5)}`}). Every buying decision on this NDC is made on the table's figure.`,
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
    ndcsInFiles += groups.size;
    provedAll += proved;
    matchedOtherAll += matchedOther;
    differsAll += differs;
    missingAll += missing;
    carriedAll += carried.length;
    listedTwiceAll += listedTwice;
    suppliers.push({
      supplier: s.name,
      supplierId: s.id,
      fileName: last.file_name,
      importedAt: last.created_at,
      printedOn: parsed.printedOn ?? last.priced_on,
      documentFound: true,
      rowsInFile: rows.length,
      ndcsInFile: groups.size,
      listedTwice,
      itemsInTable: items.length,
      proved,
      matchedOtherListing: matchedOther,
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
    ndcsInFiles,
    listedTwice: listedTwiceAll,
    proved: provedAll,
    matchedOtherListing: matchedOtherAll,
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
