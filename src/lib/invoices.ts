import "server-only";
import { and, eq, gte, lte, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { todayIso, daysBetween } from "./dates";
import { storeFile, readFile as readStoredFile } from "./files";
import { readInvoice } from "./ai";
import { getSettings } from "./settings";
import { pdfText } from "./pdf-text";
import { allSuppliers, supplierForSender } from "./suppliers-registry";
import { scheduleFromNames, linesMatching } from "./controlled-names";
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

/**
 * What the invoice came to, where it says so.
 *
 * Only a labelled total is read. Every one of these invoices carries a dozen dollar amounts —
 * line extensions, subtotals by category, AWP, a statement balance — and picking the largest or
 * the last would be inventing a figure that goes onto a financial record and gets reconciled
 * against a payment. A missing amount is a blank somebody can fill in; a wrong one is a
 * discrepancy nobody can explain.
 *
 * The order matters. One wholesaler prints "TOTAL RX PURCHASES" and "NET PAYABLE" on the same
 * invoice, and the payable is the one the pharmacy is actually billed.
 */
export function readTotalCents(text: string): number | null {
  const patterns = [
    /net payable[^$\n]{0,60}\$\s*([\d,]+\.\d{2})/i,
    /total due[^$\n]{0,20}\$\s*([\d,]+\.\d{2})/i,
    /amount due[^$\n]{0,20}\$\s*([\d,]+\.\d{2})/i,
    /invoice total[^$\n]{0,20}\$\s*([\d,]+\.\d{2})/i,
    /balance due[^$\n]{0,20}\$\s*([\d,]+\.\d{2})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 100);
  }
  return null;
}

export type TextVerdict = {
  schedule: InvoiceSchedule;
  confident: boolean;
  basis: string;
  controlledItems: string[];
  /** Every item line read, controlled or not, so the invoice can be searched by what is on it. */
  allItems: string[];
  supplier: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  /** What it came to, where the invoice says so. Null rather than a guess. */
  totalCents: number | null;
};

/** "09/04/2026" as an ISO date, where it is one. */
function isoFrom(us: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(us.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

export function classifyInvoiceText(text: string): TextVerdict {
  const lines = text.split("\n");

  const supplier =
    text.match(/\bIndependent Pharmacy (?:Distributor|Cooperative)\b/i)?.[0] ??
    lines.find((l) => /\b(MCKESSON|CARDINAL|CENCORA|AMERISOURCE|MORRIS ?& ?DICKSON|HD SMITH|KINRAY|ANDA|SMITH DRUG|BURLINGTON)\b/i.test(l))
      ?.match(/\b(MCKESSON|CARDINAL|CENCORA|AMERISOURCE\w*|MORRIS ?& ?DICKSON|HD SMITH|KINRAY|ANDA|SMITH DRUG|BURLINGTON)\b/i)?.[0] ?? null;
  /*
   * The invoice number, and only the invoice number.
   *
   * Order matters here more than it looks. One supplier's header reads "INVOICE" on one line with
   * the order number under it and "Invoice Num:" further up — so the loose pattern, tried first,
   * confidently returned the order number. Two different numbers on one page, one of them the one
   * the wholesaler will quote back at you. The labelled forms are therefore all tried before
   * anything positional.
   */
  const invoiceNumber =
    text.match(/Billing No\.?:\s*(\S+)/i)?.[1] ??
    text.match(/Invoice Num(?:ber)?\.?:?\s*#?\s*(\S+)/i)?.[1] ??
    text.match(/Invoice No\.?:?\s*#?\s*(\S+)/i)?.[1] ??
    // "Invoice" on its own line with the number under it, which is how a Crystal Reports header
    // comes out once the columns are put back together. Last, because it is the guess.
    text.match(/^\s*Invoice\s*\n\s*#?\s*(\d{4,})\s*$/im)?.[1] ??
    null;
  const invoiceDate =
    isoFrom(text.match(/Billing Date:?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1] ?? "") ??
    isoFrom(text.match(/Invoice Date:?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1] ?? "") ??
    isoFrom(text.match(/Ship Date:?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1] ?? "") ??
    isoFrom(text.match(/Order Date:?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1] ?? "") ??
    // A date printed without leading zeros, which is how one supplier writes it.
    isoFrom(
      (text.match(/Invoice Date:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1] ?? "")
        .split("/")
        .map((x, i) => (i < 2 ? x.padStart(2, "0") : x))
        .join("/"),
    );

  const head = {
    supplier,
    invoiceNumber,
    invoiceDate,
    totalCents: readTotalCents(text),
    controlledItems: [] as string[],
    allItems: [] as string[],
  };

  const items: { line: string; cls: string }[] = [];
  for (const line of lines) {
    const m = ITEM_LINE.exec(line.trim());
    if (m) items.push({ line: line.trim().replace(/\s{2,}/g, " "), cls: m[3] });
  }

  /*
   * The other kind of invoice: one that names the schedule outright.
   *
   * A second wholesaler prints "C-2" and "C-3" in a DEA column beside each product rather than a
   * one-letter item class. That is a plainer statement than the class codes and worth reading
   * directly — but only in the direction that is safe. A C-2 marking on the page is proof there
   * is a Schedule II line on it. The absence of any marking, in a layout the site has only seen
   * a handful of times, is not proof of the opposite, so it does not get to conclude anything.
   *
   * The hyphen is required. "CII Subtotal" is a column heading that prints on every one of that
   * supplier's invoices, controlled or not, and reading a heading as evidence would file every
   * invoice they send as Schedule II.
   */
  /*
   * Item lines in a layout that carries no class column at all.
   *
   * A third wholesaler prints the NDC and the price and nothing about schedules — their only code
   * column means taxed, net priced or web special. Their lines are still recognisable: an
   * eleven-digit NDC, or a hyphenated one, next to a price.
   */
  const plainItems =
    items.length === 0
      ? lines
          .map((l) => l.trim())
          .filter((l) => /(?:\d{11}|\d{4,5}-\d{3,4}-\d{1,2})/.test(l) && /\$?\d[\d,]*\.\d{2}/.test(l))
          .map((l) => l.replace(/\s{2,}/g, " "))
      : [];

  if (items.length === 0) {
    const twoMarks = text.match(/\bC-\s?(?:2|II)\b/g) ?? [];
    const lowerMarks = text.match(/\bC-\s?(?:3|4|5|III|IV|V)\b/g) ?? [];

    if (twoMarks.length > 0) {
      return {
        ...head,
        schedule: "schedule_2",
        confident: true,
        controlledItems: lines.filter((l) => /\bC-\s?(?:2|II)\b/.test(l)).map((l) => l.trim().slice(0, 300)),
        allItems: [],
        basis: `The invoice marks ${twoMarks.length} item${twoMarks.length === 1 ? "" : "s"} as C-2 in its own schedule column.`,
      };
    }
    if (lowerMarks.length > 0) {
      return {
        ...head,
        schedule: "schedule_3_5",
        confident: true,
        controlledItems: lines.filter((l) => /\bC-\s?(?:3|4|5|III|IV|V)\b/.test(l)).map((l) => l.trim().slice(0, 300)),
        allItems: [],
        basis: `The invoice marks items as C-3, C-4 or C-5 in its own schedule column, and no C-2 marking appears anywhere on it.`,
      };
    }

    /*
     * Nothing on the page says what these are, so the drug names have to.
     *
     * A weaker source than the supplier's own marking, and only used where there is no marking to
     * use. It reads only the item lines, never the page — a recall notice in a header naming a
     * drug must not decide where an invoice is filed.
     *
     * The Schedule II list this leans on is meant to be complete for what a retail pharmacy can
     * buy, because that is the one this must not miss. A missed Schedule III to V is a much
     * smaller thing: 1304.04(h)(2) allows those to sit with ordinary business records provided
     * the information is readily retrievable, and here it is retrievable by supplier, month, drug
     * name and invoice number.
     */
    if (plainItems.length >= 3) {
      const byName = scheduleFromNames(plainItems);
      head.allItems = plainItems;
      if (byName.schedule === "schedule_2") {
        return {
          ...head,
          schedule: "schedule_2",
          confident: true,
          controlledItems: linesMatching(plainItems, byName.matched).map((l) => l.slice(0, 300)),
          basis: `This supplier prints no schedule on the invoice, so the item names were read: ${byName.matched.slice(0, 4).join(", ")} ${byName.matched.length === 1 ? "is a Schedule II drug" : "are Schedule II drugs"}.`,
        };
      }
      if (byName.schedule === "schedule_3_5") {
        return {
          ...head,
          schedule: "schedule_3_5",
          confident: true,
          controlledItems: linesMatching(plainItems, byName.matched).map((l) => l.slice(0, 300)),
          basis: `This supplier prints no schedule on the invoice, so the item names were read: ${byName.matched.slice(0, 4).join(", ")} ${byName.matched.length === 1 ? "is controlled" : "are controlled"}, and nothing on it is Schedule II.`,
        };
      }
      return {
        ...head,
        schedule: "none",
        confident: true,
        basis: `This supplier prints no schedule on the invoice, so all ${plainItems.length} item names were read and none of them is a controlled substance.`,
      };
    }
  }

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

  head.allItems = items.map((i) => i.line);

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
  meta: {
    fileName: string;
    mimeType: string;
    supplier: string | null;
    /** The register row the sender matched, when there is one. The name alone is only a label. */
    supplierId?: string | null;
    from: string;
    subject: string;
  },
  ctx: { userId: string; userName: string },
): Promise<FiledInvoice> {
  let schedule: InvoiceSchedule = "unknown";
  let basis = "Nothing read it.";
  let controlled: string[] = [];
  let supplier = meta.supplier;
  let invoiceNumber: string | null = null;
  let invoiceDate: string | null = null;
  let confident = false;
  let items: string[] = [];
  let totalCents: number | null = null;

  /*
   * The supplier's own answer first, and a model only where there isn't one.
   *
   * The wholesaler prints an item class beside every line, and that is the determination of the
   * party that actually shipped the goods. Reading it gives the same answer every time, costs
   * nothing, works with no API key, and can be tested against real invoices — none of which is
   * true of inferring a schedule from drug names. The model is the fallback for the cases the
   * rule cannot settle: a scan, an unfamiliar layout, a supplier who prints no class at all.
   */
  const text = textOf(buf);
  const fromText = text ? classifyInvoiceText(text) : null;

  if (fromText?.confident) {
    schedule = fromText.schedule;
    confident = true;
    basis = `Read from the invoice itself. ${fromText.basis}`;
    controlled = fromText.controlledItems;
    items = fromText.allItems;
    supplier = fromText.supplier || meta.supplier;
    invoiceNumber = fromText.invoiceNumber;
    invoiceDate = fromText.invoiceDate;
    totalCents = fromText.totalCents;
  } else {
    // Anything the rule could not settle, including a disagreement it spotted, goes to the model
    // — and if that is unavailable or unsure too, the invoice waits for a person.
    supplier = fromText?.supplier || meta.supplier;
    invoiceNumber = fromText?.invoiceNumber ?? null;
    invoiceDate = fromText?.invoiceDate ?? null;
    totalCents = fromText?.totalCents ?? null;
    controlled = fromText?.controlledItems ?? [];
    items = fromText?.allItems ?? [];
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
    // Capped, because this exists to be searched rather than read, and a hundred-line invoice
    // should not push anything else out of the page it is shown on.
    itemsText: items.join("\n").slice(0, 20000),
    totalCents,
    supplierId: meta.supplierId ?? null,
    needsReview: !confident,
    receivedFrom: meta.from,
  });
  if (text) await writeInvoiceLines(id, text);

  await storeInvoiceLines(id, { supplier, invoiceDate, text: text ?? "", printedTotalCents: totalCents });

  return { id, documentId, schedule, needsReview: !confident };
}

/** The invoice as text, or null for a scan with no text layer. Short text is treated as none. */
function textOf(buf: Buffer): string | null {
  try {
    const text = pdfText(buf);
    return text.length > 200 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Reads the item lines as numbers and stores them against the invoice.
 *
 * Replaces whatever lines the invoice had, so reading again after the reader improves gives the
 * improved answer and never two copies. The counts on the invoice say how far the read got: an
 * invoice with twelve lines read and three unread is a different fact from one with twelve lines.
 *
 * Nothing is stored unless the lines add up to the total printed on the invoice's face. A partial
 * read is the outcome that does damage — every figure that was read looks perfectly sound, and the
 * product whose line was dropped simply appears cheaper than the pharmacy actually paid.
 */
export async function writeInvoiceLines(invoiceId: string, text: string): Promise<{ read: number; unread: number; reconciles: boolean | null }> {
  const inv = await db.query.supplierInvoices.findFirst({ where: eq(schema.supplierInvoices.id, invoiceId) });
  const r = await storeInvoiceLines(invoiceId, {
    supplier: inv?.supplier ?? null,
    invoiceDate: inv?.invoiceDate ?? null,
    text,
    printedTotalCents: inv?.totalCents ?? null,
  });
  await db
    .update(schema.supplierInvoices)
    .set({ linesRead: r.stored, linesUnread: r.unread })
    .where(eq(schema.supplierInvoices.id, invoiceId));
  return { read: r.stored, unread: r.unread, reconciles: r.reconciles };
}

/** The lines of one invoice, in printed order. */
export async function invoiceLines(invoiceId: string) {
  return db.query.invoiceLines.findMany({
    where: eq(schema.invoiceLines.invoiceId, invoiceId),
    orderBy: (l, { asc }) => [asc(l.createdAt)],
  });
}

/**
 * Reads the lines off every invoice the line reader has not been run on.
 *
 * Every invoice filed before lines were kept has none, and the PDF is still here to ask. The same
 * reader runs, so an invoice in a layout it does not know comes back with partial lines or none,
 * and says so on the row rather than pretending.
 */
export async function backfillInvoiceLines(): Promise<{ invoices: number; linesRead: number; unreadable: number; unreconciled: number }> {
  const rows = await db.query.supplierInvoices.findMany({ where: isNull(schema.supplierInvoices.linesRead) });
  const { readFile } = await import("./files");
  let invoicesDone = 0;
  let linesRead = 0;
  let unreadable = 0;
  let unreconciled = 0;
  for (const row of rows) {
    const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, row.documentId) });
    if (!doc) continue;
    try {
      const text = textOf(await readFile(doc.storageKey));
      if (!text) {
        // A scan. Recorded as read with nothing found, so it is not asked again every time.
        await db.update(schema.supplierInvoices).set({ linesRead: 0, linesUnread: 0 }).where(eq(schema.supplierInvoices.id, row.id));
        unreadable++;
        continue;
      }
      const r = await writeInvoiceLines(row.id, text);
      invoicesDone++;
      linesRead += r.read;
      // Read, but the lines did not add up to the printed total, so none were kept. Named
      // separately: it is a layout this reader does not fully know, not a scan.
      if (r.reconciles === false) unreconciled++;
    } catch {
      unreadable++;
    }
  }
  return { invoices: invoicesDone, linesRead, unreadable, unreconciled };
}

/** How many invoices the line reader has never been run on. */
export async function invoicesWithoutLines(): Promise<number> {
  return (await db.query.supplierInvoices.findMany({ where: isNull(schema.supplierInvoices.linesRead), columns: { id: true } })).length;
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

export type InvoiceQuery = {
  schedule?: InvoiceSchedule;
  from?: string;
  to?: string;
  /** A single month, as YYYY-MM. Simpler than two dates for the question people actually ask. */
  month?: string;
  supplier?: string;
  /** Free text, matched against the supplier, the number, and every item line on the invoice. */
  text?: string;
  /** Only those nobody has confirmed. */
  unconfirmed?: boolean;
  /** A single day, for "what came in on the 4th". */
  on?: string;
  /** Amounts, in dollars, for finding the invoice somebody is querying. */
  minAmount?: number;
  maxAmount?: number;
  /** Only ones with no amount read, so they can be filled in. */
  noAmount?: boolean;
};

/**
 * The query an inspection actually asks: this schedule, these dates, nothing else.
 *
 * Which is the whole test under 1304.04(h) — not where the records live, but whether the
 * Schedule IIs come back on their own, immediately, with nothing else in the answer.
 */
export async function invoices(q: InvoiceQuery = {}): Promise<SupplierInvoice[]> {
  // A month is just a date range, and saying so here keeps one code path rather than two.
  const from = q.month ? `${q.month}-01` : q.from;
  const to = q.month ? `${q.month}-31` : q.to;

  const where = [
    q.schedule ? eq(schema.supplierInvoices.schedule, q.schedule) : undefined,
    // A single day beats a range of one day: "what arrived on the 4th" is asked far more often
    // than "between the 4th and the 4th".
    q.on ? eq(schema.supplierInvoices.invoiceDate, q.on) : undefined,
    !q.on && from ? gte(schema.supplierInvoices.invoiceDate, from) : undefined,
    !q.on && to ? lte(schema.supplierInvoices.invoiceDate, to) : undefined,
    q.supplier ? eq(schema.supplierInvoices.supplier, q.supplier) : undefined,
    q.unconfirmed ? eq(schema.supplierInvoices.needsReview, true) : undefined,
  ].filter(Boolean);

  const rows = await db.query.supplierInvoices.findMany({
    where: where.length ? and(...where) : undefined,
    orderBy: (i, { desc }) => [desc(i.invoiceDate), desc(i.createdAt)],
  });

  /*
   * Free text last, in memory, and deliberately so.
   *
   * The corpus is one pharmacy's invoices — thousands of rows at most, and the item text is
   * already in hand. Pushing this into SQL would mean a full-text index to maintain and a
   * migration to get wrong, in exchange for a difference nobody could perceive. Every word
   * typed has to appear somewhere, which is what makes "oxycodone march" behave the way
   * somebody expects rather than returning everything with either.
   */
  return rows
    .filter((r) => matchesText(r, q.text))
    .filter((r) => {
      if (q.noAmount) return r.totalCents === null;
      if (q.minAmount !== undefined && (r.totalCents === null || r.totalCents < q.minAmount * 100)) return false;
      if (q.maxAmount !== undefined && (r.totalCents === null || r.totalCents > q.maxAmount * 100)) return false;
      return true;
    });
}

/** What the shown invoices come to, so a filtered list answers "how much was that month". */
export function sumOf(rows: SupplierInvoice[]): { total: number; missing: number } {
  return {
    total: rows.reduce((n, r) => n + (r.totalCents ?? 0), 0),
    missing: rows.filter((r) => r.totalCents === null).length,
  };
}

/**
 * Whether one invoice answers a free-text search.
 *
 * Everything a person might have in their hand is searched: the supplier, the invoice number as
 * printed, the date, the address it arrived from, and every item line on it. The invoice number
 * matters as much as the drug names — it is what is written on a statement, quoted in an email
 * from the wholesaler, and read down the phone — and a partial one matches, because people
 * remember the last four digits rather than all ten.
 *
 * Every word typed has to appear somewhere. That is what makes "oxycodone august" behave the way
 * somebody expects instead of returning everything with either.
 */
export function matchesText(
  invoice: Pick<SupplierInvoice, "supplier" | "invoiceNumber" | "invoiceDate" | "itemsText" | "controlledItems" | "receivedFrom">,
  text: string | undefined,
): boolean {
  const terms = (text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = [
    invoice.supplier,
    invoice.invoiceNumber,
    invoice.invoiceDate,
    invoice.itemsText,
    invoice.controlledItems,
    invoice.receivedFrom,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** The suppliers that have actually sent something, for the filter. */
export async function invoiceSuppliers(): Promise<string[]> {
  const rows = await db.query.supplierInvoices.findMany();
  return [...new Set(rows.map((r) => r.supplier).filter((x): x is string => Boolean(x)))].sort();
}

/** The months that have invoices in them, newest first, so the picker offers only real months. */
export async function invoiceMonths(): Promise<string[]> {
  const rows = await db.query.supplierInvoices.findMany();
  return [...new Set(rows.map((r) => r.invoiceDate?.slice(0, 7)).filter((x): x is string => Boolean(x)))]
    .sort()
    .reverse();
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

/**
 * What is wrong with the invoice records right now.
 *
 * A mail-fed archive fails quietly, and every one of these is a way it does. The supplier changes
 * the address they send from and the invoices simply stop; a scan comes through that nothing
 * could read and sits unconfirmed; an invoice arrives with no date on it, so it is in the archive
 * but cannot be produced by a date range, which is the entire retrieval requirement. None of
 * those announce themselves. A pharmacy that trusted this and was not told would find out during
 * an inspection.
 *
 * Ordered worst first, and each one says what to do rather than only what is wrong.
 */
export type InvoiceIssue = {
  key: string;
  severity: "blocking" | "warn";
  title: string;
  detail: string;
  /** Where the fix is, when the site can offer one. */
  href?: string;
  action?: string;
};

/** Days of silence from a supplier before the silence is itself the news. */
const SUPPLIER_SILENT_DAYS = 21;

export async function invoiceIssues(): Promise<InvoiceIssue[]> {
  const rows = await db.query.supplierInvoices.findMany();
  const out: InvoiceIssue[] = [];
  const today = todayIso();

  if (rows.length === 0) return out;

  // ── Unconfirmed, and how long they have sat ──────────────────────
  const unconfirmed = rows.filter((r) => r.needsReview && !r.reviewedAt);
  if (unconfirmed.length > 0) {
    const oldest = unconfirmed
      .map((r) => r.createdAt.slice(0, 10))
      .sort()[0];
    const days = daysBetween(oldest, today);
    out.push({
      key: "unconfirmed",
      severity: days >= 7 ? "blocking" : "warn",
      title: `${unconfirmed.length} invoice${unconfirmed.length === 1 ? "" : "s"} nobody has confirmed`,
      detail:
        `Each is held with the Schedule II records, which is the safe place for it but not the right one. ` +
        (days >= 7
          ? `The oldest has been waiting ${days} days.`
          : `The oldest arrived ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}.`),
      href: "/inventory/invoices?unconfirmed=1",
      action: "Say what they carry",
    });
  }

  // ── Filed, but not retrievable by date ───────────────────────────
  const undated = rows.filter((r) => !r.invoiceDate);
  if (undated.length > 0) {
    out.push({
      key: "undated",
      severity: "blocking",
      title: `${undated.length} invoice${undated.length === 1 ? " has" : "s have"} no date`,
      detail:
        "An invoice with no date is in the archive but cannot be produced by a date range, which is exactly what an inspector asks for. Open each one and put the date on it.",
      href: "/inventory/invoices?undated=1",
      action: "Put the dates on",
    });
  }

  // ── The same invoice, filed twice ────────────────────────────────
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!r.invoiceNumber || !r.supplier) continue;
    const k = `${r.supplier}|${r.invoiceNumber}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  if (dupes.length > 0) {
    out.push({
      key: "duplicates",
      severity: "warn",
      title: `${dupes.length} invoice number${dupes.length === 1 ? " appears" : "s appear"} more than once`,
      detail:
        `Usually the supplier sent it twice, which is harmless. Occasionally it is two different invoices sharing a ` +
        `number, which is not. ${dupes.slice(0, 3).map(([k]) => k.split("|")[1]).join(", ")}${dupes.length > 3 ? " and others" : ""}.`,
      href: "/inventory/invoices",
      action: "Look at them",
    });
  }

  // ── A supplier that has gone quiet ───────────────────────────────
  /*
   * The failure this catches is the one nobody notices: the supplier changes the address they
   * send from, or the rule that recognises them stops matching, and the invoices simply stop
   * arriving. Nothing breaks, no error appears, and the pharmacy carries on believing its records
   * are being kept. Silence from a supplier that used to write every week is the only symptom.
   */
  const bySupplier = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.supplier || !r.invoiceDate) continue;
    bySupplier.set(r.supplier, [...(bySupplier.get(r.supplier) ?? []), r.invoiceDate]);
  }
  for (const [supplier, dates] of bySupplier) {
    // Only worth saying about a supplier that has written enough for silence to mean something.
    if (dates.length < 3) continue;
    const last = dates.sort().at(-1)!;
    const quiet = daysBetween(last, today);
    if (quiet < SUPPLIER_SILENT_DAYS) continue;
    out.push({
      key: `silent:${supplier}`,
      severity: "blocking",
      title: `Nothing from ${supplier} for ${quiet} days`,
      detail:
        `They have sent ${dates.length} invoices before this, and the last was ${last}. Either the pharmacy has ` +
        `stopped ordering, or they have changed the address they send from and the invoices are no longer being ` +
        `recognised — in which case records the pharmacy is required to keep are not being kept.`,
      href: "/settings/email",
      action: "Check the sender rules",
    });
  }

  /*
   * A supplier sending something they never send.
   *
   * The pharmacist knows which of his wholesalers he orders Schedule IIs from, and that knowledge
   * is worth having in the site — but never as a reason to file something as uncontrolled. Used
   * that way it would suppress exactly the event worth catching. Used this way it does the
   * opposite: an invoice that disagrees with what the pharmacy expects from that supplier is
   * surfaced, because a controlled substance arriving from somewhere it never arrives from is
   * either an ordering mistake or something worse, and it is invisible otherwise.
   */
  const s = await getSettings();
  for (const rule of parseExpected(s.supplier_expected_schedule ?? "")) {
    const surprises = rows.filter(
      (r) =>
        r.supplier &&
        r.supplier.toLowerCase().includes(rule.supplier.toLowerCase()) &&
        r.schedule !== "unknown" &&
        RANK[r.schedule] > RANK[rule.expected],
    );
    if (surprises.length === 0) continue;
    const worst = surprises.some((r) => r.schedule === "schedule_2");
    out.push({
      key: `unexpected:${rule.supplier}`,
      severity: "blocking",
      title: `${rule.supplier} sent ${worst ? "Schedule II" : "controlled"} items, which you said they never do`,
      detail:
        `${surprises.length} invoice${surprises.length === 1 ? "" : "s"} from them carr${surprises.length === 1 ? "ies" : "y"} ` +
        `${worst ? "a Schedule II line" : "controlled lines"}, and this supplier is recorded as sending ` +
        `${rule.expected === "none" ? "nothing controlled" : "Schedule III to V at most"}. Either the expectation is out of date, ` +
        `or something was ordered or shipped that should not have been. The invoices are filed correctly either way.`,
      href: `/inventory/invoices?q=${encodeURIComponent(rule.supplier)}`,
      action: "Look at them",
    });
  }

  const rank = { blocking: 0, warn: 1 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * What each supplier is expected to ship, as the pharmacy has told the site.
 *
 * One rule per line: "Independent Pharmacy Cooperative = none". Free text for the same reason the
 * sender rules are: the pharmacy knows its own suppliers and the site should not pretend to.
 */
export function parseExpected(raw: string): { supplier: string; expected: InvoiceSchedule }[] {
  const out: { supplier: string; expected: InvoiceSchedule }[] = [];
  for (const line of (raw ?? "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const supplier = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().toLowerCase().replace(/[\s_]/g, "-");
    const expected: InvoiceSchedule | null =
      v === "none" || v === "0" ? "none" : v === "3-5" || v === "iii-v" ? "schedule_3_5" : v === "2" || v === "ii" ? "schedule_2" : null;
    if (supplier && expected) out.push({ supplier, expected });
  }
  return out;
}

/** How strictly one schedule outranks another, for comparing what arrived against what was expected. */
const RANK: Record<InvoiceSchedule, number> = { none: 0, schedule_3_5: 1, schedule_2: 2, unknown: 2 };

export type ForwardResult = { sent: number; to: string; message: string };

/**
 * Sends selected invoices to somebody else, as attachments, from within the site.
 *
 * The alternative was going and finding each PDF, then attaching them by hand in a mail client —
 * which is how the accountant ends up with the wrong month and nobody can afterwards say what was
 * sent. Every send is recorded: who, what, when, and whether any Schedule II record was in it.
 * Forwarding a controlled substance record is a disclosure, and the pharmacy should be able to
 * say exactly what left the building.
 */
export async function forwardInvoices(
  ids: string[],
  to: string,
  note: string,
  user: { name: string },
): Promise<ForwardResult> {
  const address = to.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error("That is not an email address.");
  if (ids.length === 0) throw new Error("Nothing was selected.");

  const rows = await db.query.supplierInvoices.findMany();
  const chosen = rows.filter((r) => ids.includes(r.id));
  if (chosen.length === 0) throw new Error("Those invoices no longer exist.");

  const docs = await db.query.documents.findMany();
  const { readFile } = await import("./files");
  const attachments: { filename: string; content: Buffer; contentType?: string }[] = [];
  const missing: string[] = [];

  for (const inv of chosen) {
    const doc = docs.find((d) => d.id === inv.documentId);
    if (!doc) {
      missing.push(inv.invoiceNumber ?? inv.id);
      continue;
    }
    try {
      attachments.push({
        filename: doc.fileName,
        content: await readFile(doc.storageKey),
        contentType: doc.mimeType,
      });
    } catch {
      missing.push(inv.invoiceNumber ?? inv.id);
    }
  }
  if (attachments.length === 0) throw new Error("None of the selected files could be read, so nothing was sent.");

  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "The pharmacy";
  const hasTwo = chosen.some((i) => i.schedule === "schedule_2");
  const lines = [
    note.trim() || `${chosen.length} invoice${chosen.length === 1 ? "" : "s"} from ${pharmacy}.`,
    "",
    ...chosen.map(
      (i) =>
        `${i.invoiceDate ?? "no date"} · ${i.supplier ?? "supplier not recorded"} · ${i.invoiceNumber ?? "no number"} · ${filingFor(i.schedule).label}`,
    ),
    "",
    hasTwo
      ? "This message includes Schedule II purchase records. Handle and store them accordingly."
      : "",
    `Sent by ${user.name} from ${pharmacy}.`,
  ].filter((l) => l !== undefined);

  const { sendMail } = await import("./send-mail");
  const r = await sendMail(
    address,
    `${pharmacy}: ${chosen.length} supplier invoice${chosen.length === 1 ? "" : "s"}`,
    lines.join("\n"),
    attachments,
  );

  await db.insert(schema.invoiceForwards).values({
    id: newId(),
    toAddress: address,
    invoiceIds: chosen.map((i) => i.id).join("\n"),
    count: attachments.length,
    includedScheduleTwo: hasTwo,
    note: note.trim() || null,
    sentBy: user.name,
    error: r.ok ? null : r.error,
  });

  if (!r.ok) throw new Error(`Could not send: ${r.error}`);

  return {
    sent: attachments.length,
    to: address,
    message:
      `${attachments.length} invoice${attachments.length === 1 ? "" : "s"} accepted for delivery to ${address}` +
      (hasTwo ? ", including Schedule II records" : "") +
      "." +
      (missing.length ? ` ${missing.length} could not be read and ${missing.length === 1 ? "was" : "were"} left out: ${missing.join(", ")}.` : "") +
      " The send is recorded against your name.",
  };
}

/** What has been sent out, most recent first. */
export async function recentForwards(limit = 20) {
  const rows = await db.query.invoiceForwards.findMany({ orderBy: (f, { desc }) => [desc(f.sentAt)] });
  return rows.slice(0, limit);
}

/**
 * Puts a date on an invoice that arrived without one.
 *
 * A dateless invoice is in the archive and outside every date range, which is the one form of
 * retrieval an inspector actually uses. The date wanted is the one printed on the invoice, not
 * the day it arrived — so this is a person reading the document, not something to infer.
 */
export async function setInvoiceDate(id: string, invoiceDate: string, user: { name: string }): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) throw new Error("That is not a date.");
  const inv = await db.query.supplierInvoices.findFirst({ where: eq(schema.supplierInvoices.id, id) });
  if (!inv) throw new Error("That invoice no longer exists.");
  await db
    .update(schema.supplierInvoices)
    .set({ invoiceDate, basis: `${inv.basis ?? ""} Date entered by ${user.name} on ${todayIso()}.`.trim() })
    .where(eq(schema.supplierInvoices.id, id));
  await db.update(schema.documents).set({ effectiveOn: invoiceDate }).where(eq(schema.documents.id, inv.documentId));
}

/**
 * Documents that are supplier invoices but were never filed as one.
 *
 * Every invoice that arrived before this existed went into the document vault as an ordinary
 * report, and so did any that arrived from a sender the pharmacy had not yet named as a supplier.
 * They are in the building and they are not on the invoice screen, which is the worst of both
 * worlds: the pharmacy holds Schedule II records it cannot produce on demand, and believes it
 * holds none.
 *
 * Recognised on the same narrow evidence as an incoming attachment — a PDF whose name or title
 * says invoice, or one that came from a wholesaler — and offered for filing rather than filed
 * silently, because moving a document between categories on a guess is how a C2 record ends up
 * somewhere nobody looks.
 */
export async function adoptableDocuments(): Promise<
  { id: string; title: string; fileName: string; receivedFrom: string | null; effectiveOn: string | null }[]
> {
  const [docs, already] = await Promise.all([
    db.query.documents.findMany(),
    db.query.supplierInvoices.findMany(),
  ]);
  const claimed = new Set(already.map((i) => i.documentId));

  return docs
    .filter((d) => !claimed.has(d.id))
    .filter((d) => d.category !== "invoice_schedule_2" && d.category !== "invoice_schedule_3_5" && d.category !== "invoice")
    .filter((d) => /\.pdf$/i.test(d.fileName) || d.mimeType === "application/pdf")
    .filter((d) =>
      /invoice|inv\b|statement of account|packing (list|slip)|mckesson|independent pharmacy|cardinal|cencora|amerisource/i.test(
        `${d.title} ${d.fileName} ${d.notes ?? ""}`,
      ),
    )
    .map((d) => ({
      id: d.id,
      title: d.title || d.fileName,
      fileName: d.fileName,
      receivedFrom: d.notes?.match(/from ([^\s.]+@[^\s.]+\.\S+)/i)?.[1] ?? null,
      effectiveOn: d.effectiveOn,
    }))
    .sort((a, b) => (b.effectiveOn ?? "").localeCompare(a.effectiveOn ?? ""));
}

/**
 * Files a document that is already in the vault as the supplier invoice it always was.
 *
 * The document is not re-stored — it is the same file, and copying it would leave two. What
 * changes is the category, so it stops appearing among the general documents and starts appearing
 * in the list that has to be producible by schedule. Where the reading is not certain the invoice
 * lands with the Schedule IIs and waits, exactly as an emailed one would.
 */
export async function adoptDocument(documentId: string, ctx: { userId: string; userName: string }): Promise<FiledInvoice> {
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, documentId) });
  if (!doc) throw new Error("That document no longer exists.");

  const existing = await db.query.supplierInvoices.findFirst({
    where: eq(schema.supplierInvoices.documentId, documentId),
  });
  if (existing) throw new Error("That document is already filed as an invoice.");

  const { readFile } = await import("./files");
  const buf = await readFile(doc.storageKey);

  const text = textOf(buf);
  const fromText = text ? classifyInvoiceText(text) : null;

  let schedule: InvoiceSchedule = fromText?.confident ? fromText.schedule : "unknown";
  let basis = fromText?.confident
    ? `Read from the invoice itself. ${fromText.basis}`
    : (fromText?.basis ?? "The document could not be read as text.");
  let controlled = fromText?.controlledItems ?? [];
  let items = fromText?.allItems ?? [];
  let supplier = fromText?.supplier ?? null;
  /*
   * Who it came from, where the document remembers.
   *
   * A document adopted from the vault has no envelope any more — only the note written when it
   * arrived, which contains the sending address. Matching that against the register is what lets
   * an invoice filed long before this page existed still belong to a named supplier.
   */
  const register = await allSuppliers(true);
  const matched = supplierForSender(register, `${doc.notes ?? ""} ${doc.fileName ?? ""}`);
  let invoiceNumber = fromText?.invoiceNumber ?? null;
  let invoiceDate = fromText?.invoiceDate ?? doc.effectiveOn ?? null;
  const totalCents = fromText?.totalCents ?? null;

  if (!fromText?.confident) {
    try {
      const r = await readInvoice(buf, ctx);
      if (r.confident && r.schedule !== "unknown") {
        schedule = r.schedule;
        basis = `${basis} ${r.basis}`;
        if (r.controlledItems.length) controlled = r.controlledItems;
        supplier = r.supplier?.trim() || supplier;
        invoiceNumber = r.invoiceNumber?.trim() || invoiceNumber;
        if (/^\d{4}-\d{2}-\d{2}$/.test(r.invoiceDate ?? "")) invoiceDate = r.invoiceDate;
      } else {
        basis = `${basis} ${r.basis} The reading was not certain, so this is held for a person to confirm.`;
      }
    } catch (e) {
      basis = `${basis} It could not be read automatically either: ${e instanceof Error ? e.message : String(e)}.`;
    }
  }

  const filing = FILING[schedule];
  await db.update(schema.documents).set({ category: filing.category, effectiveOn: invoiceDate }).where(eq(schema.documents.id, documentId));

  const id = newId();
  await db.insert(schema.supplierInvoices).values({
    id,
    documentId,
    supplier: supplier ?? matched?.name ?? null,
    invoiceNumber,
    invoiceDate,
    schedule,
    basis: `${basis} Filed from a document already held, by ${ctx.userName}.`.trim(),
    controlledItems: controlled.join("\n"),
    itemsText: items.join("\n").slice(0, 20000),
    totalCents,
    supplierId: matched?.id ?? null,
    needsReview: !(fromText?.confident ?? false) && schedule === "unknown",
    receivedFrom: doc.notes ?? null,
  });
  if (text) await writeInvoiceLines(id, text);

  await storeInvoiceLines(id, { supplier, invoiceDate, text: text ?? "", printedTotalCents: totalCents });

  return { id, documentId, schedule, needsReview: schedule === "unknown" };
}

/** Files every document that looks like an invoice, in one press. */
export async function adoptAll(ctx: { userId: string; userName: string }): Promise<{ filed: number; problems: string[] }> {
  const out = { filed: 0, problems: [] as string[] };
  for (const d of await adoptableDocuments()) {
    try {
      await adoptDocument(d.id, ctx);
      out.filed++;
    } catch (e) {
      out.problems.push(`${d.title}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/** A PDF handed to the site directly, rather than emailed in. */
export async function uploadInvoice(file: File, ctx: { userId: string; userName: string }): Promise<FiledInvoice> {
  if (file.size === 0) throw new Error("That file is empty.");
  const buf = Buffer.from(await file.arrayBuffer());
  return fileInvoice(
    buf,
    { fileName: file.name, mimeType: file.type || "application/pdf", supplier: null, from: `uploaded by ${ctx.userName}`, subject: file.name },
    ctx,
  );
}

/**
 * Types in the amount an invoice did not label clearly enough to read.
 *
 * One wholesaler prints subtotals by schedule and no single figure for the invoice, so the total
 * has to come from a person. Better that than a number the site assembled from parts it guessed
 * belonged together — this figure gets reconciled against a payment.
 */
export async function setInvoiceTotal(id: string, dollars: number, user: { name: string }): Promise<void> {
  if (!Number.isFinite(dollars) || dollars < 0) throw new Error("That is not an amount.");
  const inv = await db.query.supplierInvoices.findFirst({ where: eq(schema.supplierInvoices.id, id) });
  if (!inv) throw new Error("That invoice no longer exists.");
  await db
    .update(schema.supplierInvoices)
    .set({
      totalCents: Math.round(dollars * 100),
      basis: `${inv.basis ?? ""} Amount entered by ${user.name} on ${todayIso()}.`.trim(),
    })
    .where(eq(schema.supplierInvoices.id, id));
}

export const money = (cents: number | null): string =>
  cents === null
    ? "—"
    : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Reads the amount off invoices that were filed before amounts were recorded.
 *
 * Every invoice already on file when the total column was added has no total and never will: the
 * reading happens once, as the invoice is filed, and nothing goes back. So the list showed blanks
 * against invoices whose PDFs plainly print a figure, which reads as the reader being broken
 * rather than as it never having been asked.
 *
 * The PDF is still here, so the answer is to ask it now. The same labelled-total rule applies —
 * net payable, total due, amount due, invoice total, balance due, in that order — so an invoice
 * that genuinely does not print one still comes back empty and still has to be typed in. That is
 * the honest outcome, not a failure: one of this pharmacy's three wholesalers prints subtotals by
 * schedule and no invoice total at all.
 */
export async function backfillTotals(): Promise<{ read: number; stillMissing: number; unreadable: number }> {
  const rows = await db.query.supplierInvoices.findMany({ where: isNull(schema.supplierInvoices.totalCents) });
  const { readFile } = await import("./files");
  let read = 0;
  let unreadable = 0;

  for (const row of rows) {
    const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, row.documentId) });
    if (!doc) continue;
    try {
      const text = pdfText(await readFile(doc.storageKey));
      const cents = readTotalCents(text);
      if (cents === null) continue;
      await db
        .update(schema.supplierInvoices)
        .set({ totalCents: cents })
        .where(eq(schema.supplierInvoices.id, row.id));
      read++;
    } catch {
      // A scan with no text layer. Not an error — it simply has to be typed in like the others.
      unreadable++;
    }
  }

  return { read, stillMissing: rows.length - read, unreadable };
}

/** How many invoices have no amount, so the page can offer to do something about it. */
export async function missingTotals(): Promise<number> {
  const rows = await db.query.supplierInvoices.findMany({ where: isNull(schema.supplierInvoices.totalCents) });
  return rows.length;
}

/**
 * Records that the goods on an invoice actually arrived, and matched.
 *
 * This is the step that lets the paper go. An emailed invoice is the original record and there is
 * no paper copy of it to keep — but the packing slip in the tote usually carries something the PDF
 * does not: somebody's initials, the date it was checked in, and a note where the count was short.
 * The moment anyone writes on that paper it stops being a duplicate and becomes the pharmacy's
 * record of receipt, which 21 CFR 1304.22(c) requires and which cannot then be thrown away.
 *
 * Recorded here, the electronic record carries the same three facts against the same invoice, so
 * the paper is genuinely redundant rather than merely inconvenient.
 */
export async function recordReceipt(
  id: string,
  input: { receivedOn: string; note: string },
  user: { name: string },
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.receivedOn)) throw new Error("Give the date the goods arrived.");
  const inv = await db.query.supplierInvoices.findFirst({ where: eq(schema.supplierInvoices.id, id) });
  if (!inv) throw new Error("That invoice no longer exists.");
  await db
    .update(schema.supplierInvoices)
    .set({
      receivedOn: input.receivedOn,
      receivedBy: user.name,
      receiptNote: input.note.trim() || null,
    })
    .where(eq(schema.supplierInvoices.id, id));
}

/** Invoices whose goods nobody has confirmed arrived. */
export async function awaitingReceipt(): Promise<SupplierInvoice[]> {
  // Controlled invoices only. 21 CFR 1304.22(c) wants a receipt record for controlled substances;
  // an invoice for bottles and vitamins needs none, and asking for one is work with no record
  // behind it. An invoice read as carrying nothing controlled ("none") is left out; one whose
  // schedule could not be read is asked about, because unknown is not the same as no.
  const rows = await db.query.supplierInvoices.findMany({ where: isNull(schema.supplierInvoices.receivedOn) });
  return rows
    .filter((r) => r.schedule !== "none")
    .sort((a, b) => (b.invoiceDate ?? "").localeCompare(a.invoiceDate ?? ""));
}

/**
 * Stores the item lines of an invoice, where they can be read and where they add up.
 *
 * Only when they reconcile against the total printed on the invoice's face. A partial read is the
 * outcome that does damage: every figure that was read looks perfectly sound, and the product
 * whose line was dropped simply appears cheaper than the pharmacy actually paid. Where the sum does
 * not match, nothing is stored and the count of unread lines is left for the invoice page to say,
 * because a purchasing recommendation built on three quarters of an invoice is worse than one built
 * on none of it.
 */
export async function storeInvoiceLines(
  invoiceId: string,
  meta: { supplier: string | null; invoiceDate: string | null; text: string; printedTotalCents: number | null },
): Promise<{ stored: number; unread: number; reconciles: boolean | null; readCents: number }> {
  const { parseInvoiceLines } = await import("./invoice-lines");
  if (!meta.text || meta.text.length < 200) return { stored: 0, unread: 0, reconciles: null, readCents: 0 };
  const parsed = parseInvoiceLines(meta.text, meta.printedTotalCents);
  if (parsed.lines.length === 0) return { stored: 0, unread: parsed.unreadable.length, reconciles: parsed.reconciles, readCents: 0 };
  if (parsed.reconciles === false) return { stored: 0, unread: parsed.lines.length + parsed.unreadable.length, reconciles: false, readCents: parsed.totalCents };

  await db.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId));
  const rows = parsed.lines.map((l) => ({
    id: newId(),
    invoiceId,
    supplier: meta.supplier,
    invoiceDate: meta.invoiceDate,
    ndc11: l.ndc11,
    description: l.description,
    itemNumber: l.itemNumber,
    quantity: l.quantity,
    unitOfMeasure: l.unitOfMeasure,
    unitCostCents: l.unitCostCents,
    extendedCents: l.extendedCents,
    awpCents: l.awpCents,
    itemClass: l.itemClass,
    rebated: l.rebated,
  }));
  for (let i = 0; i < rows.length; i += 200) await db.insert(schema.invoiceLines).values(rows.slice(i, i + 200));
  return { stored: rows.length, unread: parsed.unreadable.length, reconciles: parsed.reconciles, readCents: parsed.totalCents };
}


