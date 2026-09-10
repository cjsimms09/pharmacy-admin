/**
 * Every supplier invoice re-read from its own file, against what the tables hold.
 *
 * The five proofs before this one — NADAC, the catalogue, the claims, the directory, the shelf —
 * exist because a reader that goes wrong goes wrong quietly. The invoices had none, and on
 * 9 September the owner printed the supplier invoices screen and three faults came off one page:
 *
 *   A $9,890.97 McKesson invoice had no item lines at all. Not a scan — 26,415 characters of text.
 *   The reader found 55 lines summing $9,718.06 against the printed $9,890.97, and because they did
 *   not reconcile it threw all 55 away. The $172.91 was two lines whose contract rebate flag prints
 *   "KI" and "KD" where the pattern wanted exactly "K". So what the pharmacy paid per NDC on any of
 *   that invoice reached nothing, and the buy list was blind on 57 drugs.
 *
 *   A ParMed invoice filed with no date, because it prints its label and its value on separate
 *   rows. An undated invoice is out of reach of a date range, and a date range is what an inspector
 *   asks for.
 *
 *   And the invoice went on saying it had no lines after the reader could read them.
 *
 * Every one of those is visible in a minute's arithmetic against the file, and none of them was
 * visible on any screen until a person went looking. That is what this is for.
 *
 * ── The four questions, and why the last one is the new lesson ──
 *
 *   Does it reconcile?     The item lines sum to the total the invoice prints. The reader's own
 *                          gate asks this before storing; this asks it again, of what was stored.
 *   Are there lines?       An invoice with a total and no lines is money the site cannot attribute
 *                          to any drug. It looks complete on the screen that lists invoices.
 *   Is it dated?           An undated invoice cannot be produced for a period.
 *   Has the reader moved?  A fresh read finding **more** lines than are stored means the reader has
 *                          improved since this invoice landed and nobody went back for it. That is
 *                          exactly what happened after the KI/KD fix, and it is the failure that no
 *                          amount of care at import time can prevent — the file was right, the
 *                          reader was wrong, and the fix does not reach backwards on its own.
 *
 * ── Three states, again ──
 *
 * A scanned invoice has no text to re-read and proves nothing. That is not a failure and must not
 * be counted as one: `unreadable` is its own figure, apart from `disagreed`, because "we could not
 * check this" and "we checked it and it is wrong" are different facts about an invoice.
 *
 * Pure. `scripts/prove-invoices.ts` does the reading and writes the JSON this parses.
 */

export type InvoiceProofRow = {
  invoiceId: string;
  supplier: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  /** The total printed on the invoice, as stored. Null where the reader never found one. */
  totalCents: number | null;
  /** Item lines held in the tables for this invoice, and what they sum to. */
  storedLines: number;
  storedCents: number;
  /** What the reader finds in the file today, and what that sums to. */
  freshLines: number;
  freshCents: number;
  /** True where the file could not be re-read at all: a scan, or the file is gone. */
  unreadable: boolean;
  why: string | null;
};

export type InvoiceProof = {
  /** The day the job ran. Carried so a job that has stopped ages visibly on the screen. */
  provedOn: string | null;
  invoices: number;
  /** Stored lines sum to the printed total. */
  reconciled: number;
  /** Stored lines do not sum to the printed total. */
  disagreed: number;
  /** A total, and no lines at all. The $9,890.97 case. */
  noLines: number;
  /** No invoice date. The ParMed case. */
  undated: number;
  /** The reader now finds lines this invoice does not have. The KI/KD case. */
  readerMovedOn: number;
  /** No text to re-read. Not a failure. */
  unreadable: number;
  /** Money on invoices whose lines reach no drug: what the buy list is blind to. */
  unattributedCents: number;
  rows: InvoiceProofRow[];
  lines: string[];
};

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseInvoiceProof(raw: string | undefined | null): InvoiceProof | null {
  if (!raw) return null;
  let j: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    j = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const rows = Array.isArray(j.rows)
    ? (j.rows as Record<string, unknown>[]).filter((r) => r && typeof r === "object").map(
        (r): InvoiceProofRow => ({
          invoiceId: str(r.invoiceId) ?? "",
          supplier: str(r.supplier),
          invoiceNumber: str(r.invoiceNumber),
          invoiceDate: str(r.invoiceDate),
          totalCents: numOrNull(r.totalCents),
          storedLines: num(r.storedLines),
          storedCents: num(r.storedCents),
          freshLines: num(r.freshLines),
          freshCents: num(r.freshCents),
          unreadable: r.unreadable === true,
          why: str(r.why),
        }),
      )
    : [];
  return {
    provedOn: str(j.provedOn),
    invoices: num(j.invoices),
    reconciled: num(j.reconciled),
    disagreed: num(j.disagreed),
    noLines: num(j.noLines),
    undated: num(j.undated),
    readerMovedOn: num(j.readerMovedOn),
    unreadable: num(j.unreadable),
    unattributedCents: num(j.unattributedCents),
    rows,
    lines: strs(j.lines),
  };
}

/**
 * Invoices proved, out of the invoices that could be proved.
 *
 * The denominator excludes the unreadable ones deliberately. A scanned invoice is not a failure of
 * this check and putting it in the denominator would make the fraction fall every time somebody
 * photographs a delivery note, which trains people to ignore the number.
 */
export function invoiceProofFraction(p: InvoiceProof): { numerator: number; denominator: number } {
  const checkable = p.invoices - p.unreadable;
  return { numerator: Math.max(0, p.reconciled), denominator: Math.max(0, checkable) };
}

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * What is wrong, in the order somebody would act on it.
 *
 * An invoice with no lines first, because it is the one that is invisible: it looks filed, it looks
 * complete, and every drug on it is missing from what the pharmacy knows it paid.
 */
export function invoiceProofGaps(p: InvoiceProof): string[] {
  const out: string[] = [];
  if (p.noLines > 0) {
    out.push(
      `${plural(p.noLines, "invoice has", "invoices have")} a total and no item lines${p.unattributedCents > 0 ? `, ${money(p.unattributedCents)} in all` : ""}. Nothing on ${p.noLines === 1 ? "it" : "them"} reaches any drug, so the buy list and every margin are blind to what was paid.`,
    );
  }
  if (p.readerMovedOn > 0) {
    out.push(
      `${plural(p.readerMovedOn, "invoice", "invoices")} can be read better now than when ${p.readerMovedOn === 1 ? "it" : "they"} arrived — a fresh read finds lines the tables do not hold. The reader has improved and nobody went back. Press Read again on ${p.readerMovedOn === 1 ? "it" : "them"}.`,
    );
  }
  if (p.disagreed > 0) {
    out.push(
      `${plural(p.disagreed, "invoice's", "invoices'")} stored lines do not sum to the total printed on ${p.disagreed === 1 ? "it" : "them"}.`,
    );
  }
  if (p.undated > 0) {
    out.push(
      `${plural(p.undated, "invoice has", "invoices have")} no date, so ${p.undated === 1 ? "it is" : "they are"} out of reach of any date range — which is what an inspector asks for.`,
    );
  }
  return out;
}

/**
 * The sentence under the row: what was checked, and what could not be.
 *
 * Says the unreadable count out loud rather than letting it hide inside a fraction, because "we
 * could not check this" is a fact somebody may want to do something about — a scanned invoice can
 * be asked for again as a PDF.
 */
export function invoiceProofNote(p: InvoiceProof): string {
  if (p.invoices === 0) return "No supplier invoice has been filed yet, so there is nothing to re-read.";
  const { numerator, denominator } = invoiceProofFraction(p);
  const bits: string[] = [];
  bits.push(
    denominator === 0
      ? `None of the ${plural(p.invoices, "invoice", "invoices")} on file could be re-read.`
      : `${numerator.toLocaleString()} of ${plural(denominator, "invoice", "invoices")} re-read from ${denominator === 1 ? "its own file" : "their own files"} sum${numerator === 1 ? "s" : ""} to the total printed on ${denominator === 1 ? "it" : "them"}.`,
  );
  if (p.unreadable > 0) {
    bits.push(
      `${plural(p.unreadable, "invoice", "invoices")} carried no text to re-read — a scan rather than a fault, and nothing about ${p.unreadable === 1 ? "it" : "them"} is claimed either way.`,
    );
  }
  if (p.provedOn) bits.push(`Last re-read ${p.provedOn}.`);
  return bits.join(" ");
}
