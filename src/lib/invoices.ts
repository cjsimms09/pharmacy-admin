import "server-only";
import { and, eq, gte, lte, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { todayIso } from "./dates";
import { storeFile } from "./files";
import { readInvoice } from "./ai";
import { pdfText } from "./pdf-text";
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

/**
 * Reading the schedule the wholesaler already printed.
 *
 * McKesson — and every other wholesaler that prints an item class — puts a single letter beside
 * each line saying what that item is. The pharmacy's own invoices carry R against ordinary legend
 * drugs, X against every Schedule II, and B, D or E against the Schedule III to V lines. That is
 * the supplier's own determination, made by the party that shipped the goods, and it is a better
 * source than anything that reads the drug names and infers a schedule.
 *
 * So the ordinary case is settled by a rule: same answer every time, no API key needed, free,
 * and testable. Judgement is kept for what actually needs it — a scan, an unfamiliar layout, a
 * supplier who prints no class at all.
 *
 * The asymmetry is the whole design. An unrecognised class letter does not mean uncontrolled, it
 * means unknown, and unknown goes to a person. Only a page where every line carries a class this
 * knows to be non-controlled is allowed to be filed as ordinary business records.
 */

/** Item classes that mean Schedule II. */
const CLASS_SCHEDULE_2 = new Set(["X", "A"]);
/** Item classes that mean Schedule III, IV or V. */
const CLASS_SCHEDULE_3_5 = new Set(["B", "C", "D", "E"]);
/** Item classes known to be nothing of the sort: legend, OTC, supplies. */
const CLASS_UNCONTROLLED = new Set(["R", "O", "N", "S", "G", "H", "P", "T", "V", "W", "Y", "Z"]);

/** A line of the invoice's item table, and what the supplier said it was. */
const ITEM_LINE = /^(\d{4,5}-\d{3,4}-\d{2}|\d{5}-\d{4}-\d{2}).{0,200}?\s([\d,]+\.\d{2})\s+([A-Z])\s/;

export type TextVerdict = {
  schedule: InvoiceSchedule;
  confident: boolean;
  basis: string;
  controlledItems: string[];
  supplier: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
};

/** "09/04/2026" as an ISO date, where it is one. */
function isoFrom(us: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(us.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

export function classifyInvoiceText(text: string): TextVerdict {
  const lines = text.split("\n");

  const supplier =
    lines.find((l) => /\b(MCKESSON|CARDINAL|CENCORA|AMERISOURCE|MORRIS ?& ?DICKSON|HD SMITH|KINRAY|ANDA|SMITH DRUG|BURLINGTON)\b/i.test(l))
      ?.match(/\b(MCKESSON|CARDINAL|CENCORA|AMERISOURCE\w*|MORRIS ?& ?DICKSON|HD SMITH|KINRAY|ANDA|SMITH DRUG|BURLINGTON)\b/i)?.[0] ?? null;
  const invoiceNumber = text.match(/Billing No\.?:\s*(\S+)/i)?.[1] ?? text.match(/Invoice (?:No|Number)\.?:?\s*(\S+)/i)?.[1] ?? null;
  const invoiceDate =
    isoFrom(text.match(/Billing Date:?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1] ?? "") ??
    isoFrom(text.match(/Invoice Date:?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1] ?? "");

  const items: { line: string; cls: string }[] = [];
  for (const line of lines) {
    const m = ITEM_LINE.exec(line.trim());
    if (m) items.push({ line: line.trim().replace(/\s{2,}/g, " "), cls: m[3] });
  }

  const head = { supplier, invoiceNumber, invoiceDate, controlledItems: [] as string[] };

  if (items.length === 0) {
    return {
      ...head,
      schedule: "unknown",
      confident: false,
      basis: "No item lines could be read from this document, so nothing can be said about what it carries.",
    };
  }

  const two = items.filter((i) => CLASS_SCHEDULE_2.has(i.cls));
  const lower = items.filter((i) => CLASS_SCHEDULE_3_5.has(i.cls));
  const unrecognised = items.filter(
    (i) => !CLASS_SCHEDULE_2.has(i.cls) && !CLASS_SCHEDULE_3_5.has(i.cls) && !CLASS_UNCONTROLLED.has(i.cls),
  );

  if (two.length > 0) {
    return {
      ...head,
      schedule: "schedule_2",
      confident: true,
      controlledItems: [...two, ...lower].map((i) => i.line),
      basis: `${two.length} line${two.length === 1 ? "" : "s"} carry the supplier's Schedule II item class, out of ${items.length} read.`,
    };
  }

  // A CSOS order number on a page nothing else marked as controlled is a contradiction, and a
  // contradiction about Schedule II is never resolved by picking the convenient side.
  if (/CSOS ID/i.test(text)) {
    return {
      ...head,
      schedule: "unknown",
      confident: false,
      controlledItems: items.map((i) => i.line),
      basis:
        "The invoice carries a CSOS order number, which is used for controlled orders, but no line was marked with a controlled item class. That disagreement needs a person.",
    };
  }

  if (lower.length > 0 && unrecognised.length === 0) {
    return {
      ...head,
      schedule: "schedule_3_5",
      confident: true,
      controlledItems: lower.map((i) => i.line),
      basis: `${lower.length} controlled line${lower.length === 1 ? "" : "s"}, all in the supplier's Schedule III to V item classes, and no Schedule II class anywhere on the invoice.`,
    };
  }

  if (unrecognised.length > 0) {
    return {
      ...head,
      schedule: "unknown",
      confident: false,
      controlledItems: unrecognised.map((i) => i.line),
      basis: `${unrecognised.length} line${unrecognised.length === 1 ? " carries an item class" : "s carry item classes"} this does not recognise (${[...new Set(unrecognised.map((i) => i.cls))].join(", ")}), so what they are has to be confirmed.`,
    };
  }

  return {
    ...head,
    schedule: "none",
    confident: true,
    basis: `All ${items.length} lines carry item classes the supplier uses for non-controlled goods, and no controlled class appears anywhere on the invoice.`,
  };
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

  /*
   * The supplier's own answer first, and a model only where there isn't one.
   *
   * The wholesaler prints an item class beside every line, and that is the determination of the
   * party that actually shipped the goods. Reading it gives the same answer every time, costs
   * nothing, works with no API key, and can be tested against real invoices — none of which is
   * true of inferring a schedule from drug names. The model is the fallback for the cases the
   * rule cannot settle: a scan, an unfamiliar layout, a supplier who prints no class at all.
   */
  const fromText = (() => {
    try {
      const text = pdfText(buf);
      return text.length > 200 ? classifyInvoiceText(text) : null;
    } catch {
      return null;
    }
  })();

  if (fromText?.confident) {
    schedule = fromText.schedule;
    confident = true;
    basis = `Read from the invoice itself. ${fromText.basis}`;
    controlled = fromText.controlledItems;
    supplier = fromText.supplier || meta.supplier;
    invoiceNumber = fromText.invoiceNumber;
    invoiceDate = fromText.invoiceDate;
  } else {
    // Anything the rule could not settle, including a disagreement it spotted, goes to the model
    // — and if that is unavailable or unsure too, the invoice waits for a person.
    supplier = fromText?.supplier || meta.supplier;
    invoiceNumber = fromText?.invoiceNumber ?? null;
    invoiceDate = fromText?.invoiceDate ?? null;
    controlled = fromText?.controlledItems ?? [];
    basis = fromText?.basis ?? "The invoice could not be read as text.";
    try {
      const r = await readInvoice(buf, ctx);
      schedule = r.confident ? r.schedule : "unknown";
      confident = r.confident && r.schedule !== "unknown";
      basis = `${basis} ${r.confident ? r.basis : `${r.basis} The reading was not certain, so this is held for a person to confirm.`}`;
      if (r.controlledItems.length > 0) controlled = r.controlledItems;
      supplier = r.supplier?.trim() || supplier;
      invoiceNumber = r.invoiceNumber?.trim() || invoiceNumber;
      if (/^\d{4}-\d{2}-\d{2}$/.test(r.invoiceDate ?? "")) invoiceDate = r.invoiceDate;
    } catch (e) {
      basis = `${basis} It could not be read automatically either: ${e instanceof Error ? e.message : String(e)}. Held with the Schedule II records until somebody says otherwise.`;
    }
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
