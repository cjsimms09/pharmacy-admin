/**
 * How much of a basket bought elsewhere would have counted toward the primary's compliance ratio.
 *
 * The band guard in `shelf.ts` asks what moving a basket off the primary costs in rebate. To answer
 * it needs one number — how much of that basket the primary would have invoiced *as a contract
 * generic* — because that is the only money the compliance ratio's numerator moves by. Today it is
 * not given one, so `bandCostOfMoving` falls back to charging the whole basket, and an inflated
 * cost is designed to overrule the invoice saving: baskets flip back to the primary that were
 * genuinely cheaper away from it.
 *
 * ── The side that has to be read, which is easy to get wrong ──
 *
 * The flag that decides this is the **primary's** catalogue flag for the NDC, not the secondary's.
 * `supplier_items.contract_flag` says whether a line sits on a purchasing contract *at the supplier
 * whose catalogue it came from* — so a secondary's flags describe the secondary's own programme,
 * which has nothing to do with the primary's ratio. Every secondary in this pharmacy's catalogue is
 * 100% "not rebated", and reading that as the contract share would put nought on every basket,
 * switch the guard off entirely, and send orders to secondaries even where a band really is at
 * stake. That is a worse error than the conservative one it replaces, and in the opposite
 * direction.
 *
 * So: for each line, find the **primary's** offer for the same NDC, and count it where the primary
 * marks it a contract line.
 *
 * ── And valued as the primary would have invoiced it ──
 *
 * At the primary's gross unit cost, not the secondary's price and not net of any rebate. The ratio
 * counts invoice dollars through the primary; what the basket cost somewhere else is a different
 * number and using it would misstate the numerator by the whole saving.
 *
 * ── Three answers, not one ──
 *
 * A line the primary does not stock at all, and a line the primary stocks with no flag on it, are
 * both genuinely unknown — and they are unknown in opposite directions, so folding them into either
 * total would be a guess wearing a figure's clothes. They are returned separately and named on the
 * page, so a basket that is mostly unknown reads as mostly unknown rather than as priced.
 */

/** The least an offer must carry for this. `shelf.ts` builds exactly this shape. */
export type OfferForShare = {
  ndc11: string;
  supplier: string;
  /** Gross, as the catalogue prints it. The ratio counts invoice dollars, never net of rebate. */
  unitCostMicros: number;
  /** True where the primary's catalogue marks the line a contract item; null where it says nothing. */
  rebated: boolean | null;
};

/** The least a planned line must carry. `order-plan.ts` builds exactly this shape. */
export type LineForShare = { ndc11: string; unitsThousandths: number; costCents: number };

const MICROS_PER_CENT = 10_000;

export type ContractShare = {
  /** Lines the primary marks a contract item, at the primary's own price. This is the guard's input. */
  contractCents: number;
  /** Lines the primary stocks and does not mark a contract item. These cannot move the band. */
  nonContractCents: number;
  /** Lines the primary stocks with no flag at all, at the primary's price. */
  unflaggedCents: number;
  /** Lines the primary does not stock, at what the basket actually cost. Not a contract line here. */
  notStockedCents: number;
  /** What the whole basket would have cost at the primary, where every line could be priced. */
  atPrimaryCents: number;
  /** How much of the basket could not be answered either way, as a share of it. */
  unknownShare: number;
  says: string;
};

const centsAtPrimary = (line: LineForShare, at: OfferForShare) =>
  Math.round((at.unitCostMicros * line.unitsThousandths) / 1000 / MICROS_PER_CENT);

const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

/**
 * The contract share of one basket, read off the primary's own catalogue.
 *
 * `primaryOffers` is every offer whose supplier is the primary, keyed by NDC — the caller has that
 * list already and building the map here per basket would be the same work several times over.
 */
export function contractShareAtPrimary(lines: LineForShare[], primaryOffers: Map<string, OfferForShare>): ContractShare {
  let contractCents = 0;
  let nonContractCents = 0;
  let unflaggedCents = 0;
  let notStockedCents = 0;
  for (const line of lines) {
    const at = primaryOffers.get(line.ndc11);
    if (!at) {
      notStockedCents += line.costCents;
      continue;
    }
    const cents = centsAtPrimary(line, at);
    if (at.rebated === true) contractCents += cents;
    else if (at.rebated === false) nonContractCents += cents;
    else unflaggedCents += cents;
  }
  const total = contractCents + nonContractCents + unflaggedCents + notStockedCents;
  const unknownCents = unflaggedCents + notStockedCents;
  const unknownShare = total > 0 ? Math.round((unknownCents / total) * 1000) / 1000 : 0;
  return {
    contractCents,
    nonContractCents,
    unflaggedCents,
    notStockedCents,
    atPrimaryCents: contractCents + nonContractCents + unflaggedCents,
    unknownShare,
    says:
      total === 0
        ? "Nothing in this basket could be priced against the primary's catalogue."
        : `${dollars(contractCents)} of this basket is a contract line at the primary and can move the band; ` +
          `${dollars(nonContractCents)} is stocked there and not on contract, so it cannot` +
          (unknownCents > 0
            ? `. ${dollars(unknownCents)} — ${Math.round(unknownShare * 100)}% of the basket — cannot be answered either way: ` +
              `${dollars(unflaggedCents)} carries no flag in the primary's catalogue and ${dollars(notStockedCents)} the primary does not stock.`
            : ", and every line was answered."),
  };
}

/**
 * What to charge the band guard, given the share — and how much of the answer is a guess.
 *
 * The unknown half is the whole difficulty. Count it as contract and the guard keeps overruling
 * real savings; count it as nothing and the guard stops protecting a band that is genuinely at
 * risk. Neither is defensible as a silent default, so the unknown is **included in the charge and
 * declared**: the guard stays conservative, which is the safe direction when the downside is
 * several hundred dollars months later on a report nobody connects to the decision — and the
 * basket says out loud how much of its cost rests on a flag nobody has.
 *
 * `confident` is true only where every line was answered. Where it is false the page should say the
 * band cost is an upper bound, not a figure, and the fix is a flag on the primary's catalogue
 * rather than a better formula.
 */
export function bandChargeFor(share: ContractShare): { chargeCents: number; confident: boolean; says: string } {
  const chargeCents = share.contractCents + share.unflaggedCents + share.notStockedCents;
  const confident = share.unflaggedCents === 0 && share.notStockedCents === 0;
  return {
    chargeCents,
    confident,
    says: confident
      ? `${dollars(chargeCents)} of this basket would have counted toward the primary's ratio, and every line was answered from its catalogue.`
      : `Between ${dollars(share.contractCents)} and ${dollars(chargeCents)} of this basket would have counted toward the primary's ratio. ` +
        `The band cost below is priced on the higher figure, so it is the most this can cost and not what it will. ` +
        `Flagging the ${Math.round(share.unknownShare * 100)}% the primary's catalogue does not answer would settle it.`,
  };
}
