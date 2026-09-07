/**
 * Which contract governs a claim, and what that contract says it should have paid.
 *
 * The reads file a contract and nothing then checks a single claim against it. The terms sit in the
 * library as text — "AWP-15% + $1.00" — and the money they describe is never compared to the money
 * that arrived, which is the only reason to have read the contract at all.
 *
 * ── What a claim can be matched on ──
 *
 * Not a contract number: no claim carries one. What a claim carries is how it was routed, and that
 * is the NCPDP triple:
 *
 *   BIN    which processor adjudicated it
 *   PCN    which line of business inside that processor — one BIN carries a commercial plan and a
 *          Part D plan side by side, on different terms
 *   Group  which employer or plan inside that line of business
 *
 * BIN alone is not an answer, and this site already learned it: `payer_bins.collides` exists with
 * the note "never resolve on BIN alone". A contract naming three BINs and no groups governs every
 * group on those BINs; one naming groups governs only those. So the match is by specificity — the
 * contract that names the most of the triple wins, because it is the one that was negotiated for
 * this plan rather than inherited from the network above it.
 *
 * And it is dated. An amendment signed in June does not govern a fill in March, and the contract
 * that does govern March is the one the appeal has to quote.
 */

export type ClaimForMatch = {
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  dateFilled: string;
  daysSupply: number | null;
  /** What the plan actually paid, before the patient's share. */
  remitCents: number | null;
  /** The published list price for the quantity dispensed, where the claim carried one. */
  awpCents: number | null;
  /** What the drug cost the pharmacy. */
  acquisitionCents: number | null;
  isBrand: boolean | null;
};

export type ContractForMatch = {
  documentId: string;
  documentName: string;
  counterparty: string | null;
  bins: string[];
  pcns: string[];
  groupIds: string[];
  effectiveDate: string | null;
  endDate: string | null;
  rates: RateForMatch[];
};

export type RateForMatch = {
  network: string | null;
  daysSupplyMin: number | null;
  daysSupplyMax: number | null;
  brandFormula: string | null;
  brandDispensingFee: number | null;
  genericBasis: string | null;
  genericDispensingFee: number | null;
  citationQuote: string | null;
};

const norm = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim().toUpperCase();
  return t === "" ? null : t;
};

export type MatchWhy = { on: ("bin" | "pcn" | "group")[]; specificity: number; says: string };

/**
 * Whether this contract governs this claim, and how squarely.
 *
 * A contract that names BINs governs a claim on one of them unless it also names PCNs or groups
 * that the claim is not in — naming a narrower thing is a statement that the wider one is somebody
 * else's contract. Specificity counts how much of the triple was matched, so the plan-specific
 * agreement beats the network-wide one it sits under.
 */
export function governs(contract: ContractForMatch, claim: ClaimForMatch): MatchWhy | null {
  const bin = norm(claim.bin);
  const pcn = norm(claim.pcn);
  const group = norm(claim.groupNumber);

  const bins = new Set(contract.bins.map(norm).filter(Boolean) as string[]);
  const pcns = new Set(contract.pcns.map(norm).filter(Boolean) as string[]);
  const groups = new Set(contract.groupIds.map(norm).filter(Boolean) as string[]);

  // A contract that names nothing routable cannot be matched to a claim at all.
  if (bins.size === 0 && pcns.size === 0 && groups.size === 0) return null;

  const on: MatchWhy["on"] = [];
  if (bins.size > 0) {
    if (!bin || !bins.has(bin)) return null;
    on.push("bin");
  }
  if (pcns.size > 0) {
    if (!pcn || !pcns.has(pcn)) return null;
    on.push("pcn");
  }
  if (groups.size > 0) {
    if (!group || !groups.has(group)) return null;
    on.push("group");
  }

  // In force on the day it was dispensed, not on the day anybody looked.
  if (contract.effectiveDate && claim.dateFilled < contract.effectiveDate) return null;
  if (contract.endDate && claim.dateFilled > contract.endDate) return null;

  return {
    on,
    specificity: on.length,
    says: `matched on ${on.join(" and ")}`,
  };
}

/** The contract that governs this claim, most specific first, then the one that began most recently. */
export function contractFor(
  claim: ClaimForMatch,
  contracts: ContractForMatch[],
): { contract: ContractForMatch; why: MatchWhy } | null {
  const hits = contracts
    .map((c) => ({ contract: c, why: governs(c, claim) }))
    .filter((h): h is { contract: ContractForMatch; why: MatchWhy } => h.why !== null)
    .sort(
      (a, b) =>
        b.why.specificity - a.why.specificity ||
        (b.contract.effectiveDate ?? "").localeCompare(a.contract.effectiveDate ?? ""),
    );
  return hits[0] ?? null;
}

/**
 * The rate line inside a contract that covers this fill.
 *
 * One agreement carries several: a thirty-day retail rate and a ninety-day mail rate, a preferred
 * tier and a standard one. Chosen on the days supply, which is the band a claim actually states.
 * Where several fit, the narrowest band wins — a rate written for 1 to 34 days is about this fill
 * in a way that one written for any length is not.
 */
export function rateFor(contract: ContractForMatch, claim: ClaimForMatch): RateForMatch | null {
  const days = claim.daysSupply;
  const fits = contract.rates.filter((r) => {
    if (days === null) return r.daysSupplyMin === null && r.daysSupplyMax === null;
    if (r.daysSupplyMin !== null && days < r.daysSupplyMin) return false;
    if (r.daysSupplyMax !== null && days > r.daysSupplyMax) return false;
    return true;
  });
  const width = (r: RateForMatch) =>
    r.daysSupplyMin === null && r.daysSupplyMax === null ? Infinity : (r.daysSupplyMax ?? 999) - (r.daysSupplyMin ?? 0);
  return fits.sort((a, b) => width(a) - width(b))[0] ?? contract.rates.find((r) => r.daysSupplyMin === null && r.daysSupplyMax === null) ?? null;
}

export type Priced =
  | { ok: true; expectedCents: number; basis: string; feeCents: number; quote: string | null }
  | { ok: false; why: string; basis: string | null };

/**
 * What the contract says this claim should have paid.
 *
 * The formulas a contract actually writes are a discount off a published price plus a dispensing
 * fee: "AWP - 15.0%", "WAC + 3%", "AWP-17%". Those can be computed, because the claim carries the
 * published price for the quantity dispensed.
 *
 * MAC cannot be, and saying so is the point. A MAC rate is whatever the PBM's own list says that
 * week, the list is not published, and the appeal is precisely the argument about it. Returning a
 * guessed figure would create a shortfall that is not owed, and an appeal filed on it would be
 * withdrawn — worse than reporting nothing.
 */
export function priceFromRate(rate: RateForMatch, claim: ClaimForMatch): Priced {
  const brand = claim.isBrand === true;
  const basis = (brand ? rate.brandFormula : rate.genericBasis) ?? null;
  const feeDollars = (brand ? rate.brandDispensingFee : rate.genericDispensingFee) ?? null;
  const feeCents = feeDollars === null ? 0 : Math.round(feeDollars * 100);

  if (!basis) return { ok: false, why: "The contract states no rate for this kind of drug.", basis: null };

  const m = /(AWP|WAC)\s*([-+])\s*([\d.]+)\s*%/i.exec(basis);
  if (!m) {
    if (/\bMAC\b/i.test(basis)) {
      return {
        ok: false,
        basis,
        why: "Priced off the PBM's MAC list, which is not published — what this should have paid cannot be worked out from the contract alone. That argument is the appeal.",
      };
    }
    return { ok: false, basis, why: `The rate reads “${basis}”, which is not a discount off a published price.` };
  }

  if (claim.awpCents === null) {
    return { ok: false, basis, why: "The claim carries no published price for the quantity dispensed, so the discount has nothing to apply to." };
  }

  const off = Number(m[3]) / 100;
  const sign = m[2] === "-" ? -1 : 1;
  const ingredient = Math.round(claim.awpCents * (1 + sign * off));
  return { ok: true, expectedCents: ingredient + feeCents, basis, feeCents, quote: rate.citationQuote };
}

export type ClaimCheck = {
  matched: { documentName: string; counterparty: string | null; why: MatchWhy } | null;
  priced: Priced | null;
  /** What the plan paid less what the contract says it should have. Negative is a shortfall. */
  differenceCents: number | null;
};

/** One claim, against the contracts on file: what governs it, what it should have paid, and the gap. */
export function checkClaim(claim: ClaimForMatch, contracts: ContractForMatch[]): ClaimCheck {
  const hit = contractFor(claim, contracts);
  if (!hit) return { matched: null, priced: null, differenceCents: null };

  const rate = rateFor(hit.contract, claim);
  if (!rate) {
    return {
      matched: { documentName: hit.contract.documentName, counterparty: hit.contract.counterparty, why: hit.why },
      priced: { ok: false, why: "The contract carries no rate covering this days supply.", basis: null },
      differenceCents: null,
    };
  }

  const priced = priceFromRate(rate, claim);
  const matched = { documentName: hit.contract.documentName, counterparty: hit.contract.counterparty, why: hit.why };
  if (!priced.ok || claim.remitCents === null) return { matched, priced, differenceCents: null };
  return { matched, priced, differenceCents: claim.remitCents - priced.expectedCents };
}
