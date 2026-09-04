import "server-only";
import { and, eq, gte, lte, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { todayIso } from "./dates";
import { storeFile } from "./files";
import { readInvoice } from "./ai";
import type { InvoiceSchedule, DocumentCategory } from "@/db/schema";

/**
 * Supplier invoices, filed so the Schedule IIs are genuinely kept apart.
 *
 * The requirement people misread as "paper" is really about separation. 21 CFR 1304.04(h)(1):
 * Schedule II records are maintained separately from all other records of the registrant.
 * (h)(2): Schedule III-V records are maintained either separately, or in a form where the
 * required information is readily retrievable from the pharmacy's ordinary business records. An
 * electronic system satisfies both — the test is whether somebody can hand an inspector every
 * Schedule II invoice for a period, on its own, without sorting through anything.
 *
 * So the separation is made three times over, because each is what a different person would
 * check. The row says which schedule it carries. The document category matches, so the general
 * document list cannot show a C2 invoice among the rest. And the file itself is written to its
 * own directory, so the separation survives somebody copying the folder off this machine.
 *
 * The only real risk is a Schedule II invoice landing anywhere else, so anything unread, partial
 * or doubtful is filed as unknown and waits for a person. An invoice in a review queue is a
 * minute of somebody's day. A C2 invoice quietly in with the floor stock is the finding.
 */

/** Where each schedule's files and documents go. Nothing shares a bucket with Schedule II. */
const FILING: Record<InvoiceSchedule, { folder: string; category: DocumentCategory; label: string }> = {
  schedule_2: { folder: "controlled-schedule-2", category: "invoice_schedule_2", label: "Schedule II" },
  schedule_3_5: { folder: "controlled-schedule-3-5", category: "invoice_schedule_3_5", label: "Schedule III-V" },
  none: { folder: "invoices", category: "invoice", label: "No controlled substances" },
  // Unread invoices are kept with the Schedule IIs until somebody says otherwise. Filing an
  // unknown with the ordinary invoices would be assuming the answer in the one direction that
  // breaks the rule; keeping it here is only ever over-cautious.
  unknown: { folder: "controlled-schedule-2", category: "invoice_schedule_2", label: "Not yet read" },
};

export function filingFor(schedule: InvoiceSchedule) {
  return FILING[schedule];
}

export type SupplierInvoice = typeof schema.supplierInvoices.$inferSelect;

/**
 * Whether an incoming attachment is a supplier invoice.
 *
 * Deliberately narrow: a PDF, from a sender the pharmacy has already named as a supplier, whose
 * subject or file name says invoice. Everything else stays on the path it was on. A rule that
 * swept up too much would file the wrong things under a heading an inspector reads first.
 */
export function looksLikeInvoice(opts: {
  fileName: string;
  mimeType: string;
  subject: string;
  supplier: string | null;
}): boolean {
  const isPdf = /\.pdf$/i.test(opts.fileName) || opts.mimeType === "application/pdf";
  if (!isPdf) return false;
  if (!opts.supplier) return false;
  return /invoice|inv\b|statement of account|packing (list|slip)/i.test(`${opts.subject} ${opts.fileName}`);
}

export type FiledInvoice = { id: string; documentId: string; schedule: InvoiceSchedule; needsReview: boolean };

/**
 * Reads an invoice, files it where its schedule says, and records why.
 *
 * The read happens before the file is written, so an invoice only ever lands in one place. Where
 * the read fails entirely the invoice is still filed — as unknown, with the Schedule IIs — because
 * losing a supplier invoice is not an improvement on filing it cautiously.
 */
export async function fileInvoice(
  buf: Buffer,
  meta: { fileName: string; mimeType: string; supplier: string | null; from: string; subject: string },
  ctx: { userId: string; userName: string },
): Promise<FiledInvoice> {
  let schedule: InvoiceSchedule = "unknown";
  let basis = "Nothing read it.";
  let controlled: string[] = [];
  let supplier = meta.supplier;
  let invoiceNumber: string | null = null;
  let invoiceDate: string | null = null;
  let confident = false;

  try {
    const r = await readInvoice(buf, ctx);
    schedule = r.confident ? r.schedule : "unknown";
    confident = r.confident && r.schedule !== "unknown";
    basis = r.confident
      ? r.basis
      : `${r.basis} The reading was not certain, so this is held for a person to confirm.`;
    controlled = r.controlledItems;
    supplier = r.supplier?.trim() || meta.supplier;
    invoiceNumber = r.invoiceNumber?.trim() || null;
    invoiceDate = /^\d{4}-\d{2}-\d{2}$/.test(r.invoiceDate ?? "") ? r.invoiceDate : null;
  } catch (e) {
    basis = `Could not be read automatically: ${e instanceof Error ? e.message : String(e)}. Held with the Schedule II records until somebody says otherwise.`;
  }

  const filing = FILING[schedule];
  const file = new File([new Uint8Array(buf)], meta.fileName, { type: meta.mimeType || "application/pdf" });
  const stored = await storeFile(file, { allowReportTypes: true, folder: filing.folder });

  const documentId = newId();
  await db.insert(schema.documents).values({
    id: documentId,
    category: filing.category,
    title: [supplier, invoiceNumber ? `invoice ${invoiceNumber}` : null, invoiceDate].filter(Boolean).join(" · ") ||
      meta.subject ||
      meta.fileName,
    fileName: meta.fileName,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    storageKey: stored.storageKey,
    effectiveOn: invoiceDate,
    notes: `Received from ${meta.from}. ${basis}`,
    uploadedBy: ctx.userId || "mailbox-sweep",
  });

  const id = newId();
  await db.insert(schema.supplierInvoices).values({
    id,
    documentId,
    supplier,
    invoiceNumber,
    invoiceDate,
    schedule,
    basis,
    controlledItems: controlled.join("\n"),
    needsReview: !confident,
    receivedFrom: meta.from,
  });

  return { id, documentId, schedule, needsReview: !confident };
}

/** Corrects, or confirms, what an invoice carries. The one action that must always be available. */
export async function setSchedule(
  id: string,
  schedule: InvoiceSchedule,
  user: { name: string },
): Promise<void> {
  const inv = await db.query.supplierInvoices.findFirst({ where: eq(schema.supplierInvoices.id, id) });
  if (!inv) throw new Error("That invoice no longer exists.");

  const filing = FILING[schedule];
  await db
    .update(schema.documents)
    .set({ category: filing.category })
    .where(eq(schema.documents.id, inv.documentId));
  await db
    .update(schema.supplierInvoices)
    .set({
      schedule,
      needsReview: schedule === "unknown",
      reviewedBy: user.name,
      reviewedAt: new Date().toISOString(),
      basis: `${inv.basis ?? ""} Confirmed as ${filing.label} by ${user.name} on ${todayIso()}.`.trim(),
    })
    .where(eq(schema.supplierInvoices.id, id));
}

export type InvoiceQuery = { schedule?: InvoiceSchedule; from?: string; to?: string };

/**
 * The query an inspection actually asks: this schedule, these dates, nothing else.
 *
 * Which is the whole test under 1304.04(h) — not where the records live, but whether the
 * Schedule IIs come back on their own, immediately, with nothing else in the answer.
 */
export async function invoices(q: InvoiceQuery = {}): Promise<SupplierInvoice[]> {
  const where = [
    q.schedule ? eq(schema.supplierInvoices.schedule, q.schedule) : undefined,
    q.from ? gte(schema.supplierInvoices.invoiceDate, q.from) : undefined,
    q.to ? lte(schema.supplierInvoices.invoiceDate, q.to) : undefined,
  ].filter(Boolean);
  return db.query.supplierInvoices.findMany({
    where: where.length ? and(...where) : undefined,
    orderBy: (i, { desc }) => [desc(i.invoiceDate), desc(i.createdAt)],
  });
}

/** Anything the reader was not sure about, which is the only queue that must not grow quietly. */
export async function awaitingReview(): Promise<SupplierInvoice[]> {
  return db.query.supplierInvoices.findMany({
    where: and(eq(schema.supplierInvoices.needsReview, true), isNull(schema.supplierInvoices.reviewedAt)),
    orderBy: (i, { desc }) => [desc(i.createdAt)],
  });
}

export type InvoiceCounts = Record<InvoiceSchedule, number> & { review: number; total: number };

export async function invoiceCounts(): Promise<InvoiceCounts> {
  const all = await db.query.supplierInvoices.findMany();
  return {
    schedule_2: all.filter((i) => i.schedule === "schedule_2").length,
    schedule_3_5: all.filter((i) => i.schedule === "schedule_3_5").length,
    none: all.filter((i) => i.schedule === "none").length,
    unknown: all.filter((i) => i.schedule === "unknown").length,
    review: all.filter((i) => i.needsReview && !i.reviewedAt).length,
    total: all.length,
  };
}
