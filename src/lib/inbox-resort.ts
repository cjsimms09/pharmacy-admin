import "server-only";

/**
 * Sorting again, with what the site knows now.
 *
 * The owner: "invoices arent being recognize.. I cant fix things or set rules from this screen."
 *
 * The first half turned out not to be true, and that is the whole reason this exists. Twenty-one
 * invoices from McKesson, IPC and IPD sat in the inbox marked unrecognised, and every one of them
 * is recognised by the current rules — `looksLikeInvoice` returns true for all of them and the
 * register knows all three senders. They arrived before it did. The sweep decides once, when the
 * message lands, and nothing ever asked again.
 *
 * That is the bug behind the complaint: not a reader that cannot recognise an invoice, but a
 * decision taken once and never revisited when the thing it depended on changed. Adding a supplier
 * fixes every future message and no past one, so the backlog only grows, and the screen fills with
 * items whose problem was already solved.
 *
 * So: one press, over everything still unsorted, using today's register and today's rules. The same
 * calls the sweep makes — not a copy of them, which would be one more rule to drift.
 */

import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { readFile } from "./files";
import { pdfText } from "./pdf-text";
import { allSuppliers, supplierForSender } from "./suppliers-registry";
import { looksLikeInvoice, fileInvoice, filingFor } from "./invoices";

export type ResortOutcome = {
  itemId: string;
  fileName: string;
  from: string;
  /** What it became, or null where it still cannot be placed. */
  routedAs: string | null;
  detail: string;
};

export type ResortReport = {
  looked: number;
  filed: number;
  stillStuck: number;
  outcomes: ResortOutcome[];
};

/** Everything stored and never placed: the queue this works through. */
export async function unsortedItems() {
  const rows = await db.query.inboxItems.findMany();
  return rows.filter((i) => i.status === "stored" && i.documentId && (!i.routedAs || i.routedAs === "unrecognised"));
}

/**
 * Re-decide every unsorted arrival.
 *
 * Only files what it is confident of, which today means an invoice from a supplier the register can
 * name. Anything else is left where it is and said out loud, because a bulk action that guesses is
 * worse than a queue — a wrong filing is invisible and a stuck line is not.
 */
export async function resortInbox(ctx: { userId: string; userName: string }): Promise<ResortReport> {
  const items = await unsortedItems();
  const register = await allSuppliers(true);
  const out: ResortOutcome[] = [];

  for (const item of items) {
    const fileName = item.fileName ?? "";
    const from = item.fromAddress;
    const doc = item.documentId ? await db.query.documents.findFirst({ where: eq(schema.documents.id, item.documentId) }) : null;
    if (!doc) {
      out.push({ itemId: item.id, fileName, from, routedAs: null, detail: "the file behind this line is gone" });
      continue;
    }

    const matched = supplierForSender(register, from);
    if (!matched) {
      out.push({ itemId: item.id, fileName, from, routedAs: null, detail: `no supplier in the register sends from ${from}` });
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(doc.storageKey);
    } catch {
      out.push({ itemId: item.id, fileName, from, routedAs: null, detail: "the stored file could not be read" });
      continue;
    }

    const text = /\.pdf$/i.test(fileName) || doc.mimeType === "application/pdf" ? (() => { try { return pdfText(bytes); } catch { return null; } })() : null;

    if (!looksLikeInvoice({ fileName, mimeType: doc.mimeType, subject: item.subject ?? "", supplier: matched.name, text })) {
      out.push({ itemId: item.id, fileName, from, routedAs: null, detail: `from ${matched.name}, but it does not read as an invoice` });
      continue;
    }

    try {
      const filed = await fileInvoice(bytes, { fileName, mimeType: doc.mimeType, supplier: matched.name, supplierId: matched.id, from, subject: item.subject ?? "" }, ctx);
      const where = filingFor(filed.schedule).label;
      /*
       * A bill already on file is not an error and not a second bill. `fileInvoice` keeps the copy
       * and refuses to count the money twice; the line says so, because "filed" and "we already had
       * this" are different pieces of news to somebody working through a backlog.
       */
      const detail = filed.duplicateOf
        ? `${matched.name} — already on file, so the copy is kept and the money is not counted twice`
        : `${matched.name} — filed with ${where}${filed.needsReview ? ", and held for you to confirm" : ""}`;
      await db.update(schema.inboxItems).set({ routedAs: "invoice", routeResult: detail }).where(eq(schema.inboxItems.id, item.id));
      out.push({ itemId: item.id, fileName, from, routedAs: "invoice", detail });
    } catch (e) {
      out.push({ itemId: item.id, fileName, from, routedAs: null, detail: `could not be filed: ${(e as Error).message}` });
    }
  }

  return {
    looked: items.length,
    filed: out.filter((o) => o.routedAs).length,
    stillStuck: out.filter((o) => !o.routedAs).length,
    outcomes: out,
  };
}
