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
 *   neverPriced    the pharmacy bought or dispensed it and nothing on file says what it paid.
 *                  The real gap, and the one worth acting on.
 *   neverBought    in a supplier's catalogue and never bought, never dispensed. Outside the
 *                  question entirely rather than inside it as a failure.
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
 * ── The denominator, which is the whole of the difficulty ──
 *
 * The ledger holds a row for every NDC in every supplier catalogue: 45,906 of them on 15 September,
 * of which 44,886 this pharmacy has never bought and never dispensed. Counting those would have put
 * "608 of 45,906 drugs priced" on the screen — 1.3%, when the true answer to the question being
 * asked is 423 of 835, or fifty-one per cent. Session 1 caught it before it reached him.
 *
 * So the denominator is drugs this pharmacy has **bought or dispensed**, and a catalogue listing
 * nobody here has ever touched is not in it.
 *
 * That is deliberately not the treatment the codeless delivery lines got, and the difference is
 * worth stating because the two look alike. Those six lines were inside the thing being measured —
 * a delivery the pharmacy paid for — and leaving them out silently would have let a delivery read
 * as fully priced when part of it was never asked about. A catalogue-only row is not inside
 * anything: no delivery, no payment, no event. It is not a part that would go missing; it is
 * outside the subject. It is said once, after the full stop, so that nobody wonders where
 * forty-five thousand rows went — and it is not a category of the answer.
 *
 * Pure, and reads the ledger's own rows rather than recomputing anything from them.
 */

/** The part of a ledger row this needs: what was paid, where that came from, and whether it moved. */
export type PricedRow = {
  ndc11: string;
  paid: { source: "invoice" | "catalogue" | "receipt" } | null;
  /**
   * Units dispensed in the period.
   *
   * With `paid`, this is what puts a row inside the question. A drug the pharmacy dispensed but has
   * no purchase record for is a real gap — it went out of the door and nothing says what it cost.
   * A drug it bought and has not dispensed is in too: it is stock, and stock has to be priced to be
   * valued or returned.
   */
  unitsDispensed: number;
};

export type CostCoverage = {
  drugs: number;
  fromInvoice: number;
  fromReceipt: number;
  neverPriced: number;
  /** Delivery lines carrying no drug code. Counted apart, never inside `drugs`. */
  noCode: number;
  /** Catalogue listings never bought and never dispensed. Outside the question, never inside `drugs`. */
  neverBought: number;
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
  /*
   * Bought or dispensed. A catalogue listing nobody here has touched is not a drug the site failed
   * to price — it is a drug nobody bought, and putting it in the denominator answers a question
   * nobody asked with a number that reads as a fault.
   */
  const paidFor = (r: PricedRow) => r.paid?.source === "invoice" || r.paid?.source === "receipt";
  const inScope = rows.filter((r) => paidFor(r) || r.unitsDispensed > 0);
  const neverBought = rows.length - inScope.length;

  const fromInvoice = inScope.filter((r) => r.paid?.source === "invoice").length;
  const fromReceipt = inScope.filter((r) => r.paid?.source === "receipt").length;
  const priced = fromInvoice + fromReceipt;
  const neverPriced = inScope.length - priced;

  const bought =
    neverBought === 0
      ? ""
      : ` ${neverBought.toLocaleString()} more ${neverBought === 1 ? "listing sits" : "listings sit"} in a supplier's catalogue that this pharmacy has never bought and never dispensed, and ${neverBought === 1 ? "it is" : "they are"} outside the question rather than counted as unpriced.`;
  const tail =
    (noCode === 0
      ? ""
      : ` Separately, ${plural(noCode, "delivery line carries", "delivery lines carry")} no drug code — a front-end item or a supplement — and ${noCode === 1 ? "is" : "are"} outside every figure above rather than counted as unpriced.`) + bought;

  if (inScope.length === 0) {
    return {
      drugs: 0, fromInvoice, fromReceipt, neverPriced, noCode, neverBought, priced,
      says: `This pharmacy has not bought or dispensed anything, so there is nothing to price.${tail}`,
    };
  }

  const bits = [`${priced.toLocaleString()} of ${plural(inScope.length, "drug", "drugs")} bought or dispensed have a cost this site can state`];
  if (fromInvoice) bits.push(`${fromInvoice.toLocaleString()} from a wholesaler's invoice`);
  if (fromReceipt) bits.push(`${fromReceipt.toLocaleString()} from a delivery whose invoice never came`);
  if (neverPriced) bits.push(`${plural(neverPriced, "is", "are")} not priced at all`);
  return { drugs: inScope.length, fromInvoice, fromReceipt, neverPriced, noCode, neverBought, priced, says: `${bits.join(", ")}.${tail}` };
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
