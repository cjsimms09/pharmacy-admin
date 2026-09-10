import "server-only";
import { and, eq, gte, lte, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { FROM_SUMMARY } from "./invoice-summary-store";
import { todayIso, daysBetween } from "./dates";
import { storeFile, readFile as readStoredFile } from "./files";
import { readInvoice } from "./ai";
import { getSettings } from "./settings";
import { pdfText } from "./pdf-text";
import { looksLikeRebateReport } from "./rebate-report";
import { isDrillDownText } from "./drill-down-read";
import { allSuppliers, supplierForSender, supplierRecordFor } from "./suppliers-registry";
import { scheduleFromNames, linesMatching } from "./controlled-names";
import { audit } from "./audit";
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
export type SupplierDocumentKind = "invoice" | "statement" | "rebate_report" | "credit_memo" | "purchase_report" | "unknown";

/**
 * What a supplier actually sent, read off the document rather than off the subject line.
 *
 * A wholesaler sends four kinds of paper and they are not interchangeable. An **invoice** is a
 * record of goods received, and its Schedule II copy has to be held apart from every other record
 * the registrant keeps (21 CFR 1304.04(h)(1)). A **statement** is a summary of an account: it
 * records no receipt of anything, and filing one under the invoice headings puts a document that
 * proves nothing into the file an inspector reads first. A **rebate breakdown** carries the tier
 * ladder. A **credit memo** is money coming back, usually for a return.
 *
 * The distinction that does the work is the item table. Every invoice lists what was shipped, with
 * an NDC against each line; a statement lists invoice numbers and balances and carries no NDC at
 * all. So a document that talks like a statement and has no item lines is a statement, whatever
 * the subject line says — and a document with item lines is not demoted to a statement merely for
 * printing the word "statement" in a footer.
 */
export function classifySupplierDocument(text: string | null | undefined, fileName = "", subject = ""): { kind: SupplierDocumentKind; why: string } {
  const words = text ?? "";
  /*
   * The pharmacy's own daily purchase report, named before anything else looks at it.
   *
   * It carries no NDCs and no statement wording, so it came out "unknown" — and unknown is what
   * the invoice backlog offers for filing. It arrived every morning, went on the list every
   * morning, and the only way off the list was a Delete that would have destroyed the month's
   * GCR readings with it.
   */
  if (words && isDrillDownText(words, fileName)) {
    return { kind: "purchase_report", why: "It is the daily Purchase Drill Down — a summary of what was bought, not a bill for it." };
  }
  if (words && looksLikeRebateReport(words)) {
    return { kind: "rebate_report", why: "It is a rebate breakdown: it carries the tier table and the month's settlement, not goods." };
  }

  // How many lines look like an item shipped: an NDC and a price on the same line.
  const itemLines = words
    .split(/\r?\n/)
    .filter((l) => /(?:\d{11}|\d{4,5}-\d{3,4}-\d{1,2})/.test(l) && /\$?\d[\d,]*\.\d{2}/.test(l)).length;

  const said = `${subject} ${fileName}`;
  const creditWords = /\bcredit (?:memo|memorandum|note|invoice)\b|\bRGA\b|\breturn(?:ed)? goods authorisation\b|\breturn(?:ed)? goods authorization\b/i;
  if (creditWords.test(words.slice(0, 4000)) || creditWords.test(said)) {
    return { kind: "credit_memo", why: "It is a credit memo — money coming back, not goods going out." };
  }

  /*
   * Statement wording. Aging buckets are the giveaway that nothing else prints: a statement of
   * account sets out what is current, 30, 60 and 90 days old, and no invoice has any reason to.
   */
  const statementWords =
    /statement of account|\bremittance advice\b|balance forward|previous balance|amount enclosed|\baging\b|past due summary/i.test(words) ||
    /\b(?:31|30)[\s-]*(?:to|-)?\s*60\s*days?\b/i.test(words) ||
    (/\bstatement\b/i.test(words.slice(0, 1500)) && /\bbalance\b/i.test(words));

  if (statementWords && itemLines < 2) {
    return {
      kind: "statement",
      why:
        "It reads as a statement of account — balances and invoice numbers — and carries no item lines with NDCs on them, " +
        "so it is a summary of the account rather than a record that goods were received.",
    };
  }
  if (itemLines >= 2) {
    return { kind: "invoice", why: `It lists ${itemLines} item lines with NDCs and prices, which is what an invoice is.` };
  }
  if (statementWords) {
    return { kind: "statement", why: "It reads as a statement of account." };
  }
  return { kind: "unknown", why: "Nothing in it settles what kind of document it is." };
}

/**
 * Whether an attachment should be filed as a supplier invoice.
 *
 * Deliberately narrow: a PDF, from a sender the pharmacy has already named as a supplier, whose
 * subject or file name says invoice — and which, where its words can be read, is not something
 * else. Everything else stays on the path it was on. A rule that swept up too much would file the
 * wrong things under a heading an inspector reads first.
 */
export function looksLikeInvoice(opts: {
  fileName: string;
  mimeType: string;
  subject: string;
  supplier: string | null;
  /** The document's own words, where they could be read. A statement is never an invoice. */
  text?: string | null;
}): boolean {
  const isPdf = /\.pdf$/i.test(opts.fileName) || opts.mimeType === "application/pdf";
  if (!isPdf) return false;
  if (!opts.supplier) return false;
  /*
   * What the document says beats what the subject line calls it.
   *
   * McKesson's monthly rebate breakdown is a PDF from a known supplier, and a subject line reading
   * "statement of account" matched the words below — so it was filed as an invoice with an
   * unreadable schedule and held with the Schedule II records, and the tier ladder inside it was
   * never read. Then an IPD statement of account did the same thing for the same reason. The
   * subject is written by whoever sent the email; the document is the document.
   */
  if (opts.text) {
    const kind = classifySupplierDocument(opts.text, opts.fileName, opts.subject).kind;
    if (kind !== "invoice" && kind !== "unknown") return false;
  }
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
/**
 * A credit memo's total is negative, and this used to be unable to say so.
 *
 * The owner: "we got an invoice credit from IPC did we read it right and apply credit?" It could
 * not have. Every pattern below captured only the digits, so "TOTAL DUE -$123.45" and the
 * accountant's "TOTAL DUE ($123.45)" both came back as a positive $123.45 — and the guard on the
 * next line, `n >= 0`, could never fire because the capture group had no way to hold a sign.
 *
 * A credit filed as an invoice is wrong twice over: the money it should have taken off purchases is
 * added instead, so the cash account moves by twice the credit and in the wrong direction. On a
 * $123.45 credit that is $246.90.
 *
 * Both forms are read here. The minus may sit before the dollar sign or after it, and brackets
 * around the figure are the same statement in accounting notation.
 */
const NEGATIVE_BEFORE = /(?:-\s*\$|\$\s*-)\s*[\d,]+\.\d{2}\s*$/;

function signedCents(matched: string, whole: string, at: number): number | null {
  const n = Number(matched.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  // The twenty characters before the figure carry the sign, if it has one.
  const before = whole.slice(Math.max(0, at - 20), at);
  const after = whole.slice(at + matched.length, at + matched.length + 2);
  const bracketed = /\(\s*\$?\s*$/.test(before) && /^\s*\)/.test(after);
  const minus = /-\s*\$?\s*$/.test(before);
  return Math.round(n * 100) * (bracketed || minus ? -1 : 1);
}

export function readTotalCents(text: string): number | null {
  const patterns = [
    /net payable[^$\n]{0,60}\$\s*(-?[\d,]+\.\d{2})/i,
    /total due[^$\n]{0,20}\$\s*(-?[\d,]+\.\d{2})/i,
    /amount due[^$\n]{0,20}\$\s*(-?[\d,]+\.\d{2})/i,
    /invoice total[^$\n]{0,20}\$\s*(-?[\d,]+\.\d{2})/i,
    /balance due[^$\n]{0,20}\$\s*(-?[\d,]+\.\d{2})/i,
    /*
     * IPD prints the figure above its label rather than beside it: the money is on one line and the
     * word "Subtotal" on the next. Nothing else the pharmacy receives is laid out that way, and
     * without this its invoices carried no total at all — so nothing was reconciled against
     * anything, and a dropped line would never have been noticed. One had been: $114.00 of drops.
     */
    /([\d,]+\.\d{2})\s*[\r\n]+\s*Subtotal\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    /*
     * Where the figure sits in the page, so the sign in front of it can be read. `m.index` is the
     * start of the whole match, not of the captured number, so the offset is found from the match.
     */
    const at = m.index + m[0].lastIndexOf(m[1]);
    const cents = signedCents(m[1], text, at);
    if (cents !== null) return cents;
  }
  return null;
}

/** True where the document is a credit rather than a bill: a negative total, or it says so. */
export function looksLikeCredit(text: string, totalCents: number | null): boolean {
  if (totalCents !== null && totalCents < 0) return true;
  return /\bcredit\s+(memo|note|invoice)\b|\bmemo\s+credit\b|\breturn\s+credit\b/i.test(text);
}

/**
 * What the invoice says its goods came to, before shipping and tax.
 *
 * A different figure from the amount due, and the right one to check item lines against. IPC's
 * invoice for the Omnipod pods reads "Sub Total $1,520.89", "Shipping/Handling $10.00", "Total Due
 * $1,530.89" — so the lines can only ever add up to the first of those, and checking them against
 * the last refused a perfectly good reading and left $1,520.89 of purchases with no items behind
 * it. The amount due is still what the pharmacy owes and is still what is stored on the invoice;
 * this is only the figure the reading is proved against.
 *
 * Null where the invoice prints no separate goods subtotal, which is most of them — then the
 * amount due is the only figure there is and the check uses it, as it always did.
 */
export function readGoodsSubtotalCents(text: string): number | null {
  const patterns = [
    /*
     * The label has to start its line.
     *
     * Without that anchor this matched "CII Subtotal:$3,022.32" — the heading that closes the
     * Schedule II half of an IPD invoice — and then refused the whole reading for not adding up to
     * one of its own halves. A section subtotal is a real figure about part of the invoice; it is
     * simply not this one.
     */
    /(?:^|[\r\n])\s*sub\s*-?\s*total[^$\n]{0,10}\$\s*(-?[\d,]+\.\d{2})/i,
    // IPD prints the figure above its label rather than beside it.
    /([\d,]+\.\d{2})\s*[\r\n]+\s*Sub\s*-?\s*total\b/i,
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

export type FiledInvoice = {
  id: string;
  documentId: string;
  schedule: InvoiceSchedule;
  needsReview: boolean;
  /** Set where this bill was already on file: the copy is kept, the money is not counted twice. */
  duplicateOf?: string;
};

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

  /*
   * The same invoice, sent twice, is one invoice.
   *
   * These arrive by email, and an email gets forwarded, replied to and swept again. Every copy used
   * to become its own invoice with its own lines, which doubles that week's purchases — and
   * purchases feed the rebate estimate, the cost of goods and the stock position, none of which
   * would look wrong. Identity is the supplier's own number and date, which is what makes two PDFs
   * the same bill however many times they arrive.
   */
  if (invoiceNumber && invoiceDate && supplier) {
    const already = await db.query.supplierInvoices.findFirst({
      where: and(
        eq(schema.supplierInvoices.invoiceNumber, invoiceNumber),
        eq(schema.supplierInvoices.invoiceDate, invoiceDate),
        eq(schema.supplierInvoices.supplier, supplier),
      ),
    });
    /*
     * A placeholder from the Invoice Summary is replaced, not treated as the invoice already being
     * here.
     *
     * The summary carries a number and a total and nothing else — no lines, no controlled
     * substances, no schedule. The real document knows all of that, so when it arrives it takes the
     * placeholder's place. Refusing it as a duplicate would leave the pharmacy holding the weaker
     * record permanently; keeping both would count the same purchase twice, which is invisible in
     * every figure it touches.
     */
    if (already && (already.basis ?? "").startsWith(FROM_SUMMARY)) {
      await db.delete(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, already.id));
      await audit({
        action: "invoice.replaced_summary",
        userId: ctx.userId,
        userName: ctx.userName,
        details: `${supplier} invoice ${invoiceNumber} of ${invoiceDate} had been recorded from the Invoice Summary as a total only; the invoice itself has replaced it.`,
      });
    } else if (already) {
      await audit({
        action: "invoice.duplicate",
        userId: ctx.userId,
        userName: ctx.userName,
        details: `${supplier} invoice ${invoiceNumber} of ${invoiceDate} was already filed; this copy was kept as a document and not counted again.`,
      });
      return { id: already.id, documentId: already.documentId, schedule, needsReview: already.needsReview, duplicateOf: already.id };
    }
  }

  /*
   * The register row, from the sender first and from the printed name second.
   *
   * The sender address is the better answer and stays first: it is the part a wholesaler's billing
   * system controls. But it is not always available — an invoice forwarded by hand arrives from the
   * person who forwarded it, and an invoice filed from a document already in the vault has no
   * sender at all — and when it was missing this simply stored null and never looked again. Both
   * IPC invoices on the live database sit at supplier_id NULL for that reason, with "Independent
   * Pharmacy Cooperative" printed on them the whole time and IPC's address registered.
   *
   * The fallback is the register's own matcher, so it is equality against the register name, the
   * catalogue name and the aliases the pharmacy typed — never a substring. A name it cannot place
   * stays null, which is the state the invoices page is meant to show rather than paper over.
   */
  const fromSender = meta.supplierId ?? null;
  const supplierId = fromSender ?? supplierRecordFor(await allSuppliers(true), supplier)?.id ?? null;

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
    supplierId,
    needsReview: !confident,
    receivedFrom: meta.from,
  });
  /*
   * One path to the lines, not two.
   *
   * This called writeInvoiceLines and then storeInvoiceLines on the same text — the second
   * re-parsing what the first had just stored and deleting the rows to write them again. Besides
   * doing the work twice, it meant a model read obtained by the first call could be replaced by the
   * second call's rule read, and the only thing preventing that was the rule reader returning
   * before the delete when it read nothing.
   *
   * writeInvoiceLines is the whole path already: the rule reader first because it is free and
   * deterministic, the model only where the rule read nothing at all, and linesRead / linesUnread
   * recorded at the end. It reads the invoice row back, so it sees the supplierId resolved above
   * rather than being told it a second time.
   */
  /*
   * ── The model is asked here too, and until now it never was ──
   *
   * Two faults in one line, both found on IPC 11490216 of 4 September: $1,530.89 filed with zero
   * item lines while its sibling 11490227, from the same sender the same evening, read eight.
   *
   * The first is that `writeInvoiceLines` was called with no options, so `allowModel` was
   * undefined. The model fallback inside it — the one whose own comment explains that IPD's
   * columns "come out shredded and interleaved" and that only a reader which can see the page's
   * geometry will ever get them — was reachable from the Add tool and from the backfill button on
   * the invoices page, and from nothing else. Every invoice this pharmacy receives arrives by
   * email, so the fallback was switched off on the only path an invoice actually travels.
   *
   * The second is `text ? … : null`. A PDF with no text layer — a scan, which is how some
   * wholesalers send — produced no text, so the line reader was never called at all. But the model
   * reads the *document*, not the text: a scan is precisely the case it exists for, and precisely
   * the case that could not reach it. The warning written below then told the pharmacist to enter
   * it by hand, which was honest about the outcome and wrong about the options.
   *
   * So the reader is always called, with the empty string standing in for a scan —
   * `storeInvoiceLines` returns nothing read for text under 200 characters without touching a
   * stored line, so the rule reader is a no-op there and the model gets its turn.
   *
   * ── Why this cannot run away with the owner's money ──
   *
   * The model is asked only where the rule read nothing at all, and only where the invoice carries
   * a total worth reading. A document with neither lines nor a total is not evidently an invoice,
   * and paying to look at one is how a ceiling gets spent on junk. Beyond that, every model call in
   * this site goes through one function that holds the month's ceiling, so the worst case is that
   * an invoice is filed unread and says so — which is exactly what happens today, every time.
   *
   * What is bought for that: $1,530.89 of purchases currently reaching the cost of no drug, no
   * rebate ladder and no purchase ratio, on one invoice, from one wholesaler, in one week.
   */
  const worthReading = totalCents !== null && totalCents > 0;
  const written = await writeInvoiceLines(id, text ?? "", {
    allowModel: worthReading,
    user: { id: ctx.userId, name: ctx.userName },
  });

  /*
   * An invoice carrying money and no lines under it is not a quiet success.
   *
   * A PDF with no text layer — a scan, which is how some wholesalers send — produces exactly this:
   * the total is read off the front page, the row is filed, `text` is null, no line reader is ever
   * called, and nothing anywhere says so. One is sitting on the live database now: $1,530.89, zero
   * lines, zero unread, and needs_review already cleared. Every figure built on invoice lines — what
   * the pharmacy paid for an NDC, the rebate ladder, the purchase ratio — is short by that invoice
   * and looks complete.
   *
   * So the row says it. `needsReview` goes back on and the reason is written into `basis`, because
   * a total with nothing under it is a document somebody has to open, not a number to be trusted.
   */
  const why = emptyInvoiceWarning({
    linesStored: written?.read ?? 0,
    totalCents,
    hasTextLayer: text !== null,
    // Said on the row, so nobody presses "read it again" expecting a different answer from the
    // same two readers. Both have now had this document and neither could place a line on it.
    modelTried: worthReading,
  });
  if (why) {
    await db
      .update(schema.supplierInvoices)
      .set({ needsReview: true, basis: `${basis} ${why}`.trim() })
      .where(eq(schema.supplierInvoices.id, id));
  }

  return { id, documentId, schedule, needsReview: !confident || why !== null };
}

/**
 * What to say about an invoice that carries money and has no lines under it.
 *
 * Returns the sentence to put on the row, or null where there is nothing wrong.
 *
 * A PDF with no text layer — a scan, which is how some wholesalers send — produces exactly this
 * shape: the total is read off the front page, the row is filed, no line reader is ever called,
 * and nothing anywhere says so. One is sitting on the live database now at $1,530.89 with zero
 * lines, zero unread, and needs_review already cleared. Every figure built on invoice lines — what
 * the pharmacy paid for an NDC, the rebate ladder, the purchase ratio — is short by that invoice
 * and looks complete, which is the same failure mode as the supplier match that dropped eight
 * lines without a word.
 *
 * A zero total with no lines is not this: an invoice for nothing has nothing to be missing.
 */
export function emptyInvoiceWarning(a: {
  linesStored: number;
  totalCents: number | null;
  /** False for a scan. It changes the advice, because there is nothing on the page to re-read. */
  hasTextLayer: boolean;
  /**
   * Whether the model was given the document as well as the rule reader.
   *
   * It changes what a person should do next, which is the only reason the sentence exists. Where
   * both readers have had it and neither could place a line, pressing the button again runs the
   * same two readers over the same page for the same answer, at the cost of the second one. Where
   * only the rule reader saw it, that button is worth pressing.
   *
   * Optional and false by default, so a caller that has not been taught to say makes no claim
   * about what was tried rather than an untrue one.
   */
  modelTried?: boolean;
}): string | null {
  if (a.linesStored > 0) return null;
  if (a.totalCents === null || a.totalCents <= 0) return null;
  const total = `$${(a.totalCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const read = a.hasTextLayer
    ? `The total of ${total} was read off the page, but no item line could be read from it.`
    : `The total of ${total} was read off the page, but this PDF carries no text layer, so not one item line could be read from the text.`;
  const next = a.modelTried
    ? "Both readers have had this document — the rule reader and the model — and neither could place a line on it, so reading it again will give the same answer. It has to be entered by hand, or a readable copy has to replace it."
    : a.hasTextLayer
      ? "Nothing on this invoice reaches the cost of any drug until somebody looks."
      : "Nothing on this invoice reaches the cost of any drug until somebody enters it or a readable copy replaces it.";
  return `${read} ${next}`;
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
export async function writeInvoiceLines(
  invoiceId: string,
  text: string,
  opts: { allowModel?: boolean; user?: { id?: string | null; name: string } } = {},
): Promise<{ read: number; unread: number; reconciles: boolean | null; readBy: "rule" | "model" | null }> {
  const inv = await db.query.supplierInvoices.findFirst({ where: eq(schema.supplierInvoices.id, invoiceId) });
  const r = await storeInvoiceLines(invoiceId, {
    supplier: inv?.supplier ?? null,
    supplierId: inv?.supplierId ?? null,
    invoiceDate: inv?.invoiceDate ?? null,
    text,
    printedTotalCents: inv?.totalCents ?? null,
  });

  /*
   * The layout no regular expression can read.
   *
   * McKesson and IPC print item lines that survive text extraction as lines. IPD does not: its
   * columns come out shredded and interleaved, every NDC on the page in one unbroken run of
   * digits, every price in another. The information saying which figure belongs to which product
   * was never in the text — it was in the geometry of the page. So where the cheap reader finds
   * nothing at all, the document itself goes to the model, which can still see the layout.
   *
   * Only where nothing was read. A partial read is a different problem and a model second opinion
   * on it would quietly replace figures that reconciled with figures that might not.
   */
  let readBy: "rule" | "model" | null = r.stored > 0 ? "rule" : null;
  let out = r;
  if (r.stored === 0 && opts.allowModel && inv) {
    try {
      const buf = await readStoredFile((await db.query.documents.findFirst({ where: eq(schema.documents.id, inv.documentId) }))!.storageKey);
      const { readInvoiceLines } = await import("./ai");
      const read = await readInvoiceLines(buf, inv.supplier, {
        userId: opts.user?.id ?? "invoice-reader",
        userName: opts.user?.name ?? "Automatic check",
      });
      const stored = await storeModelInvoiceLines(invoiceId, inv, read);
      if (stored.stored > 0) {
        out = stored;
        readBy = "model";
      }
    } catch {
      // The cheap read already failed; a failed expensive one leaves the invoice exactly as it was.
    }
  }

  await db
    .update(schema.supplierInvoices)
    .set({ linesRead: out.stored, linesUnread: out.unread })
    .where(eq(schema.supplierInvoices.id, invoiceId));
  return { read: out.stored, unread: out.unread, reconciles: out.reconciles, readBy };
}

/**
 * Stores lines the model read, held to exactly the same arithmetic as lines read by rule.
 *
 * Each line must multiply out and the lines must add to the printed total. A model that misreads a
 * digit produces a line that does not reconcile, and a line that does not reconcile is not stored —
 * which is the same rule that caught a real McKesson line worth eighty-three dollars going missing.
 */
async function storeModelInvoiceLines(
  invoiceId: string,
  inv: SupplierInvoice,
  read: import("./ai").ReadInvoiceLinesT,
): Promise<{ stored: number; unread: number; reconciles: boolean | null; readCents: number }> {
  const { ndc11: toNdc11 } = await import("./invoice-lines");
  const good: typeof read.lines = [];
  let unread = read.unreadable.length;
  for (const l of read.lines) {
    const key = toNdc11(l.ndc11);
    if (!key || !Number.isFinite(l.quantity) || l.quantity <= 0) {
      unread++;
      continue;
    }
    if (Math.round(l.quantity * l.unitCostCents) !== l.extendedCents) {
      unread++;
      continue;
    }
    good.push({ ...l, ndc11: key });
  }
  if (good.length === 0) return { stored: 0, unread, reconciles: null, readCents: 0 };

  const sum = good.reduce((n, l) => n + l.extendedCents, 0);
  const printed = inv.totalCents ?? read.totalCents;
  const reconciles = printed === null ? null : sum === printed;
  // Nothing is stored from a reading that does not add up to what the invoice says it came to.
  if (reconciles === false) return { stored: 0, unread: good.length + unread, reconciles: false, readCents: sum };

  await db.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId));
  const rows = good.map((l) => ({
    id: newId(),
    invoiceId,
    supplier: inv.supplier,
    // The register row the invoice already resolved to from the sender address. Carried onto the
    // line so no reader downstream has to re-derive it from the printed name — which is how eight
    // real lines fell out of the rebate figures.
    supplierId: inv.supplierId,
    invoiceDate: inv.invoiceDate ?? read.invoiceDate,
    ndc11: l.ndc11,
    description: l.description,
    itemNumber: l.itemNumber,
    quantity: l.quantity,
    unitOfMeasure: l.unitOfMeasure,
    unitCostCents: l.unitCostCents,
    extendedCents: l.extendedCents,
    awpCents: null,
    itemClass: l.itemClass,
    rebated: l.rebated,
    // Which half of a combined invoice the line is on, so the Schedule II items are separable
    // inside the document as well as by the folder it is filed in. See invoice-lines.ts.
    controlled: (l as { controlled?: boolean | null }).controlled ?? null,
  }));
  for (let i = 0; i < rows.length; i += 200) await db.insert(schema.invoiceLines).values(rows.slice(i, i + 200));
  // A total read off the page where none was held is worth keeping: it is the figure to reconcile against.
  if (inv.totalCents === null && read.totalCents !== null) {
    await db.update(schema.supplierInvoices).set({ totalCents: read.totalCents }).where(eq(schema.supplierInvoices.id, invoiceId));
  }
  return { stored: rows.length, unread, reconciles, readCents: sum };
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
export async function backfillInvoiceLines(
  opts: { allowModel?: boolean; user?: { id?: string | null; name: string } } = {},
): Promise<{ invoices: number; linesRead: number; unreadable: number; unreconciled: number; byModel: number }> {
  const rows = await db.query.supplierInvoices.findMany({ where: isNull(schema.supplierInvoices.linesRead) });
  const { readFile } = await import("./files");
  let invoicesDone = 0;
  let linesRead = 0;
  let unreadable = 0;
  let unreconciled = 0;
  let byModel = 0;
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
      const r = await writeInvoiceLines(row.id, text, opts);
      invoicesDone++;
      linesRead += r.read;
      if (r.readBy === "model") byModel++;
      // Read, but the lines did not add up to the printed total, so none were kept. Named
      // separately: it is a layout this reader does not fully know, not a scan.
      if (r.reconciles === false) unreconciled++;
    } catch {
      unreadable++;
    }
  }
  return { invoices: invoicesDone, linesRead, unreadable, unreconciled, byModel };
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
  /**
   * Only ones carrying a total with no item lines under them.
   *
   * Kept apart from `noAmount`, which is the opposite complaint. These have the money and are
   * missing the goods, so every per-NDC cost and every rebate figure is short by them.
   */
  noLines?: boolean;
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
  // Asked of the lines rather than of `lines_read`, because that column records what one reading
  // managed and this question is about what is on the invoice now.
  const withLines = q.noLines ? await invoiceIdsWithLines() : null;

  return rows
    .filter((r) => matchesText(r, q.text))
    .filter((r) => {
      if (withLines && !((r.totalCents ?? 0) > 0 && !withLines.has(r.id))) return false;
      if (q.noAmount) return r.totalCents === null;
      if (q.minAmount !== undefined && (r.totalCents === null || r.totalCents < q.minAmount * 100)) return false;
      if (q.maxAmount !== undefined && (r.totalCents === null || r.totalCents > q.maxAmount * 100)) return false;
      return true;
    });
}

/** The invoices that have at least one item line stored against them. */
async function invoiceIdsWithLines(): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ invoiceId: schema.invoiceLines.invoiceId })
    .from(schema.invoiceLines);
  return new Set(rows.map((r) => r.invoiceId));
}

/** What the shown invoices come to, so a filtered list answers "how much was that month". */
export function sumOf(rows: SupplierInvoice[]): { total: number; missing: number } {
  return {
    total: rows.reduce((n, r) => n + (r.totalCents ?? 0), 0),
    missing: rows.filter((r) => r.totalCents === null).length,
  };
}

/**
 * A PDF that reads as a supplier invoice from a sender nobody has registered.
 *
 * `looksLikeInvoice` refuses these outright — `if (!opts.supplier) return false` — and that guard
 * is right for what it does: a rule that filed PDFs from strangers under the heading an inspector
 * reads first would sweep up the wrong things. But refusing is not the same as noticing, and at the
 * moment nothing notices. The document falls through to the general vault as "other", and the only
 * sign that a wholesaler's invoice was ever received is a row in a list of miscellany.
 *
 * That is how McKesson stands today. Its register row has no sender address at all, so
 * `supplierForSender` returns null, `supplierName` is null, and a McKesson invoice arriving this
 * afternoon could not be filed as an invoice however plainly it said so on the page. There are no
 * McKesson invoices on the database and no McKesson document in the vault, so nothing has been lost
 * yet — but the pharmacy would go on believing its purchase records were complete, and every figure
 * built on invoice lines would be short without saying so. A supplier invoice commingled with
 * ordinary documents is also the outcome 21 CFR 1304.04(h)(1) does not allow, which is the same
 * reason `suppliers-registry.ts` treats the sender addresses as the load-bearing part.
 *
 * So this is the seam: it answers "this is an invoice and we do not know whose", and the caller
 * raises it for a person instead of filing it or dropping it. It never files anything itself.
 *
 * Deliberately narrower than `looksLikeInvoice`, because there is no known sender to lean on:
 * the document's own words have to say it. A subject line and a file name are written by whoever
 * sent the email and are not evidence here, so a scan with no text layer answers false — unknown
 * sender and unreadable page is not something to guess about. `classifySupplierDocument` returns
 * "invoice" only for two or more lines each carrying an NDC and a price, which a newsletter, a
 * statement, a credit memo and the daily purchase report all fail.
 */
export function looksLikeInvoiceFromUnknownSender(opts: {
  fileName: string;
  mimeType: string;
  subject: string;
  /** Null is the whole point: this asks about documents the sender match could not place. */
  supplier: string | null;
  text?: string | null;
}): boolean {
  if (opts.supplier) return false;
  const isPdf = /\.pdf$/i.test(opts.fileName) || opts.mimeType === "application/pdf";
  if (!isPdf) return false;
  if (!opts.text) return false;
  return classifySupplierDocument(opts.text, opts.fileName, opts.subject).kind === "invoice";
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

  /*
   * ── A total with nothing under it ────────────────────────────────
   *
   * Derived from the lines every time this is asked, not from a flag written when the invoice was
   * filed. That matters for the ones already on the database: the invoice that prompted this was
   * filed before anything checked, so its `needs_review` is clear and no flag will ever be set on
   * it retrospectively. Asking the question of the data catches it and every future one alike, and
   * it also catches an invoice whose lines were removed after the fact.
   *
   * The money is the point. A scanned PDF files perfectly and reads nothing, so the invoice is in
   * the archive, the total is on the screen, and not one item line reaches the cost of any drug —
   * which means every per-NDC cost, the rebate ladder and the purchase ratio are all short by
   * exactly this much while looking complete.
   */
  const withLines = await invoiceIdsWithLines();
  const empty = rows.filter((r) => (r.totalCents ?? 0) > 0 && !withLines.has(r.id));
  if (empty.length > 0) {
    const cents = empty.reduce((n, r) => n + (r.totalCents ?? 0), 0);
    const money = `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    out.push({
      key: "no-lines",
      severity: "blocking",
      title: `${empty.length} invoice${empty.length === 1 ? "" : "s"} worth ${money} with no item lines read`,
      detail:
        `The total was read off the page and not one line under it was. Usually a scan: a PDF with no text layer files ` +
        `perfectly and reads nothing. Until the lines are entered or a readable copy replaces ${empty.length === 1 ? "it" : "them"}, ` +
        `nothing on ${empty.length === 1 ? "this invoice" : "these invoices"} reaches the cost of any drug — so what the pharmacy ` +
        `paid per NDC, the rebate ladder and the purchase ratio are every one of them short by ${money} and look complete.`,
      href: "/inventory/invoices?nolines=1",
      action: "Show me which",
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
 * The day an invoice was paid, as somebody recorded it.
 *
 * The cash account's cost of goods is drawn from this: until a date is here the invoice is counted
 * on its own date plus the supplier's terms and said to be. Blank clears it.
 */
export async function setInvoicePaidOn(id: string, paidOn: string, user: { name: string }): Promise<void> {
  if (paidOn && !/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw new Error("That is not a date.");
  const inv = await db.query.supplierInvoices.findFirst({ where: eq(schema.supplierInvoices.id, id) });
  if (!inv) throw new Error("That invoice no longer exists.");
  await db
    .update(schema.supplierInvoices)
    .set({ paidOn: paidOn || null, basis: `${inv.basis ?? ""} ${paidOn ? `Paid ${paidOn}` : "Payment date cleared"}, entered by ${user.name} on ${todayIso()}.`.trim() })
    .where(eq(schema.supplierInvoices.id, id));
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

  const candidates = docs
    .filter((d) => !claimed.has(d.id))
    .filter((d) => d.category !== "invoice_schedule_2" && d.category !== "invoice_schedule_3_5" && d.category !== "invoice")
    /*
     * A document already filed as what it is, is not waiting to be filed as something else.
     *
     * The rebate breakdown and the returned goods policy were both sitting on this list under
     * "already received, but not filed as invoices", with a button offering to file them as
     * invoices — because the rule that built the list matched the word "McKesson" in a title. They
     * are not invoices, nothing is wrong with them, and there was no way to say so. A list of
     * outstanding work that contains finished work is worse than no list: it cannot be emptied.
     */
    .filter((d) => d.category !== "supplier_statement" && d.category !== "supplier_agreement")
    .filter((d) => /\.pdf$/i.test(d.fileName) || d.mimeType === "application/pdf")
    .filter((d) =>
      /invoice|inv\b|statement of account|packing (list|slip)|mckesson|independent pharmacy|cardinal|cencora|amerisource/i.test(
        `${d.title} ${d.fileName} ${d.notes ?? ""}`,
      ),
    );

  /*
   * And what the document itself says beats what its title contains.
   *
   * Matching a supplier's name in a title is how a rebate breakdown gets offered as an invoice. The
   * words settle it, at the cost of reading each candidate once — and this list is short by
   * construction, being only what has not been filed.
   */
  const out: { id: string; title: string; fileName: string; receivedFrom: string | null; effectiveOn: string | null }[] = [];
  for (const d of candidates) {
    /*
     * Only a document that reads as an invoice is offered as one.
     *
     * This used to keep "unknown" as well, on the reasoning that an unreadable scan is exactly what
     * the list is for. But unknown is not the same as unreadable: a PDF whose text extracts
     * perfectly well and says nothing invoice-shaped is a document the site does not recognise, and
     * offering it here — under a heading that says these are invoices waiting to be filed, beside a
     * button that files them as invoices — is how the pharmacy's own daily purchase report ended up
     * on the list every morning with a Delete beside it.
     *
     * So the two cases are separated. Text that reads as an invoice is offered. Text that reads as
     * anything else is not, and `misfiledInVault` files it as what it is. Text that will not come
     * out at all is a scan, and a scan whose name or title says invoice is still offered, because
     * that is a real invoice with no text layer and there is nothing else to go on.
     */
    let words = "";
    try {
      words = pdfText(await readStoredFile(d.storageKey));
    } catch {
      words = "";
    }
    if (words.trim().length > 40) {
      if (classifySupplierDocument(words, d.fileName, d.title).kind !== "invoice") continue;
    } else if (!/invoice|\binv\b|packing (list|slip)/i.test(`${d.title} ${d.fileName}`)) {
      // A scan that does not even claim to be an invoice is not offered as one.
      continue;
    }
    out.push({
      id: d.id,
      title: d.title || d.fileName,
      fileName: d.fileName,
      receivedFrom: d.notes?.match(/from ([^\s.]+@[^\s.]+\.\S+)/i)?.[1] ?? null,
      effectiveOn: d.effectiveOn,
    });
  }
  return out.sort((a, b) => (b.effectiveOn ?? "").localeCompare(a.effectiveOn ?? ""));
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

  /*
   * Refuse outright to file something that is not an invoice.
   *
   * Reached by URL rather than from the list, or from a list built before this check existed. A
   * rebate breakdown filed as an invoice ends up held with the Schedule II records — a document
   * recording no receipt of anything, in the file an inspector reads first.
   */
  if (text) {
    const kind = classifySupplierDocument(text, doc.fileName, doc.title);
    if (kind.kind !== "invoice" && kind.kind !== "unknown") {
      const word = kind.kind === "rebate_report" ? "rebate breakdown" : kind.kind === "credit_memo" ? "credit memo" : "statement of account";
      throw new Error(
        `That is a ${word}, not an invoice — ${kind.why} It is already filed where it belongs and nothing needs doing to it. ` +
          (kind.kind === "rebate_report"
            ? "To read the tier ladder off it, open the supplier's rebate and return terms page."
            : "It records no receipt of goods, so it is deliberately kept out of the invoice files."),
      );
    }
  }

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

  /*
   * The same invoice, sent twice, is one invoice.
   *
   * These arrive by email, and an email gets forwarded, replied to and swept again. Every copy used
   * to become its own invoice with its own lines, which doubles that week's purchases — and
   * purchases feed the rebate estimate, the cost of goods and the stock position, none of which
   * would look wrong. Identity is the supplier's own number and date, which is what makes two PDFs
   * the same bill however many times they arrive.
   */
  if (invoiceNumber && invoiceDate && supplier) {
    const already = await db.query.supplierInvoices.findFirst({
      where: and(
        eq(schema.supplierInvoices.invoiceNumber, invoiceNumber),
        eq(schema.supplierInvoices.invoiceDate, invoiceDate),
        eq(schema.supplierInvoices.supplier, supplier),
      ),
    });
    if (already) {
      await audit({
        action: "invoice.duplicate",
        userId: ctx.userId,
        userName: ctx.userName,
        details: `${supplier} invoice ${invoiceNumber} of ${invoiceDate} was already filed; this copy was kept as a document and not counted again.`,
      });
      return { id: already.id, documentId: already.documentId, schedule, needsReview: already.needsReview, duplicateOf: already.id };
    }
  }

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

  await storeInvoiceLines(id, { supplier, supplierId: matched?.id ?? null, invoiceDate, text: text ?? "", printedTotalCents: totalCents });

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
  meta: {
    supplier: string | null;
    /** The register row the invoice resolved to, carried onto every line it produces. */
    supplierId?: string | null;
    invoiceDate: string | null;
    text: string;
    printedTotalCents: number | null;
  },
): Promise<{ stored: number; unread: number; reconciles: boolean | null; readCents: number }> {
  const { parseInvoiceLines } = await import("./invoice-lines");
  if (!meta.text || meta.text.length < 200) return { stored: 0, unread: 0, reconciles: null, readCents: 0 };
  // Item lines add up to the goods, not to the amount due: shipping and tax are on the invoice and
  // are not items. Where the invoice prints both, the goods figure is what proves the reading.
  const parsed = parseInvoiceLines(meta.text, readGoodsSubtotalCents(meta.text) ?? meta.printedTotalCents);
  if (parsed.lines.length === 0) return { stored: 0, unread: parsed.unreadable.length, reconciles: parsed.reconciles, readCents: 0 };
  if (parsed.reconciles === false) return { stored: 0, unread: parsed.lines.length + parsed.unreadable.length, reconciles: false, readCents: parsed.totalCents };

  /*
   * What is already on this invoice, and whether this read has earned the right to replace it.
   *
   * The delete below is unconditional once a read produces lines, and that was safe only by the
   * order of the early returns above: a model read that succeeded survived a later rule read
   * because the rule read nothing and returned before reaching the delete. Luck, not design, and
   * one refactor from wiping figures a person had already been shown.
   *
   * The hole it left is real. `reconciles` is null — not false — when the invoice printed no total
   * to check against, so an unverified read fell straight through to the delete and could replace
   * lines that had been proved against a printed total. `replacesStoredLines` settles it by
   * arithmetic instead: lines that add up to what the invoice says it came to are not given up for
   * a read that cannot prove the same.
   */
  const existing = await db.query.invoiceLines.findMany({
    where: eq(schema.invoiceLines.invoiceId, invoiceId),
    columns: { extendedCents: true },
  });
  if (
    !replacesStoredLines({
      storedLines: existing.length,
      storedCents: existing.reduce((n, l) => n + l.extendedCents, 0),
      readReconciles: parsed.reconciles,
      printedTotalCents: meta.printedTotalCents,
    })
  ) {
    return {
      stored: existing.length,
      unread: parsed.unreadable.length,
      reconciles: true,
      readCents: existing.reduce((n, l) => n + l.extendedCents, 0),
    };
  }

  await db.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId));
  const rows = parsed.lines.map((l) => ({
    id: newId(),
    invoiceId,
    supplier: meta.supplier,
    supplierId: meta.supplierId ?? null,
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
    // Which half of a combined invoice the line is on, so the Schedule II items are separable
    // inside the document as well as by the folder it is filed in. See invoice-lines.ts.
    controlled: l.controlled ?? null,
  }));
  for (let i = 0; i < rows.length; i += 200) await db.insert(schema.invoiceLines).values(rows.slice(i, i + 200));
  return { stored: rows.length, unread: parsed.unreadable.length, reconciles: parsed.reconciles, readCents: parsed.totalCents };
}

/**
 * Whether a fresh read may replace the lines already stored against an invoice.
 *
 * The question only arises because an invoice is read more than once: on filing, again from the
 * inbox with today's rules, and again when somebody presses the button on the page. Each of those
 * is a legitimate re-read and each is entitled to improve on the last. None of them is entitled to
 * make it worse.
 *
 * "Better" here means one thing, and it is arithmetic rather than judgement: lines that add up to
 * the total printed on the invoice have been proved against the document, and lines that do not
 * have not. So proved lines are never given up for unproved ones. Where nothing is stored there is
 * nothing to lose and the read goes in; where the invoice printed no total, nothing can be proved
 * either way and the newer read stands, which is the behaviour that was already there.
 *
 * `readReconciles` is the parse's own verdict: true where it adds to the printed total, false where
 * it does not, null where there was no total to check. Null is the case that mattered — it is not
 * a failure, so it fell straight through to the delete and could replace proved lines with
 * unproved ones.
 */
export function replacesStoredLines(a: {
  storedLines: number;
  storedCents: number;
  readReconciles: boolean | null;
  printedTotalCents: number | null;
}): boolean {
  if (a.storedLines === 0) return true;
  if (a.printedTotalCents === null) return true;
  const storedWasProved = a.storedCents === a.printedTotalCents;
  if (!storedWasProved) return true;
  return a.readReconciles === true;
}



/**
 * Taking a document back out of the invoice file, because it was never an invoice.
 *
 * A statement of account arrived from IPD, matched the words on the front of it, and was filed as
 * an invoice — and then there was nothing anybody could do about it. No way to correct it, no way
 * to remove it. That is the worse half of the mistake: every automatic filing rule will be wrong
 * about something eventually, and a rule with no undo turns a five-second correction into a
 * permanent wrong record.
 *
 * Two outcomes, and they are different. **Re-filing** keeps the document and moves it to the
 * category it belongs in — the paper still exists, it is just not an invoice. **Discarding**
 * removes it altogether, for the duplicate or the thing that should never have been kept, and it
 * takes the bytes with it only when no other record points at them.
 *
 * The invoice row and its item lines go either way. Leaving the lines behind would leave a
 * statement's figures sitting in the purchasing comparison as though they were prices paid.
 */
export type Unfiling = { kind: "statement" | "rebate_report" | "credit_memo" | "other" } | { kind: "discard" };

export async function unfileInvoice(
  invoiceId: string,
  outcome: Unfiling,
  user: { id?: string | null; name: string },
  /** The document behind it, so the job can still be finished when the invoice record has gone. */
  fallbackDocumentId?: string | null,
): Promise<{ message: string; documentId: string | null }> {
  const inv = await db.query.supplierInvoices.findFirst({ where: eq(schema.supplierInvoices.id, invoiceId) });
  /*
   * Already done is not an error.
   *
   * Pressing this twice — which is what anybody does when the first press looks as though it did
   * nothing — produced "That invoice is no longer on file", which reads as a failure and is in
   * fact a report of success. The first press had worked; the document had simply moved into the
   * list below, where it was then offered for filing as an invoice all over again.
   */
  if (!inv) {
    /*
     * The invoice record is gone and the document may not be.
     *
     * This returned "already taken out — nothing further to do", which was a report of success
     * about a job half done: the invoice row had gone, the document had kept its invoice category,
     * and so it came straight back through the adoptable-documents list as something waiting to be
     * filed as an invoice. Pressing again got the same cheerful message, for ever.
     *
     * So where the caller can say which document it was, finish the job on the document instead of
     * declaring victory.
     */
    if (!fallbackDocumentId) {
      return { message: "That was already taken out of the invoice file — nothing further to do.", documentId: null };
    }
    const orphan = await db.query.documents.findFirst({ where: eq(schema.documents.id, fallbackDocumentId) });
    if (!orphan) {
      return { message: "That was already taken out of the invoice file, and the document has gone too.", documentId: null };
    }
    if (outcome.kind === "discard") {
      const { deleteFile } = await import("./files");
      const others = await db.query.documents.findMany({ where: eq(schema.documents.storageKey, orphan.storageKey), columns: { id: true } });
      await db.delete(schema.documents).where(eq(schema.documents.id, orphan.id));
      if (others.every((o) => o.id === orphan.id)) await deleteFile(orphan.storageKey).catch(() => {});
      await audit({ action: "invoice.discarded", userId: user.id ?? null, userName: user.name, entity: "document", entityId: orphan.id, details: `${orphan.title} · document removed after its invoice record had already gone` });
      return { message: "The invoice record had already gone; the document has now been deleted with it.", documentId: null };
    }
    await db
      .update(schema.documents)
      .set({
        category: outcome.kind === "other" ? "other" : "supplier_statement",
        notes: [orphan.notes, `Taken out of the invoice file by ${user.name}.`].filter(Boolean).join(" "),
      })
      .where(eq(schema.documents.id, orphan.id));
    await audit({ action: "invoice.unfiled", userId: user.id ?? null, userName: user.name, entity: "document", entityId: orphan.id, details: `${orphan.title} · re-filed after its invoice record had already gone` });
    return { message: "The invoice record had already gone; the document is now filed under supplier statements and will not be offered as an invoice again.", documentId: orphan.id };
  }
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, inv.documentId) });

  await db.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId));
  await db.delete(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, invoiceId));

  const named = inv.supplier ?? "the supplier";
  if (outcome.kind === "discard") {
    if (doc) {
      const { deleteFile } = await import("./files");
      const others = await db.query.documents.findMany({ where: eq(schema.documents.storageKey, doc.storageKey), columns: { id: true } });
      await db.delete(schema.documents).where(eq(schema.documents.id, doc.id));
      if (others.every((o) => o.id === doc.id)) await deleteFile(doc.storageKey).catch(() => {});
    }
    await audit({
      action: "invoice.discarded",
      userId: user.id ?? null,
      userName: user.name,
      entity: "document",
      entityId: inv.documentId,
      details: `${named} · ${inv.invoiceNumber ?? "no number"} · removed from the invoice file and deleted`,
    });
    return { message: `Removed. The document and everything read off it are gone.`, documentId: null };
  }

  const word =
    outcome.kind === "rebate_report" ? "rebate breakdown" : outcome.kind === "credit_memo" ? "credit memo" : outcome.kind === "statement" ? "statement of account" : "document";
  if (doc) {
    await db
      .update(schema.documents)
      .set({
        category: outcome.kind === "other" ? "other" : "supplier_statement",
        title: outcome.kind === "other" ? doc.title : `${named} ${word}${inv.invoiceDate ? ` — ${inv.invoiceDate}` : ""}`,
        notes: [doc.notes, `Taken out of the invoice file by ${user.name}: it is a ${word}, not an invoice.`].filter(Boolean).join(" "),
      })
      .where(eq(schema.documents.id, doc.id));
  }
  await audit({
    action: "invoice.unfiled",
    userId: user.id ?? null,
    userName: user.name,
    entity: "document",
    entityId: inv.documentId,
    details: `${named} · ${inv.invoiceNumber ?? "no number"} · re-filed as ${word}`,
  });
  return {
    message:
      `Taken out of the invoice file and kept as a ${word} from ${named}. ` +
      (outcome.kind === "rebate_report"
        ? "It carries a tier ladder — read it from the supplier's terms page and the ladder is filed with it."
        : "Nothing read off it is counted as a purchase any more."),
    documentId: inv.documentId,
  };
}

/**
 * Reads every filed invoice again and finds the ones that were never invoices.
 *
 * The recognition rule now reads the document rather than the subject line, but it only runs on
 * arrival — so everything filed before it existed stays wrong, and the pharmacist is left clicking
 * through a list correcting them one at a time. That is the software asking a person to do its
 * job. This does the pass: open each filed invoice, classify it on its own words, and take out
 * anything that turns out to be a statement, a rebate breakdown or a credit memo.
 *
 * It only ever moves things *out* of the invoice file, which is the safe direction. A statement
 * sitting among the Schedule II records is a document that proves no receipt in the file an
 * inspector reads first; an invoice this misjudged and removed would be a missing record, so
 * nothing is removed on a maybe — only where the document's own words settle it.
 */
export async function recheckFiledInvoices(
  user: { id?: string | null; name: string },
  opts: { apply?: boolean } = {},
): Promise<{
  checked: number;
  found: { id: string; supplier: string | null; kind: SupplierDocumentKind; why: string }[];
  moved: number;
  unreadable: number;
  /** Invoice records whose document no longer exists — the ones nothing could reach. */
  orphaned: { id: string; supplier: string | null; invoiceNumber: string | null }[];
  removedOrphans: number;
}> {
  const rows = await db.query.supplierInvoices.findMany();
  const found: { id: string; supplier: string | null; kind: SupplierDocumentKind; why: string }[] = [];
  const orphaned: { id: string; supplier: string | null; invoiceNumber: string | null }[] = [];
  let unreadable = 0;
  let moved = 0;
  let removedOrphans = 0;

  for (const inv of rows) {
    const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, inv.documentId) });
    /*
     * A filed invoice whose document has gone.
     *
     * It was skipped here, which meant nothing ever looked at it again: it sat in the invoice
     * list, went on counting as purchases, and every button on its row worked through the
     * document that no longer existed. That is the row that would not go away.
     *
     * An invoice record with no document proves nothing to an inspector and is evidence of
     * nothing to the accounts, so it is counted and, on apply, taken out with its lines.
     */
    if (!doc) {
      orphaned.push({ id: inv.id, supplier: inv.supplier, invoiceNumber: inv.invoiceNumber });
      if (opts.apply) {
        await db.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, inv.id));
        await db.delete(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, inv.id));
        await audit({
          action: "invoice.orphan_removed",
          userId: user.id ?? null,
          userName: user.name,
          entity: "supplier_invoice",
          entityId: inv.id,
          details: `${inv.supplier ?? "a supplier"} ${inv.invoiceNumber ?? ""} — the document behind it no longer exists`.trim(),
        });
        removedOrphans++;
      }
      continue;
    }
    let text: string;
    try {
      text = pdfText(await readStoredFile(doc.storageKey));
    } catch {
      unreadable++;
      continue;
    }
    // The stored item text is a better witness than a re-extraction that came back empty.
    const words = text.trim() ? text : inv.itemsText;
    const c = classifySupplierDocument(words, doc.fileName, doc.title);
    if (c.kind === "invoice" || c.kind === "unknown") continue;
    found.push({ id: inv.id, supplier: inv.supplier, kind: c.kind, why: c.why });
    if (opts.apply) {
      await unfileInvoice(inv.id, { kind: c.kind as "statement" | "rebate_report" | "credit_memo" }, user);
      moved++;
    }
  }
  return { checked: rows.length, found, moved, unreadable, orphaned, removedOrphans };
}

/**
 * Delete something from the invoice file, whatever state it is in, in one action.
 *
 * This exists because deleting a statement failed four times running, each time for a different
 * reason, and each fix only covered the state it was reported in. There were three delete paths —
 * one for an invoice with its document, one for a document with no invoice, one for an invoice
 * whose document had gone — and every one of them began by working out which case it was in. That
 * is the bug: the page shows a row, the person wants the row gone, and a delete that first has to
 * agree with itself about what the row *is* will always have a fourth case.
 *
 * So this takes an id — an invoice id, a document id, either, both, it does not care — and removes
 * everything reachable from it: the invoice record, its lines, the document, and the stored file
 * when nothing else points at it. Then it says exactly what went. It cannot report "already gone,
 * nothing further to do" over a row still on the screen, because it looks in every place the row
 * could be coming from rather than the one place it expected.
 */
export async function purgeFromInvoiceFile(
  id: string,
  user: { id?: string | null; name: string },
): Promise<{ removed: { invoices: number; lines: number; documents: number }; message: string }> {
  const wanted = id.trim();
  if (!wanted) return { removed: { invoices: 0, lines: 0, documents: 0 }, message: "Nothing was named to delete." };

  // Every invoice record reachable from this id, by either of the two ways a row can name one.
  const byId = await db.query.supplierInvoices.findFirst({ where: eq(schema.supplierInvoices.id, wanted) });
  const byDoc = await db.query.supplierInvoices.findMany({ where: eq(schema.supplierInvoices.documentId, wanted) });
  const invoices = [...(byId ? [byId] : []), ...byDoc.filter((i) => i.id !== byId?.id)];

  // Every document reachable from it: the id itself, and whatever those invoices were filed from.
  const docIds = [...new Set([wanted, ...invoices.map((i) => i.documentId)].filter(Boolean) as string[])];
  const docs = (
    await Promise.all(docIds.map((d) => db.query.documents.findFirst({ where: eq(schema.documents.id, d) })))
  ).filter((d): d is NonNullable<typeof d> => Boolean(d));

  if (invoices.length === 0 && docs.length === 0) {
    return {
      removed: { invoices: 0, lines: 0, documents: 0 },
      message:
        "Nothing with that reference is in the invoice file or the document vault, so there was nothing left to delete. " +
        "If it is still on the screen, the page is showing a copy from before it went — reload it.",
    };
  }

  let lines = 0;
  for (const inv of invoices) {
    const its = await db.query.invoiceLines.findMany({ where: eq(schema.invoiceLines.invoiceId, inv.id), columns: { id: true } });
    lines += its.length;
    await db.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, inv.id));
    await db.delete(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, inv.id));
  }

  const { deleteFile } = await import("./files");
  for (const doc of docs) {
    /*
     * The mail record keeps its history and loses its pointer.
     *
     * Deleting the inbox row would erase the fact that the message arrived, which is the one thing
     * worth keeping; leaving the pointer would leave a "re-read this attachment" button aimed at a
     * document that no longer exists.
     */
    await db
      .update(schema.inboxItems)
      .set({ documentId: null })
      .where(eq(schema.inboxItems.documentId, doc.id));
    await db.delete(schema.documents).where(eq(schema.documents.id, doc.id));
    const others = await db.query.documents.findMany({ where: eq(schema.documents.storageKey, doc.storageKey), columns: { id: true } });
    if (others.length === 0) await deleteFile(doc.storageKey).catch(() => {});
  }

  const named = docs[0]?.title || invoices[0]?.supplier || "It";
  await audit({
    action: "invoice.purged",
    userId: user.id ?? null,
    userName: user.name,
    entity: "document",
    entityId: docs[0]?.id ?? invoices[0]?.id ?? wanted,
    details: `${named} · ${invoices.length} invoice record(s), ${lines} line(s), ${docs.length} document(s)`,
  });

  const bits: string[] = [];
  if (docs.length > 0) bits.push(`${docs.length === 1 ? "the document" : `${docs.length} documents`}`);
  if (invoices.length > 0) bits.push(`${invoices.length === 1 ? "its invoice record" : `${invoices.length} invoice records`}`);
  if (lines > 0) bits.push(`${lines} line${lines === 1 ? "" : "s"} read off it`);
  return {
    removed: { invoices: invoices.length, lines, documents: docs.length },
    message: `Deleted ${bits.join(", ")}. Nothing from it counts as a purchase any more.`,
  };
}

/**
 * Documents in the vault that are not invoices and are sitting where invoices go.
 *
 * The owner's words: only an invoice should flow to the invoice folder. Two things were letting
 * others through. The list above offered anything unrecognised for filing as an invoice, which is
 * fixed at source. And nothing ever went back over what was already there — a statement filed as an
 * invoice last month stayed one, and the daily purchase report sat in the vault with its ratio
 * unread because nobody had told the site what it was.
 *
 * This reads each one on its own words and says where it belongs. Applying it files them, and for a
 * purchase drill down that means reading the compliance ratio off it as well — the report is not
 * merely misfiled, it is the figure that prices every generic, and moving it without reading it
 * would be tidying the shelf and leaving the money on it.
 */
export type Misfiled = {
  id: string;
  title: string;
  fileName: string;
  /** Carried so re-reading it needs no second query. */
  storageKey: string;
  category: string;
  /** "unreadable" where the PDF carries no text at all — a scan, which says nothing about itself. */
  kind: SupplierDocumentKind | "unreadable";
  why: string;
  /**
   * The category it should be in, or null where the site cannot tell.
   *
   * Null is the important case and the one that was missing. A document that reads as a statement
   * can be filed automatically; one that reads as *nothing* cannot be filed anywhere on the site's
   * own authority — but it equally has no business sitting in the invoice folder unchallenged,
   * because an invoice folder is only worth having if everything in it is an invoice. So it is
   * listed, with a person's answer asked for, rather than moved or hidden.
   */
  belongsIn: "supplier_statement" | "report" | null;
};

const NOT_AN_INVOICE: Record<string, { belongsIn: Misfiled["belongsIn"]; word: string }> = {
  statement: { belongsIn: "supplier_statement", word: "statement of account" },
  rebate_report: { belongsIn: "supplier_statement", word: "rebate breakdown" },
  credit_memo: { belongsIn: "supplier_statement", word: "credit memo" },
  purchase_report: { belongsIn: "report", word: "purchase drill down" },
};

/**
 * Everything in the invoice folder that does not prove itself an invoice.
 *
 * The rule the owner asked for, stated the only way it can be checked: an invoice folder is worth
 * having if everything in it is an invoice, so the burden is on the document. A PDF that lists item
 * lines with NDCs and prices is an invoice and is left alone. Anything else is here — the ones the
 * site can name, which one press files, and the ones it cannot, which it will not move on its own
 * and instead asks about.
 *
 * That last group is why a statement could survive every sweep. The recheck skipped anything that
 * came back "unknown", on the reasoning that removing an invoice by mistake is the worse error —
 * which is true of *moving* it and false of *showing* it. So it never appeared anywhere, and the
 * only evidence it existed was a row in the table with no date, no amount and no lines.
 */
export async function misfiledInVault(): Promise<Misfiled[]> {
  const docs = await db.query.documents.findMany();
  const out: Misfiled[] = [];
  for (const d of docs) {
    // Only where invoices live. A statement already filed under statements is where it belongs.
    if (!["invoice", "invoice_schedule_2", "invoice_schedule_3_5"].includes(d.category)) continue;
    if (!/\.pdf$/i.test(d.fileName) && d.mimeType !== "application/pdf") continue;
    // Somebody has already looked at this one and said it is an invoice. Their word settles it.
    if ((d.notes ?? "").includes(CONFIRMED_INVOICE)) continue;
    let words = "";
    let readable = true;
    try {
      words = pdfText(await readStoredFile(d.storageKey));
    } catch {
      readable = false;
    }
    if (!readable || words.trim().length <= 40) {
      /*
       * A scan. It could be a perfectly good invoice with no text layer, and it could be anything
       * else — nothing here can tell, and nothing here should pretend to. It is listed so somebody
       * who can open it says which, and it is never moved automatically.
       */
      out.push({
        id: d.id,
        title: d.title || d.fileName,
        fileName: d.fileName,
        storageKey: d.storageKey,
        category: d.category,
        kind: "unreadable",
        why: "No text could be read from it, so nothing on it can be checked. If it is a scanned invoice it belongs here; open it and say.",
        belongsIn: null,
      });
      continue;
    }
    const c = classifySupplierDocument(words, d.fileName, d.title);
    if (c.kind === "invoice") continue;
    const where = NOT_AN_INVOICE[c.kind];
    out.push({
      id: d.id,
      title: d.title || d.fileName,
      fileName: d.fileName,
      storageKey: d.storageKey,
      category: d.category,
      kind: c.kind,
      why: where
        ? c.why
        : "Its words do not make it an invoice: no item lines with NDCs and prices on them, and nothing that reads as a statement, a credit memo or a purchase report either. It is in the invoice folder on nobody's authority.",
      belongsIn: where?.belongsIn ?? null,
    });
  }
  return out;
}

/** Files them where they belong, and reads a drill down's ratio while it is at it. */
export async function fileMisfiled(
  user: { id?: string | null; name: string },
): Promise<{ moved: number; ratioRead: string | null; found: Misfiled[] }> {
  const all = await misfiledInVault();
  // Only the ones the site can name. The rest need a person, and moving them would be a guess.
  const found = all.filter((m) => m.belongsIn !== null);
  let ratioRead: string | null = null;
  for (const m of found) {
    const word = NOT_AN_INVOICE[m.kind]?.word ?? "document";
    // Any invoice record filed from it goes too: it was never a receipt of goods, and leaving it
    // would keep counting a statement's figures as purchases.
    const invoices = await db.query.supplierInvoices.findMany({ where: eq(schema.supplierInvoices.documentId, m.id) });
    for (const inv of invoices) {
      await db.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, inv.id));
      await db.delete(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, inv.id));
    }
    await db
      .update(schema.documents)
      // Narrowed above: only rows the site could name reach here.
      .set({ category: m.belongsIn as "supplier_statement" | "report", notes: `Filed as a ${word} by ${user.name}: ${m.why}` })
      .where(eq(schema.documents.id, m.id));

    if (m.kind === "purchase_report" && ratioRead === null) {
      /*
       * The report is the ratio. Moving it without reading it would file the paper and leave the
       * figure that prices every contract generic unread, which is the state this pharmacy was
       * actually in.
       */
      try {
        const { readDrillDown } = await import("./drill-down-read");
        const { filePurchaseDrillDown } = await import("./purchase-ratio");
        const read = readDrillDown(await readStoredFile(m.storageKey));
        if (read.months.length > 0 && read.problems.length === 0) {
          const current = read.months[0];
          const r = await filePurchaseDrillDown(
            {
              generatedOn: read.generatedOn,
              currentMonth: current.month,
              currentGcrPercent: current.gcrPercent,
              currentOsRxPercent: current.osRxPercent,
              currentOsGxPercent: current.osGxPercent,
              scrubbed: read.scrubbed,
              exclusions: read.exclusions,
              months: read.months.map((x) => ({ month: x.month, gcrPercent: x.gcrPercent, osRxPercent: x.osRxPercent, netPurchasesCents: x.netPurchasesCents })),
            },
            { documentId: m.id, supplierId: null },
          );
          ratioRead = r.message;
        }
      } catch {
        /* Unreadable as a drill down; it is still filed as a report rather than left as an invoice. */
      }
    }

    await audit({
      action: "invoice.refiled",
      userId: user.id ?? null,
      userName: user.name,
      entity: "document",
      entityId: m.id,
      details: `${m.title} · filed as a ${word}${invoices.length ? ` · ${invoices.length} invoice record(s) removed` : ""}`,
    });
  }
  return { moved: found.length, ratioRead, found };
}

/**
 * The mark that says a person has looked at a document and called it an invoice.
 *
 * Kept in the document's own notes rather than in a column of its own. The alternative is a
 * migration, and this pharmacy's database has had enough of those this week for a fact that is
 * one bit wide and belongs with the rest of the document's history anyway. It is a fixed string so
 * that finding it is exact rather than a search for words somebody might have typed.
 */
export const CONFIRMED_INVOICE = "[confirmed-invoice]";

/** Keeps a document in the invoice folder on a person's word, and stops asking about it. */
export async function confirmIsInvoice(documentId: string, user: { id?: string | null; name: string }): Promise<string> {
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, documentId) });
  if (!doc) return "That document is no longer here.";
  if ((doc.notes ?? "").includes(CONFIRMED_INVOICE)) return `“${doc.title}” was already confirmed as an invoice.`;
  await db
    .update(schema.documents)
    .set({ notes: [doc.notes, `${CONFIRMED_INVOICE} Confirmed an invoice by ${user.name}.`].filter(Boolean).join(" ") })
    .where(eq(schema.documents.id, documentId));
  await audit({ action: "invoice.confirmed", userId: user.id ?? null, userName: user.name, entity: "document", entityId: documentId, details: doc.title });
  return `“${doc.title}” stays in the invoice folder and will not be asked about again.`;
}

/**
 * Takes a document out of the invoice folder on a person's word.
 *
 * The invoice record goes with it, and its lines: it was never a receipt of goods, and leaving them
 * would go on counting a statement's figures as purchases.
 */
export async function markNotAnInvoice(documentId: string, user: { id?: string | null; name: string }): Promise<string> {
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, documentId) });
  if (!doc) return "That document is no longer here.";
  const invoices = await db.query.supplierInvoices.findMany({ where: eq(schema.supplierInvoices.documentId, documentId) });
  let lines = 0;
  for (const inv of invoices) {
    const its = await db.query.invoiceLines.findMany({ where: eq(schema.invoiceLines.invoiceId, inv.id), columns: { id: true } });
    lines += its.length;
    await db.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, inv.id));
    await db.delete(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, inv.id));
  }
  await db
    .update(schema.documents)
    .set({
      category: "supplier_statement",
      notes: [doc.notes, `Taken out of the invoice folder by ${user.name}: not an invoice.`].filter(Boolean).join(" "),
    })
    .where(eq(schema.documents.id, documentId));
  await audit({
    action: "invoice.not_an_invoice",
    userId: user.id ?? null,
    userName: user.name,
    entity: "document",
    entityId: documentId,
    details: `${doc.title}${invoices.length ? ` · ${invoices.length} invoice record(s), ${lines} line(s) removed` : ""}`,
  });
  return (
    `“${doc.title}” is filed under supplier statements` +
    (invoices.length ? `, and ${lines ? `${lines} line${lines === 1 ? "" : "s"} and ` : ""}its invoice record no longer count as purchases.` : ".")
  );
}
