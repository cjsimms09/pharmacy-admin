import "server-only";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client, logUsage, MOCK } from "./ai";

/**
 * Anything that arrives with money on it, read once and filed where the money goes.
 *
 * The owner's brief: photograph or forward any invoice — a wholesaler's, a supply vendor's, the
 * electricity bill, a remittance advice, a rebate statement — and have the site work out what it
 * is, which supplier or vendor it belongs to, and what it carries, so filing it is one look and one
 * press rather than typing. The compliance intake (`ai.ts` `classifyDocument`) already does this
 * for licences and certificates; this is the business half.
 *
 * ── What it reads and where each goes ──
 *
 *   wholesaler_invoice  → the invoices page (`fileInvoice`): schedule, lines, total, paid date
 *   bill                → Spending (`saveExpense`): vendor, category, date, amount, paid date
 *   remittance          → the fills (`recordClaimPayment`) and the bank (`cash_receipts`)
 *   rebate_statement    → Spending under "Wholesaler rebates" (replaces the estimate) and, where
 *                         the money arrived, the bank
 *   supplier_statement, credit_memo, bank_statement → the vault under their category, with a note
 *   compliance_document → handed to the compliance classifier
 *   other               → the vault
 *
 * ── Rules ──
 *
 * Money in cents, dates as YYYY-MM-DD, nothing guessed: a figure the document does not print is
 * left out and said in notes. Every optional field is `.optional()` and never `.nullable()` —
 * the API's grammar allows sixteen union-typed fields and a nullable is a union (see the note in
 * `contract-terms.ts`). No patient information is ever copied: a remittance names prescriptions
 * by number, which is all this keeps.
 */

export const BUSINESS_KINDS = [
  "wholesaler_invoice",
  "bill",
  "remittance",
  "rebate_statement",
  "supplier_statement",
  "credit_memo",
  "bank_statement",
  "sales_summary",
  "compliance_document",
  "other",
] as const;
export type BusinessKind = (typeof BUSINESS_KINDS)[number];

export const BusinessDoc = z.object({
  kind: z.enum(BUSINESS_KINDS),
  /** Who the document is from — the wholesaler, the vendor, the payer, the bank — as printed. */
  party: z.string(),
  /** The name from the known suppliers or vendors it matches, exactly as listed, where one does. */
  partyIsKnownAs: z.string().optional(),
  documentNumber: z.string().optional(),
  /** YYYY-MM-DD. */
  documentDate: z.string().optional(),
  dueDate: z.string().optional(),
  periodFrom: z.string().optional(),
  periodTo: z.string().optional(),
  subtotalCents: z.number().optional(),
  taxCents: z.number().optional(),
  totalCents: z.number().optional(),
  /** Only where the document itself says it was paid, and when. */
  paidOn: z.string().optional(),
  /** For a bill: the expense category from the list given, exactly as listed. */
  suggestedCategory: z.string().optional(),
  /** What it charges for, line by line, as far as the figures can be read. Cents. */
  lines: z.array(
    z.object({
      description: z.string(),
      quantity: z.number().optional(),
      unitCents: z.number().optional(),
      extendedCents: z.number().optional(),
      ndc: z.string().optional(),
    }),
  ),
  /** For a remittance advice on paper: the payments it lists, by prescription number only. */
  remittance: z
    .object({
      payer: z.string().optional(),
      traceNumber: z.string().optional(),
      paidOn: z.string().optional(),
      totalPaidCents: z.number().optional(),
      claims: z.array(
        z.object({
          rxNumber: z.string(),
          fillNumber: z.number().optional(),
          serviceDate: z.string().optional(),
          paidCents: z.number(),
        }),
      ),
    })
    .optional(),
  /** One sentence a pharmacist would recognise: "IPC invoice 448812, 3 September, $1,437.34". */
  summary: z.string(),
  /** 0 to 1. Below 0.6 every field is checked by a person before anything is filed. */
  confidence: z.number(),
  /** What could not be read, what was inferred, and anything to check. Plain language. */
  notes: z.string().optional(),
});
export type BusinessDocT = z.infer<typeof BusinessDoc>;

const SYSTEM = `You read the documents an independent pharmacy's business runs on and say what each one is and what it carries, so it can be filed to the right place without anybody typing it.

Kinds:
- wholesaler_invoice: an invoice from a pharmaceutical wholesaler (McKesson, IPD, IPC, ParMed, Cardinal, AmerisourceBergen and the like) for drugs, with NDCs on the lines.
- bill: any other invoice or receipt the pharmacy has to pay — rent, utilities, phone, software, insurance, a supply vendor (vials, bags, labels), a repair, postage, a professional fee.
- remittance: a payer's remittance advice or explanation of payment listing prescriptions and what was paid on each, with a check or trace number and a payment date.
- rebate_statement: a wholesaler's rebate breakdown or statement of rebates earned for a period.
- supplier_statement: a wholesaler's statement of account listing invoices and balances.
- credit_memo: a credit from a supplier for a return or a correction.
- bank_statement: the bank's statement of the account.
- sales_summary: a PioneerRx System Sales Summary or other till report.
- compliance_document: a licence, registration, certificate, training record, CQI form, policy, inventory sheet.
- other: anything else, or a document too poor to read.

Rules:
- Money in cents: $538.70 is 53870. Dates as YYYY-MM-DD. Leave a field out rather than guess it, and say what was left out in notes.
- party is who the document is from, as printed. partyIsKnownAs is the exact name from the known list it matches, or left out when none does — never a near miss.
- For a bill, suggestedCategory is the exact name from the category list that fits best, or left out.
- For a wholesaler invoice, lines may be left empty: the invoice reader takes the item table itself. Do give the invoice number, date and total.
- For a remittance, list every prescription number with what was paid on it; never copy a patient's name, date of birth, member id or address anywhere.
- If the document says it has been paid (a receipt, a "PAID" stamp, a card slip), give paidOn; otherwise leave it out.
- summary is one sentence a pharmacist would recognise the document by. notes are for a pharmacist, not a developer.`;

export type KnownParties = { suppliers: string[]; vendors: string[]; categories: string[] };

export async function readBusinessDocument(
  file: { buffer: Buffer; mimeType: string; fileName: string },
  known: KnownParties,
  ctx: { userId: string; userName: string },
): Promise<BusinessDocT> {
  if (MOCK) {
    return {
      kind: "bill",
      party: "Scratch Electric Co",
      documentNumber: "INV-1001",
      documentDate: "2026-09-03",
      totalCents: 24_650,
      suggestedCategory: known.categories.find((c) => /utilit/i.test(c)),
      lines: [{ description: "Electricity, August", extendedCents: 24_650 }],
      summary: `Mock read of ${file.fileName}: an electricity bill for $246.50.`,
      confidence: 0.9,
      notes: "Mock mode: no document was read.",
    };
  }
  const { client: c, model } = await client();
  const isPdf = file.mimeType === "application/pdf";
  const isImage = file.mimeType.startsWith("image/");
  if (!isPdf && !isImage) throw new Error("Claude can read PDFs and photos. Save anything else as a PDF first.");
  const data = file.buffer.toString("base64");
  const block: Anthropic.ContentBlockParam = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: file.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data } };
  const res = await c.messages.parse({
    model,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: zodOutputFormat(BusinessDoc) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          block,
          {
            type: "text" as const,
            text:
              `File name: ${file.fileName}\n` +
              `Known suppliers (wholesalers): ${known.suppliers.length ? known.suppliers.join("; ") : "(none)"}\n` +
              `Known vendors: ${known.vendors.length ? known.vendors.join("; ") : "(none)"}\n` +
              `Expense categories: ${known.categories.join("; ")}\n\n` +
              "Say what this document is and what it carries.",
          },
        ],
      },
    ],
  });
  await logUsage("ai.read_business_document", ctx.userId, ctx.userName, res.usage, `model=${res.model} ${file.fileName}`);
  if (res.stop_reason === "refusal") throw new Error("Claude declined to read this document.");
  if (!res.parsed_output) throw new Error("Claude could not read this document. Try a clearer photo, or file it by hand.");
  return res.parsed_output;
}

/** An X12 835 as a file: the interchange header, then the transaction set for a remittance. */
export function looksLikeX12Remittance(buf: Buffer, fileName = ""): boolean {
  const head = buf.subarray(0, 4000).toString("latin1");
  if (!/^\s*ISA\*/.test(head)) return false;
  return /ST\*835\*/.test(head) || /\.835$/i.test(fileName) || /BPR\*/.test(head);
}

/**
 * The register row a printed name belongs to: exact first, then contained either way, then
 * nothing. A near miss is nothing — money filed against the wrong vendor is worse than unfiled.
 */
export function matchParty<T extends { id: string; name: string; alsoKnownAs?: string | null }>(name: string | null | undefined, rows: T[]): T | null {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return null;
  const names = (r: T) => [r.name, r.alsoKnownAs ?? ""].map((x) => x.trim().toLowerCase()).filter(Boolean);
  return (
    rows.find((r) => names(r).includes(n)) ??
    rows.find((r) => names(r).some((x) => x.length >= 4 && (n.includes(x) || x.includes(n)))) ??
    null
  );
}

/** Whether a bill with this number from this vendor is already on file, so the money is not counted twice. */
export function duplicateBill(
  held: { vendorId: string | null; invoiceNumber: string | null; amountCents: number; invoiceDate: string }[],
  vendorId: string | null,
  invoiceNumber: string | null | undefined,
  amountCents: number | null | undefined,
  invoiceDate: string | null | undefined,
): { vendorId: string | null; invoiceNumber: string | null; amountCents: number; invoiceDate: string } | null {
  const num = (invoiceNumber ?? "").trim().toLowerCase();
  if (vendorId && num) {
    const hit = held.find((h) => h.vendorId === vendorId && (h.invoiceNumber ?? "").trim().toLowerCase() === num);
    if (hit) return hit;
  }
  if (vendorId && amountCents && invoiceDate) {
    const hit = held.find((h) => h.vendorId === vendorId && h.amountCents === amountCents && h.invoiceDate === invoiceDate);
    if (hit) return hit;
  }
  return null;
}

/** The queue's one-line description of a read document. */
export function describeBusinessDoc(d: BusinessDocT): string {
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const bits = [d.party, d.documentNumber ? `#${d.documentNumber}` : null, d.documentDate ?? null, d.totalCents !== undefined ? money(d.totalCents) : null].filter(Boolean);
  return bits.join(" · ") || d.summary;
}
