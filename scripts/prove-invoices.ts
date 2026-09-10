import "dotenv/config";
/**
 * Proves every supplier invoice in the tables against the file it was read from.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/prove-invoices.ts
 *
 * The sixth proof, and the one the invoices did not have. On 9 September the owner printed the
 * supplier invoices screen and three faults came off a single page — a $9,890.97 McKesson invoice
 * with no item lines at all, a ParMed invoice filed with no date, and an invoice still reporting no
 * lines after the reader had been fixed so it could read them. Each is a minute's arithmetic
 * against the file. None was visible anywhere until a person went looking.
 *
 * ── Why this reads the file again rather than trusting `lines_read` ──
 *
 * `lines_read` is what the reader believed at import. The whole class of fault here is the reader
 * being wrong, so its own account of itself proves nothing. The document is opened, the text is
 * extracted, and `parseInvoiceLines` runs against it exactly as the importer would run it today —
 * so an invoice that a since-improved reader can now read better shows up as a difference, which
 * is the only way that fault is ever visible. Fixing a reader does not reach backwards.
 *
 * ── What is not a failure ──
 *
 * A scanned invoice carries no text and proves nothing. Counted as `unreadable`, apart from
 * `disagreed`, because "we could not check this" and "we checked it and it is wrong" are different
 * facts and only one of them is a reason to distrust the tables.
 *
 * Runs in a process of its own: every libsql call blocks the event loop, and this opens a file per
 * invoice. Writes the setting `invoice_proof`; `data-health-invoice-proof.ts` renders it, and
 * carries this job's own date so a job that has stopped ages visibly on the screen.
 *
 * Aggregates only. No patient anything: an invoice names drugs and a supplier, never a person.
 */
import { db, schema } from "../src/db";
import { eq } from "drizzle-orm";

type Row = {
  invoiceId: string;
  supplier: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  totalCents: number | null;
  storedLines: number;
  storedCents: number;
  freshLines: number;
  freshCents: number;
  unreadable: boolean;
  why: string | null;
};

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const provedOn = new Date().toISOString().slice(0, 10);
  const { readFile } = await import("../src/lib/files");
  const { pdfText } = await import("../src/lib/pdf-text");
  const { parseInvoiceLines } = await import("../src/lib/invoice-lines");

  const invoices = await db
    .select({
      id: schema.supplierInvoices.id,
      documentId: schema.supplierInvoices.documentId,
      supplier: schema.supplierInvoices.supplier,
      invoiceNumber: schema.supplierInvoices.invoiceNumber,
      invoiceDate: schema.supplierInvoices.invoiceDate,
      totalCents: schema.supplierInvoices.totalCents,
      itemsText: schema.supplierInvoices.itemsText,
    })
    .from(schema.supplierInvoices);

  const rows: Row[] = [];
  for (const inv of invoices) {
    const stored = await db
      .select({ extendedCents: schema.invoiceLines.extendedCents })
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, inv.id));
    const storedCents = stored.reduce((n, l) => n + l.extendedCents, 0);

    /*
     * The text, from the document where the file is still there and from `items_text` where it is
     * not. The stored text is the reader's own extract rather than the file, so it is the weaker
     * source — but an invoice whose file has gone is better half-checked than not checked at all,
     * and `why` says which was used so nothing is claimed that was not done.
     */
    let text: string | null = null;
    let why: string | null = null;
    const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, inv.documentId) });
    if (!doc) {
      why = "The document behind this invoice is not on file.";
    } else {
      try {
        const buf = await readFile(doc.storageKey);
        text = pdfText(buf);
        if (!text || text.trim().length < 40) {
          text = null;
          why = "The file carries no text to read — a scan rather than a fault.";
        }
      } catch (e) {
        why = `The file could not be opened: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
      }
    }
    if (!text && inv.itemsText.trim().length > 40) {
      text = inv.itemsText;
      why = (why ? why + " " : "") + "Re-read from the extract stored at import rather than from the file itself.";
    }

    const fresh = text ? parseInvoiceLines(text, inv.totalCents) : null;
    rows.push({
      invoiceId: inv.id,
      supplier: inv.supplier,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      totalCents: inv.totalCents,
      storedLines: stored.length,
      storedCents,
      freshLines: fresh?.lines.length ?? 0,
      freshCents: fresh?.totalCents ?? 0,
      unreadable: fresh === null,
      why,
    });
  }

  let reconciled = 0;
  let disagreed = 0;
  let noLines = 0;
  let undated = 0;
  let readerMovedOn = 0;
  let unreadable = 0;
  let unattributedCents = 0;
  const lines: string[] = [];

  for (const r of rows) {
    if (!r.invoiceDate) undated++;
    if (r.unreadable) {
      unreadable++;
    } else if (r.storedLines === 0 && (r.totalCents ?? 0) > 0) {
      /*
       * The $9,890.97 case, and the reason this proof exists. An invoice with a total and no lines
       * looks filed and complete on every screen that lists invoices, and every drug on it is
       * missing from what the pharmacy knows it paid.
       */
      noLines++;
      unattributedCents += r.totalCents ?? 0;
      lines.push(
        `${r.supplier ?? "A supplier"} ${r.invoiceNumber ?? "(no number)"}, ${money(r.totalCents ?? 0)}: no item lines held. A fresh read finds ${r.freshLines} summing ${money(r.freshCents)}.`,
      );
    } else if (r.totalCents !== null && r.storedCents === r.totalCents) {
      reconciled++;
    } else {
      disagreed++;
      lines.push(
        `${r.supplier ?? "A supplier"} ${r.invoiceNumber ?? "(no number)"}: ${r.storedLines} lines held summing ${money(r.storedCents)} against a printed ${r.totalCents === null ? "total nobody found" : money(r.totalCents)}.`,
      );
    }

    /*
     * The reader has moved on. Counted apart from everything above, and deliberately not made into
     * a failure of the tables: the tables hold what the reader could read on the day. It is a job
     * to do — press Read again — rather than a figure to distrust.
     */
    if (!r.unreadable && r.freshLines > r.storedLines) {
      readerMovedOn++;
      lines.push(
        `${r.supplier ?? "A supplier"} ${r.invoiceNumber ?? "(no number)"}: the reader now finds ${r.freshLines} lines where ${r.storedLines} ${r.storedLines === 1 ? "is" : "are"} held. It has improved since this arrived; read it again.`,
      );
    }
  }

  const proof = {
    provedOn,
    invoices: rows.length,
    reconciled,
    disagreed,
    noLines,
    undated,
    readerMovedOn,
    unreadable,
    unattributedCents,
    rows,
    lines: lines.slice(0, 40),
  };

  const { setSetting } = await import("../src/lib/settings");
  await setSetting("invoice_proof", JSON.stringify(proof));

  console.log(
    `${rows.length} invoices: ${reconciled} reconcile, ${disagreed} disagree, ${noLines} hold no lines` +
      `${unattributedCents ? ` (${money(unattributedCents)} reaching no drug)` : ""}, ${undated} undated, ` +
      `${readerMovedOn} readable better now, ${unreadable} unreadable.`,
  );
  for (const l of lines.slice(0, 12)) console.log("  " + l);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
