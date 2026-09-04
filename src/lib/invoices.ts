import "server-only";
import { and, eq, gte, lte, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { todayIso, daysBetween } from "./dates";
import { storeFile } from "./files";
import { readInvoice } from "./ai";
import { getSettings } from "./settings";
import { pdfText } from "./pdf-text";
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
  let items: string[] = [];

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
    items = fromText.allItems;
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
    from ? gte(schema.supplierInvoices.invoiceDate, from) : undefined,
    to ? lte(schema.supplierInvoices.invoiceDate, to) : undefined,
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
  return rows.filter((r) => matchesText(r, q.text));
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
