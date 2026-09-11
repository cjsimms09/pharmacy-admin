/**
 * The one page that proves what a drug cost, for a MAC appeal.
 *
 * Every PBM asks the same thing and asks it the same way: show us your acquisition cost per unit,
 * with the invoice behind it. Express Scripts' fax cover sheet goes further and says to mark the
 * appealed item with an X — which is the tell that a reviewer is looking at a wholesaler invoice
 * with eighty lines on it and has to find yours.
 *
 * ── Why not just send the invoice ──
 *
 * A McKesson invoice is up to nine pages of every drug bought that day at every price. Sending it
 * whole does three unhelpful things: it makes the reviewer hunt for the line, it hands a PBM the
 * pharmacy's entire acquisition cost list — which is its negotiating position — and on a controlled
 * substance invoice it discloses Schedule II purchasing that has no business being in a pricing
 * appeal.
 *
 * So this states the case on one page and shows the working: the invoice it came from, the line as
 * printed, the pack size from the FDA's own NDC directory, and the arithmetic from a per-bottle
 * price to a per-unit cost. A reviewer can check every step without reading anything else, and
 * nothing is disclosed that the appeal does not need.
 *
 * ── The arithmetic is shown because it is where this goes wrong ──
 *
 * A wholesaler prints the price of a bottle. The appeal wants the price of a tablet. Divide by the
 * wrong number and a methylphenidate tablet costs $245.98 instead of $2.46 — which is what a first
 * attempt at this produced, and it would have gone to a PBM under the pharmacy's name with its NPI
 * on it. So the pack size is named, its source is named, and the division is written out.
 *
 * Pure: it returns lines, and the caller renders them.
 */

export type EvidenceInput = {
  pharmacy: { name: string; ncpdp: string; npi: string; address: string; phone: string; email: string };
  /** The PBM's own reference for the appeal, where one has been issued. */
  appealRef: string | null;
  pbmName: string;
  claim: {
    rxNumber: string;
    dateFilled: string;
    ndc11: string;
    drugName: string | null;
    /** Units dispensed, in units — 30 tablets, 100 mL. */
    quantity: number;
    /** "Each", "Milliliter", as the PBM's own form labels it. */
    unitLabel: string;
    /** What the plan paid. */
    planPaidCents: number;
    /** What the patient paid at the counter. */
    copayCents: number;
  };
  invoice: {
    supplier: string;
    number: string;
    date: string;
    /** The line exactly as the invoice prints it. */
    description: string;
    /** Price of one package, as invoiced. */
    packPriceCents: number;
    /** Units in that package, and where that number came from. */
    packUnits: number;
    packSource: string;
  };
  /** The dispensing fee the appeal asks for on top of cost, in cents. */
  dispensingFeeCents: number;
};

export type Line = { text: string; bold?: boolean; size?: number; gapBefore?: number };

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/** Per-unit figures need more than two places: a tablet can cost a third of a cent. */
const unitMoney = (cents: number) => `$${(cents / 100).toFixed(4)}`;

export function buildEvidence(input: EvidenceInput): { lines: Line[]; fileName: string; shortfallCents: number } {
  const { pharmacy: p, claim: c, invoice: inv } = input;

  const costPerUnitCents = inv.packPriceCents / inv.packUnits;
  const totalCostCents = Math.round(costPerUnitCents * c.quantity);
  const receivedCents = c.planPaidCents + c.copayCents;
  const shortfallCents = totalCostCents - receivedCents;
  const askCents = totalCostCents + input.dispensingFeeCents;

  const line = (text: string, extra?: Omit<Line, "text">): Line => ({ text, ...extra });

  const lines: Line[] = [
    line("Acquisition Cost Evidence", { bold: true, size: 16 }),
    line(`${input.pbmName} MAC appeal${input.appealRef ? ` — ${input.appealRef}` : ""}`, { gapBefore: 4 }),

    line("Pharmacy", { bold: true, gapBefore: 14 }),
    line(`${p.name}   NCPDP ${p.ncpdp}   NPI ${p.npi}`),
    line(`${p.address}   ${p.phone}   ${p.email}`),

    line("The claim", { bold: true, gapBefore: 14 }),
    line(`Prescription ${c.rxNumber}, dispensed ${c.dateFilled}`),
    line(`${c.drugName ?? "(unnamed)"}   NDC ${c.ndc11}`),
    line(`Quantity dispensed: ${c.quantity} ${c.unitLabel.toLowerCase()}`),

    /*
     * The X the cover sheet asks for, on the line being appealed.
     *
     * Marked rather than merely mentioned, because the instruction exists for a reason: a reviewer
     * given a page of lines and no mark reads the wrong one or none of them.
     */
    line("The invoice line being appealed", { bold: true, gapBefore: 14 }),
    line(`[X]  ${inv.description}`, { bold: true }),
    line(`     ${inv.supplier} invoice ${inv.number}, dated ${inv.date}`),
    line(`     Invoiced at ${money(inv.packPriceCents)} per package`),
    line(`     Package contains ${inv.packUnits} ${c.unitLabel.toLowerCase()} (${inv.packSource})`),

    line("Acquisition cost per unit", { bold: true, gapBefore: 14 }),
    line(`${money(inv.packPriceCents)} / ${inv.packUnits} = ${unitMoney(costPerUnitCents)} per ${c.unitLabel.toLowerCase()}`),
    line(`${unitMoney(costPerUnitCents)} x ${c.quantity} dispensed = ${money(totalCostCents)} acquisition cost for this claim`),

    line("What was received", { bold: true, gapBefore: 14 }),
    line(`Plan paid:              ${money(c.planPaidCents)}`),
    line(`Patient copay:          ${money(c.copayCents)}`),
    line(`Total received:         ${money(receivedCents)}`),
    line(`Acquisition cost:       ${money(totalCostCents)}`),
    line(
      shortfallCents > 0
        ? `Reimbursed below cost by ${money(shortfallCents)}, before any dispensing fee.`
        : `Reimbursement exceeded acquisition cost by ${money(-shortfallCents)}.`,
      { bold: true, gapBefore: 6 },
    ),

    line("What is asked", { bold: true, gapBefore: 14 }),
    line(
      `Reimbursement of ${money(askCents)} — acquisition cost of ${money(totalCostCents)} plus a ${money(input.dispensingFeeCents)} dispensing fee — ` +
        `or ${unitMoney(askCents / c.quantity)} per ${c.unitLabel.toLowerCase()}.`,
    ),

    /*
     * Said plainly, because it is the honest scope of the claim.
     *
     * This page proves a cost and names a shortfall. It does not assert a statutory entitlement:
     * the Kansas floor under SB 20 reaches only plans outside ERISA preemption, and which of this
     * pharmacy's plans those are has not been established. Claiming a floor that does not apply is
     * how a pharmacy's appeals stop being read.
     */
    line(
      "This page evidences acquisition cost for the claim named above. The full wholesaler invoice is available on request.",
      { gapBefore: 14, size: 9 },
    ),
  ];

  return {
    lines,
    fileName: `acquisition-cost-${c.rxNumber}-${c.dateFilled}.pdf`,
    shortfallCents,
  };
}
