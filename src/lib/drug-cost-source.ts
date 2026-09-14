/**
 * How much of what the pharmacy buys it can price, and on what evidence.
 *
 * ── What this used to be, and why it is smaller now ──
 *
 * It began as a second answer to "what did this drug cost": it took invoice lines and receipt lines
 * and decided between them, matching a delivery to its invoice on the wholesaler's own number. That
 * work was right and it is not here any more, because session 1 wired receipts into `buildLedger`
 * on 15 September and the ledger now decides it — one place, the one every buying screen already
 * reads.
 *
 * Keeping both would have been the fault this project keeps finding, in its worst form. Two readers
 * for one thing drift; two readers where **one of them is unused** drift silently, because nothing
 * tests the spare against reality and the first person to reach for it gets a different answer from
 * the screen beside them. Deleting the duplicate was the whole of the fix, and what is left is the
 * part the ledger does not do.
 *
 * ── What is left ──
 *
 * The ledger answers per drug. Nobody had asked the question above it: **of everything the pharmacy
 * buys, how much can this site price at all, and how much of that rests on a document the pharmacy
 * could produce?** That is a different question from any figure on a buying screen, and the rule
 * that a number carries its source wants an answer beside it rather than inferred.
 *
 * ── The states, and why one of them went ──
 *
 *   invoice        the wholesaler's own document. What an appeal can produce.
 *   receipt        PioneerRx booked the delivery in and no invoice covers it. Real money, weaker
 *                  evidence — good for a buying decision, never offered to a plan.
 *   neverPriced    nothing on file says what this pharmacy paid for it. Not a failure of the
 *                  readers: an absence of the purchase.
 *   noCode         a delivery line carrying no drug code at all. Outside every figure above rather
 *                  than inside one as a failure — all six on file are two McKesson front-end items
 *                  and four Xymogen nutraceuticals, $429.45, correctly codeless.
 *
 * An earlier version had `notYetArrived` between the second and third: a receipt whose invoice is
 * still expected. It is gone because `invoicesStillOwed()` answers it properly, against the supplier
 * register and the date the mailbox began watching, and it currently reports nothing owed by
 * anybody. Two answers to "is a document still coming" would have been the same mistake one
 * paragraph further down.
 *
 * "Missing" is not among them, which is the point.
 *
 * Pure, and reads the ledger's own rows rather than recomputing anything from them.
 */

/** The part of a ledger row this needs: what was paid for it, and where that came from. */
export type PricedRow = {
  ndc11: string;
  paid: { source: "invoice" | "catalogue" | "receipt" } | null;
};

export type CostCoverage = {
  drugs: number;
  fromInvoice: number;
  fromReceipt: number;
  neverPriced: number;
  /** Delivery lines carrying no drug code. Counted apart, never inside `drugs`. */
  noCode: number;
  /** Drugs with a cost from any source: the numerator of the useful fraction. */
  priced: number;
  /** One sentence, for above a table or beside a figure. */
  says: string;
};

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * What the site can price, counted in drugs.
 *
 * Drugs rather than dollars on purpose. One expensive drug would otherwise hide a hundred cheap ones
 * nobody can price, and the question here is how complete the picture is rather than how much money
 * is inside it.
 *
 * A `catalogue` source is not a price the pharmacy paid — it is what a supplier lists — so it does
 * not count as priced. That is the same rule the ledger applies in deciding what `paid` means: only
 * an invoice or a receipt is money that changed hands.
 */
export function costCoverage(rows: PricedRow[], noCode = 0): CostCoverage {
  const fromInvoice = rows.filter((r) => r.paid?.source === "invoice").length;
  const fromReceipt = rows.filter((r) => r.paid?.source === "receipt").length;
  const priced = fromInvoice + fromReceipt;
  const neverPriced = rows.length - priced;

  const tail =
    noCode === 0
      ? ""
      : ` Separately, ${plural(noCode, "delivery line carries", "delivery lines carry")} no drug code — a front-end item or a supplement — and ${noCode === 1 ? "is" : "are"} outside every figure above rather than counted as unpriced.`;

  if (rows.length === 0) {
    return { drugs: 0, fromInvoice, fromReceipt, neverPriced, noCode, priced, says: `No drug was asked about.${tail}` };
  }

  const bits = [`${priced.toLocaleString()} of ${plural(rows.length, "drug", "drugs")} have a cost this site can state`];
  if (fromInvoice) bits.push(`${fromInvoice.toLocaleString()} from a wholesaler's invoice`);
  if (fromReceipt) bits.push(`${fromReceipt.toLocaleString()} from a delivery whose invoice never came`);
  if (neverPriced) bits.push(`${plural(neverPriced, "is", "are")} not priced at all`);
  return { drugs: rows.length, fromInvoice, fromReceipt, neverPriced, noCode, priced, says: `${bits.join(", ")}.${tail}` };
}

/**
 * How much of the priced picture rests on a document the pharmacy could produce.
 *
 * Kept apart from `costCoverage` because it answers a different person's question. Coverage is for
 * whoever wants to know whether a buying screen is working on complete information. This is for
 * whoever is about to put a figure in front of a plan, where the only honest answer is the count of
 * invoices — a receipt is real money and not a document to send anybody.
 */
export function provableShare(c: CostCoverage): { numerator: number; denominator: number; says: string } {
  if (c.priced === 0) {
    return { numerator: 0, denominator: 0, says: "Nothing is priced, so nothing is evidenced either way." };
  }
  if (c.fromReceipt === 0) {
    return { numerator: c.fromInvoice, denominator: c.priced, says: "Every priced drug rests on a wholesaler's invoice." };
  }
  return {
    numerator: c.fromInvoice,
    denominator: c.priced,
    says:
      `${c.fromInvoice.toLocaleString()} of ${c.priced.toLocaleString()} priced drugs rest on an invoice the pharmacy could produce. ` +
      `The other ${c.fromReceipt.toLocaleString()} rest on what PioneerRx booked in at the counter — real money, and not a document to send a plan.`,
  };
}
