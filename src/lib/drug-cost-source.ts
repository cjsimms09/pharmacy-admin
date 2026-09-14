/**
 * What a drug cost, and on whose authority — with the weaker source never pretending to be the
 * stronger one.
 *
 * Invoice coverage is 51%. The other half of what this pharmacy bought has no per-drug cost on any
 * screen that prices an order, times a return or backs an appeal — while the figures sit in
 * `pioneer_purchases.itemsJson`, already parsed, one table away.
 *
 * Measured on the real database, 14 September 2026: 96 deliveries, $275,908.19, all of September.
 * 34 have an invoice on file. **62 do not, worth $157,264.78** — and every one of those 62 carries
 * `itemsJson`, 554 item lines between them, 548 of which (98.9%) have an eleven-digit NDC and a
 * cost. So this is not a handful of edge cases: it is more than half the pharmacy's buying by value,
 * and the data to price it is complete.
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
 * ── One delivery is one cost, and the number alone does not prove it ──
 *
 * A receipt and an invoice for the same delivery are the same money. They are matched on the
 * wholesaler's own invoice number, which is the join `invoices-owed.ts` already uses and the only
 * field both systems copy from the same place — **and on the supplier agreeing**.
 *
 * On today's data this path is cold: there are 35 invoices in the whole estate and 34 already match
 * a delivery, so nothing clashes. Kept anyway — it costs nothing to be right before it matters — and
 * its silence is not evidence it works.
 *
 * The number alone was the first version and it is not enough in either direction. Two wholesalers
 * can issue the same number, and a delivery whose supplier is named differently on the two sides is
 * exactly the fault already found on 10 September: ParMed invoices filed under Cardinal, because
 * ParMed is a Cardinal company and was not on the name list. So where the numbers match and the
 * suppliers disagree, this suppresses nothing and says so — `numberClashWith` carries the other
 * name. Hiding a cost the pharmacy has, on the strength of a number that may belong to somebody
 * else, is the worse of the two errors: nothing here reaches the money accounts, so the risk is a
 * drug with no price rather than a sum counted twice.
 *
 * ── Read from figures, never from prose ──
 *
 * `pioneer_purchases` carries both `itemsJson` and `itemsText`, and `invoice-price-check.ts` falls
 * back to reading the text where the JSON is empty. This does not, and the omission is deliberate.
 * Every row in the table is September 2026 and all 96 have both columns populated, so the fallback
 * would be an untested branch carried for a case that does not exist. If a backfill ever loads
 * pre-September deliveries the loader must refuse them here rather than reach for the text: a cost
 * read out of prose is a different confidence from one read out of figures, and this module's whole
 * job is not to blur two confidences together.
 *
 * Pure. Nothing here reaches the money accounts: `profit-and-loss.ts` sources purchases from the
 * wholesaler invoices dated in the month, and a receipt-derived figure must stay out of it or the
 * stock-movement check counts the same delivery twice.
 */

import { sameWholesaler } from "./supplier-match";

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
  /**
   * The supplier on an invoice carrying this delivery's number but a different wholesaler's name.
   *
   * Null in the ordinary case. Set where the two systems disagree about who sent it, which is
   * either one delivery named twice or two deliveries sharing a number, and this cannot tell which.
   */
  numberClashWith: string | null;
  /** One sentence naming the source and its weight, for wherever the figure is shown. */
  says: string;
};

/** Two references are the same delivery. Wholesalers pad and punctuate their own numbers unevenly. */
const norm = (v: string | null | undefined): string => (v ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

/*
 * Whether two records name the same wholesaler: `sameWholesaler` in supplier-match.ts, which is the
 * site's one answer to that question. This module had its own and it was the same one the invoice
 * proof had — both missed an acronym against its own expansion, and the proof reported ten
 * disagreements on 14 September of which ten were IPC against "Independent Pharmacy Cooperative".
 */

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
      numberClashWith: null,
      says: `${money(bestInvoice.unitCostCents)} a unit, from ${bestInvoice.supplier ?? "the wholesaler"}'s invoice${bestInvoice.invoiceNumber ? ` ${bestInvoice.invoiceNumber}` : ""}${bestInvoice.invoiceDate ? ` of ${bestInvoice.invoiceDate}` : ""}.`,
    };
  }

  /*
   * A receipt whose delivery an invoice already bills for is not a second cost — where the two
   * agree about who sent it. Where they do not, the receipt stands and the disagreement is named:
   * see the note above on why hiding a real cost is the worse error here.
   */
  const byNumber = new Map<string, InvoiceCost[]>();
  for (const l of invoiceLines) {
    const k = norm(l.invoiceNumber);
    if (!k) continue;
    byNumber.set(k, [...(byNumber.get(k) ?? []), l]);
  }
  let clash: string | null = null;
  const standing = receipts.filter((r) => {
    const against = byNumber.get(norm(r.invoiceNumber)) ?? [];
    if (against.length === 0) return true;
    if (against.some((l) => sameWholesaler(l.supplier, r.supplier))) return false;
    clash = against[0].supplier ?? null;
    return true;
  });

  const bestReceipt = newest(standing);
  if (!bestReceipt) {
    return {
      ndc11,
      authority: "neverBought",
      supplier: null,
      unitCostCents: null,
      on: null,
      reference: null,
      numberClashWith: null,
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
    numberClashWith: clash,
    says:
      (clash
        ? `An invoice on file carries this delivery's number ${bestReceipt.invoiceNumber ?? ""} under ${clash} rather than ${bestReceipt.supplier ?? "this wholesaler"} — either one delivery named twice or two sharing a number, and this cannot tell which, so the cost is shown rather than hidden. `
        : "") +
      (waiting
      ? `${money(bestReceipt.unitCostCents)} a unit, from ${where}, as PioneerRx booked it in. The wholesaler's invoice has not arrived yet, so this is what was received rather than what was billed.`
      : `${money(bestReceipt.unitCostCents)} a unit, from ${where}, as PioneerRx booked it in. No invoice is coming for this one, so the receipt is the record — good enough to price an order, and not a document to produce to a plan.`),
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
