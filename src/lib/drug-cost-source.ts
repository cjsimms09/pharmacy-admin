/**
 * What a drug cost, and on whose authority — with the weaker source never pretending to be the
 * stronger one.
 *
 * Invoice coverage is 51%. The other half of what this pharmacy bought has no per-drug cost on any
 * screen that prices an order, times a return or backs an appeal — while the figures sit in
 * `pioneer_purchases.itemsJson`, already parsed, one table away.
 *
 * ── Why this is not "write invoice lines from the receipt" ──
 *
 * The owner, and the schema records it: *"we shouldn't be taking pioneer order receipts as
 * invoices, invoices are mailed to us from suppliers and that's what we have to keep."* The two
 * live in separate tables deliberately, so that no query can count a delivery twice by forgetting a
 * flag. Merging them would be the fault the separation exists to prevent.
 *
 * But he asked for the other half in the same breath: the receipt stands in *"for a purchase whose
 * invoice never reached the pharmacy"* — *"to catch the money from invoices we didn't get."* So the
 * receipt is a cost source that names itself as one. An invoice always wins. A receipt answers only
 * where no invoice covers that delivery, and says so wherever its figure is shown.
 *
 * ── The four states, because "no cost" is three different facts ──
 *
 *   invoice          the wholesaler's own document. The authority, and what an appeal can produce.
 *   receipt          PioneerRx booked the delivery in and no invoice covers it. Real, weaker, and
 *                    labelled — good enough to price an order, not offered as proof to a PBM.
 *   notYetArrived    a delivery is booked in, an invoice is expected, and it has not come. Its cost
 *                    is the receipt's for now and the document is still owed.
 *   neverBought      nothing on file says this pharmacy has ever bought this NDC. Not a gap in the
 *                    records — an absence of the event.
 *
 * "Missing" is not among them, which is the point.
 *
 * ── One delivery is one cost ──
 *
 * A receipt and an invoice for the same delivery are the same money. They are matched on the
 * wholesaler's own invoice number, which is the join `invoices-owed.ts` already uses and the only
 * field both systems copy from the same place. A receipt whose number matches an invoice on file is
 * never a cost of its own.
 *
 * Pure. Nothing here reaches the money accounts: `profit-and-loss.ts` sources purchases from the
 * wholesaler invoices dated in the month, and a receipt-derived figure must stay out of it or the
 * stock-movement check counts the same delivery twice.
 */

export type CostAuthority = "invoice" | "receipt" | "notYetArrived" | "neverBought";

/** One invoice line, as the tables hold it. */
export type InvoiceCost = {
  ndc11: string;
  supplier: string | null;
  /** The wholesaler's own number. What ties an invoice to the delivery it bills for. */
  invoiceNumber: string | null;
  invoiceDate: string | null;
  quantity: number;
  unitCostCents: number;
  extendedCents: number;
};

/** One line of a delivery PioneerRx booked in. */
export type ReceiptCost = {
  ndc11: string;
  supplier: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  quantity: number;
  unitCostCents: number;
  extendedCents: number;
  /** True where the owner has said this delivery is closed on its receipt: no invoice is coming. */
  receiptSettles: boolean;
};

export type DrugCost = {
  ndc11: string;
  authority: CostAuthority;
  supplier: string | null;
  /** What one unit cost, in cents. Null only where the authority is `neverBought`. */
  unitCostCents: number | null;
  /** The day the cost is good as of: the invoice's date, or the delivery's. */
  on: string | null;
  /** The wholesaler's own number, so the figure can be traced to the page it came from. */
  reference: string | null;
  /** One sentence naming the source and its weight, for wherever the figure is shown. */
  says: string;
};

/** Two references are the same delivery. Wholesalers pad and punctuate their own numbers unevenly. */
const norm = (v: string | null | undefined): string => (v ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The newest of a set of cost lines, by the date on the document.
 *
 * Newest rather than cheapest: this answers what the drug costs today, not what it once cost. A row
 * with no date loses to any row that has one, because a figure that cannot be placed in time cannot
 * be shown to be current.
 */
function newest<T extends { invoiceDate: string | null }>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  const dated = rows.filter((r) => r.invoiceDate);
  if (dated.length === 0) return rows[0];
  return dated.reduce((best, r) => ((r.invoiceDate ?? "") > (best.invoiceDate ?? "") ? r : best));
}

/**
 * What one NDC cost, from the strongest source that covers it.
 *
 * `expectingInvoices` is the set of suppliers who do send invoices — used only to tell a delivery
 * whose document is still coming from one whose document is never coming. Both give the same
 * figure; they are different facts about whether anything is still owed, and the owner chases one
 * and not the other.
 */
export function costOf(
  ndc11: string,
  invoiceLines: InvoiceCost[],
  receiptLines: ReceiptCost[],
  expectingInvoices: (supplier: string | null) => boolean = () => true,
): DrugCost {
  const invoices = invoiceLines.filter((l) => l.ndc11 === ndc11);
  const receipts = receiptLines.filter((l) => l.ndc11 === ndc11);

  const bestInvoice = newest(invoices);
  if (bestInvoice) {
    return {
      ndc11,
      authority: "invoice",
      supplier: bestInvoice.supplier,
      unitCostCents: bestInvoice.unitCostCents,
      on: bestInvoice.invoiceDate,
      reference: bestInvoice.invoiceNumber,
      says: `${money(bestInvoice.unitCostCents)} a unit, from ${bestInvoice.supplier ?? "the wholesaler"}'s invoice${bestInvoice.invoiceNumber ? ` ${bestInvoice.invoiceNumber}` : ""}${bestInvoice.invoiceDate ? ` of ${bestInvoice.invoiceDate}` : ""}.`,
    };
  }

  /*
   * A receipt whose delivery an invoice already bills for is not a second cost. Matched on the
   * wholesaler's own number, which both systems copy from the same place — the only field on either
   * record that was not typed or read twice.
   */
  const billed = new Set(invoiceLines.map((l) => norm(l.invoiceNumber)).filter(Boolean));
  const standing = receipts.filter((r) => !billed.has(norm(r.invoiceNumber)));

  const bestReceipt = newest(standing);
  if (!bestReceipt) {
    return {
      ndc11,
      authority: "neverBought",
      supplier: null,
      unitCostCents: null,
      on: null,
      reference: null,
      says: "Nothing on file says this pharmacy has ever bought this drug. That is an absence of the event, not a gap in the records.",
    };
  }

  /*
   * Settled on its receipt, or still waiting for paper. The figure is identical and the two are
   * kept apart because only one of them is something to chase — and reporting a document as owed
   * when the owner has already decided none is coming is how a worklist stops being read.
   */
  const waiting = !bestReceipt.receiptSettles && expectingInvoices(bestReceipt.supplier);
  const where = `${bestReceipt.supplier ?? "the wholesaler"}'s delivery${bestReceipt.invoiceNumber ? ` ${bestReceipt.invoiceNumber}` : ""}${bestReceipt.invoiceDate ? ` of ${bestReceipt.invoiceDate}` : ""}`;
  return {
    ndc11,
    authority: waiting ? "notYetArrived" : "receipt",
    supplier: bestReceipt.supplier,
    unitCostCents: bestReceipt.unitCostCents,
    on: bestReceipt.invoiceDate,
    reference: bestReceipt.invoiceNumber,
    says: waiting
      ? `${money(bestReceipt.unitCostCents)} a unit, from ${where}, as PioneerRx booked it in. The wholesaler's invoice has not arrived yet, so this is what was received rather than what was billed.`
      : `${money(bestReceipt.unitCostCents)} a unit, from ${where}, as PioneerRx booked it in. No invoice is coming for this one, so the receipt is the record — good enough to price an order, and not a document to produce to a plan.`,
  };
}

/** True where the figure is strong enough to put in front of a payer. Only an invoice is. */
export function provable(cost: DrugCost): boolean {
  return cost.authority === "invoice";
}

export type CoverageSummary = {
  ndcs: number;
  fromInvoice: number;
  fromReceipt: number;
  notYetArrived: number;
  neverBought: number;
  says: string;
};

/**
 * How much of what the pharmacy dispenses it can price, and on what.
 *
 * Reported in NDCs rather than dollars on purpose: this is a question about coverage, and one
 * expensive drug would otherwise hide a hundred cheap ones nobody can price.
 */
export function coverage(costs: DrugCost[]): CoverageSummary {
  const n = (a: CostAuthority) => costs.filter((c) => c.authority === a).length;
  const fromInvoice = n("invoice");
  const fromReceipt = n("receipt");
  const notYetArrived = n("notYetArrived");
  const neverBought = n("neverBought");
  const priced = fromInvoice + fromReceipt + notYetArrived;

  if (costs.length === 0) return { ndcs: 0, fromInvoice, fromReceipt, notYetArrived, neverBought, says: "No drug was asked about." };

  const bits = [`${priced} of ${costs.length} drugs have a cost the site can state`];
  if (fromInvoice) bits.push(`${fromInvoice} from a wholesaler's invoice`);
  if (notYetArrived) bits.push(`${notYetArrived} from a delivery whose invoice has not arrived yet`);
  if (fromReceipt) bits.push(`${fromReceipt} from a delivery no invoice is coming for`);
  if (neverBought) bits.push(`${neverBought} this pharmacy has never bought`);
  return { ndcs: costs.length, fromInvoice, fromReceipt, notYetArrived, neverBought, says: `${bits.join(", ")}.` };
}
