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

/**
 * The published price for the quantity dispensed, worked out from the catalogue.
 *
 * The transaction report the pharmacy exports does not carry AWP. Its columns are Rx number,
 * status, amount, group, network reimbursement id, copay, total, date filled, BIN, quantity,
 * acquisition cost, PCN, NDC and gross profit — and without a published price, every rate written
 * as a discount off one is uncomputable. Not one claim of 1,590 could be priced.
 *
 * The supplier catalogues carry an AWP per package for 99% of the NDCs the claims dispense, so the
 * figure can be built: the pack's AWP over the units in the pack, times the quantity dispensed.
 *
 * ── What this figure is and is not ──
 *
 * A contract saying "AWP" means the compendium's AWP — Medi-Span or First Databank — on the day of
 * the fill. A wholesaler's catalogue AWP is a copy of that, and usually the same number, but it is
 * this week's copy rather than that day's and it is the wholesaler's transcription.
 *
 * So it is good enough to find the claims worth looking at and not good enough to file on. Every
 * figure derived this way says so, and an appeal quotes the compendium.
 */
export function awpForQuantity(a: {
  packAwpCents: number | null;
  packUnits: number | null;
  quantityThousandths: number | null;
}): number | null {
  if (a.packAwpCents === null || a.packUnits === null || a.packUnits <= 0) return null;
  if (a.quantityThousandths === null || a.quantityThousandths <= 0) return null;
  const perUnit = a.packAwpCents / a.packUnits;
  return Math.round((perUnit * a.quantityThousandths) / 1000);
}

export type ClaimForMatch = {
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  /**
   * The network reimbursement id PioneerRx prints on the claim, where it printed one.
   *
   * Present on 95.3% of this pharmacy's claims across 82 distinct values — a far better key than
   * the triple for the contracts that carry no triple at all.
   */
  networkId?: string | null;
  dateFilled: string;
  daysSupply: number | null;
  /** What the plan actually paid, before the patient's share. */
  remitCents: number | null;
  /** The published list price for the quantity dispensed, where one is known. */
  awpCents: number | null;
  /**
   * Where that price came from, because it changes what may be done with the answer.
   *
   * "claim" is the report's own figure. "catalogue" is derived from a wholesaler's AWP per pack —
   * enough to find an underpayment worth reading, not enough to file an appeal on.
   */
  awpSource?: "claim" | "catalogue" | null;
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
  /**
   * The network reimbursement ids (NCPDP 545-2F) the document states.
   *
   * The reason nothing matched. A rate exhibit routinely identifies itself by network name and
   * chain code with the BIN, PCN and group columns left empty — so `governs()`, which reads only
   * the triple, found nothing routable and returned null for every claim. The claims meanwhile
   * carry PioneerRx's network id on 95.3% of rows. This is the field that closes the gap, and it
   * is a code the PBM prints on both sides rather than a name anybody has to spell the same way.
   */
  networkReimbursementIds?: string[];
  effectiveDate: string | null;
  endDate: string | null;
  rates: RateForMatch[];
};

export type RateForMatch = {
  network: string | null;
  /**
   * The routing this rate line was printed against, where the schedule printed one.
   *
   * Empty means the line carries no routing of its own and the contract's lists stand for it. A
   * line that does carry routing is only about a claim that matches it — which is the whole reason
   * to keep it, since a document with a Commercial table and a Part D table is otherwise two
   * rates and no way to choose.
   */
  bins: string[];
  pcns: string[];
  groupIds: string[];
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

export type MatchWhy = {
  on: ("bin" | "pcn" | "group")[];
  specificity: number;
  says: string;
  /**
   * Whether this match is a fact or a guess.
   *
   * A contract that names only BINs governs every line of business on them — and a BIN routinely
   * carries several. On this pharmacy's claims, 67% sit on a BIN with more than one PCN: 610455
   * alone carries KSPDP, BCBSKS and KSPARTD, a Part D book and a commercial book on one number,
   * certainly on different rate schedules.
   *
   * So a BIN-only match against a BIN like that is not a fact about which contract applies. It is
   * the only candidate the file offers, which is a different thing, and it is said out loud rather
   * than priced as though it were settled.
   */
  confident: boolean;
  /** What makes it a guess, where it is one. */
  caution: string | null;
};

/** What the claims themselves say a BIN carries, which is how a BIN-only match is judged. */
export type BinShape = { pcns: number; groups: number };

/**
 * Whether this contract governs this claim, and how squarely.
 *
 * A contract that names BINs governs a claim on one of them unless it also names PCNs or groups
 * that the claim is not in — naming a narrower thing is a statement that the wider one is somebody
 * else's contract. Specificity counts how much of the triple was matched, so the plan-specific
 * agreement beats the network-wide one it sits under.
 */
export function governs(contract: ContractForMatch, claim: ClaimForMatch, binShape?: BinShape | null): MatchWhy | null {
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

  /*
   * A match on the BIN alone, where that BIN carries several lines of business, is a candidate
   * rather than an answer. Naming it is the whole point: a rate applied to the wrong book produces
   * a shortfall that looks real, and an appeal filed on it is withdrawn.
   */
  const binOnly = on.length === 1 && on[0] === "bin";
  const shared = binOnly && (binShape?.pcns ?? 1) > 1;
  return {
    on,
    specificity: on.length,
    says: `matched on ${on.join(" and ")}`,
    confident: !shared,
    caution: shared
      ? `This contract names only the BIN, and ${claim.bin} carries ${binShape?.pcns} lines of business on this pharmacy's claims. ` +
        `Which of them this contract was written for is not something the file says — confirm it before pricing on it.`
      : null,
  };
}

/* ── Which contract priced this claim, when the contract names no BIN at all ── */

/**
 * A network reimbursement id the owner has tied to a contract document.
 *
 * `payer_links.contract_id` holds the id PioneerRx prints and `payer_links.contract_doc_id` the
 * document it was priced under. The column pair was created for exactly this and nothing has ever
 * written the second one, which is why the link below is the rung that will actually carry most of
 * the traffic once the owner has been through the list.
 */
export type NetworkLink = {
  networkId: string;
  contractDocId: string;
  /** Who tied them, so the record says whose answer this is. */
  setBy?: string | null;
};

/** Where the answer came from. The order is the order of authority, not of convenience. */
export type MatchRung = "owner_link" | "network_id" | "routing";

export type ClaimResolution =
  | {
      matched: true;
      contract: ContractForMatch;
      rung: MatchRung;
      /** The triple's reasoning, where the triple is what answered. Null on the other two rungs. */
      why: MatchWhy | null;
      says: string;
      confident: boolean;
      caution: string | null;
    }
  | {
      matched: false;
      /** The id to offer the owner, where the claim carried one. */
      networkId: string | null;
      says: string;
      /** True where one choice on the payers page would settle this claim and every other on the id. */
      settleable: boolean;
    };

/** In force on the day of the fill, which every rung has to respect and only `governs` used to. */
function inForceOn(contract: ContractForMatch, dateFilled: string): boolean {
  if (contract.effectiveDate && dateFilled < contract.effectiveDate) return false;
  if (contract.endDate && dateFilled > contract.endDate) return false;
  return true;
}

/**
 * The contract that priced this claim, by the surest route available, or an honest "not known".
 *
 * Nought of 1,081 insured claims matched a contract, and the reason was structural rather than a
 * matter of reading more documents. Claims speak in codes — BIN on 99.8%, PCN on 94.4%, group on
 * 95.1%, PioneerRx's network id on 95.3% across 82 distinct values. Rate exhibits identify
 * themselves by network *name* ("Prime AccessOne Network") and chain code, with the BIN, PCN and
 * group columns empty. `governs()` reads only the triple, so it found nothing routable on those
 * documents and returned null every time. Both sides were complete; they were speaking different
 * languages.
 *
 * Three rungs, in descending order of how much anybody should trust them:
 *
 *   1. **The owner said so.** A `payer_links` row tying a network id to a document. A person who
 *      knows the pharmacy's contracts looked at the id and named the agreement. Nothing computed
 *      outranks that.
 *   2. **The document says so.** The contract states the network reimbursement id the claim carries.
 *      That is a code the PBM printed on both sides, not a name anybody had to spell the same way.
 *   3. **The routing.** BIN, PCN and group, exactly as before, most specific first.
 *
 * Measured across the first 86 of 325 contract documents read, rungs 2 and 3 are nearly empty: 63
 * carry network names, 39 carry chain codes, **5 carry BINs and 0 carry a network reimbursement
 * id**. So rung 1 is not a fallback for the awkward cases — it is the mechanism, and the other two
 * are there because a document that does state a code should never need a person. That is why the
 * unmatched answer below is built to be actionable rather than merely honest: it names the id, so
 * the payers page can offer one choice per id and 82 choices settle the file.
 *
 * And a fourth thing that is not a rung: **a name is never matched.** "Prime AccessOne Network" on
 * a rate exhibit and "PRIME THERAPEUTICS" on a claim are not evidence about each other, and a
 * similarity score between them is a wrong contract applied to a real claim — a shortfall that
 * looks real, an appeal that gets withdrawn. Where nothing resolves, this says so and names the id,
 * because 82 choices made once by somebody who knows is worth more than 1,081 guesses.
 *
 * Pure.
 */
export function resolveContract(a: {
  claim: ClaimForMatch;
  contracts: ContractForMatch[];
  /** Every link the owner has set. Ignored where it points at a document not on file. */
  links?: NetworkLink[];
  binShape?: BinShape | null;
}): ClaimResolution {
  const networkId = norm(a.claim.networkId);
  const byId = new Map(a.contracts.map((c) => [c.documentId, c]));

  /* ── 1. The owner said so ── */
  if (networkId) {
    const links = (a.links ?? []).filter((l) => norm(l.networkId) === networkId);
    const named = links.map((l) => byId.get(l.contractDocId)).filter((c): c is ContractForMatch => !!c);
    const live = named.filter((c) => inForceOn(c, a.claim.dateFilled));
    if (live.length === 1) {
      const who = links.find((l) => l.contractDocId === live[0].documentId)?.setBy;
      return {
        matched: true,
        contract: live[0],
        rung: "owner_link",
        why: null,
        says: `network ${networkId} is tied to ${live[0].documentName}${who ? ` by ${who}` : ""}`,
        confident: true,
        caution: null,
      };
    }
    /*
     * Two links disagreeing is a data problem, not a tie to break. Picking one would bury it.
     */
    if (live.length > 1) {
      return {
        matched: false,
        networkId,
        says:
          `Network ${networkId} is tied to ${live.length} different contracts in force on ${a.claim.dateFilled} — ` +
          `${live.map((c) => c.documentName).join(", ")}. One of those links is wrong; the payers page is where to settle it.`,
        settleable: true,
      };
    }
    if (named.length > 0) {
      return {
        matched: false,
        networkId,
        says:
          `Network ${networkId} is tied to ${named.map((c) => c.documentName).join(", ")}, but ${named.length === 1 ? "it was" : "none was"} ` +
          `in force on ${a.claim.dateFilled}. Either the fill predates the agreement or a newer one needs linking.`,
        settleable: true,
      };
    }
    if (links.length > 0) {
      return {
        matched: false,
        networkId,
        says: `Network ${networkId} is tied to a contract document that is no longer on file. Re-link it on the payers page.`,
        settleable: true,
      };
    }
  }

  /* ── 2. The document states the id ── */
  if (networkId) {
    const stating = a.contracts.filter(
      (c) => (c.networkReimbursementIds ?? []).map(norm).includes(networkId) && inForceOn(c, a.claim.dateFilled),
    );
    if (stating.length === 1) {
      return {
        matched: true,
        contract: stating[0],
        rung: "network_id",
        why: null,
        says: `${stating[0].documentName} states network reimbursement id ${networkId}`,
        confident: true,
        caution: null,
      };
    }
    if (stating.length > 1) {
      // Two documents claiming one id is contradictory paperwork; the owner picks, nothing guesses.
      return {
        matched: false,
        networkId,
        says:
          `${stating.length} contracts state network ${networkId} and were both in force on ${a.claim.dateFilled} — ` +
          `${stating.map((c) => c.documentName).join(", ")}. Choose which one prices this network on the payers page.`,
        settleable: true,
      };
    }
  }

  /* ── 3. The routing, exactly as before ── */
  const byRouting = contractFor(a.claim, a.contracts, a.binShape);
  if (byRouting) {
    return {
      matched: true,
      contract: byRouting.contract,
      rung: "routing",
      why: byRouting.why,
      says: byRouting.why.says,
      confident: byRouting.why.confident,
      caution: byRouting.why.caution,
    };
  }

  /* ── Nothing resolved, said in the words of the thing that would fix it ── */
  return {
    matched: false,
    networkId,
    says: networkId
      ? `No contract is tied to network ${networkId}, none states it, and its BIN, PCN and group match nothing on file. ` +
        `Tie it to a contract on the payers page and every claim on this network follows.`
      : `This claim carries no network id, and its BIN, PCN and group match no contract on file. ` +
        `Nothing here can be settled by linking; the contract for this routing has to be filed first.`,
    settleable: networkId !== null,
  };
}

/**
 * The documents worth offering for one network id, best guess first.
 *
 * This is the *only* place a name is allowed near this problem, and it is allowed because nothing
 * here decides anything: it orders a list for a person who knows the answer. The ordering is a
 * convenience and never a match — no caller may take the first entry as the contract. That
 * distinction is the whole reason the resolver refuses name similarity and this does not.
 *
 * Ordered by: the document's counterparty being the payer this network's BIN resolves to, then a
 * network name that contains the id, then everything else that was in force on the day, so the
 * short list is short. Documents not in force on the fill date are left out entirely — offering a
 * contract that cannot govern the claim is offering a wrong answer with a tick box beside it.
 *
 * Pure.
 */
export function candidatesFor(a: {
  networkId: string;
  /** Who the claim's BIN resolves to, where the site knows. Null where it does not. */
  payerName: string | null;
  /** Other names the same payer goes by on the BIN listing — "Prime Therapeutics" behind "Blue Cross Blue Shield", by the owner's word. */
  payerAliases?: string[];
  contracts: (ContractForMatch & { networkNames?: string[]; governsHere?: boolean | null })[];
  /** A date the candidate has to be in force on, where the caller has one. */
  on?: string | null;
}): { documentId: string; documentName: string; counterparty: string | null; networkNames: string[]; why: string }[] {
  const id = norm(a.networkId);
  const payer = norm(a.payerName);
  const payers = [payer, ...(a.payerAliases ?? []).map(norm)].filter((p): p is string => p !== null);
  const live = a.on ? a.contracts.filter((c) => inForceOn(c, a.on as string)) : a.contracts;

  return live
    .map((c) => {
      const names = (c.networkNames ?? []).filter(Boolean);
      const cp = norm(c.counterparty);
      const samePayer = cp !== null && payers.some((p) => cp.includes(p) || p.includes(cp));
      const namesId = id !== null && names.some((n) => norm(n)?.includes(id));
      // The document prints the id itself: 23 of the 177 read contracts list their network reimbursement ids, and three of those ids are on this pharmacy's claims.
      const printsId = id !== null && (c.networkReimbursementIds ?? []).some((n) => norm(n) === id);
      // Written for this pharmacy: the exhibit lists the chain code (605, 630, 841) or the NCPDP. The owner,
      // 8 September: "there's no way to deduce the network is our group from the contract??" — this is the way.
      const here = c.governsHere === true;
      const rank = printsId ? -1 : samePayer && here ? 0 : samePayer && namesId ? 1 : samePayer ? 2 : namesId ? 3 : here ? 4 : 5;
      return {
        documentId: c.documentId,
        documentName: c.documentName,
        counterparty: c.counterparty,
        networkNames: names,
        rank,
        why: printsId
          ? `this document prints ${a.networkId} as one of its network reimbursement ids`
          : samePayer && here
          ? `${c.counterparty} is who this network's BIN resolves to, and this document is written for this pharmacy's chain code`
          : samePayer
          ? `${c.counterparty} is who this network's BIN resolves to`
          : namesId
            ? `a network on this document is named for ${a.networkId}`
            : "in force on the day, nothing else connects it",
      };
    })
    .sort((x, y) => x.rank - y.rank || x.documentName.localeCompare(y.documentName))
    .map(({ rank: _rank, ...rest }) => rest);
}

/** The contract that governs this claim, most specific first, then the one that began most recently. */
export function contractFor(
  claim: ClaimForMatch,
  contracts: ContractForMatch[],
  binShape?: BinShape | null,
): { contract: ContractForMatch; why: MatchWhy } | null {
  const hits = contracts
    .map((c) => ({ contract: c, why: governs(c, claim, binShape) }))
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

  /*
   * Routing first, days supply second.
   *
   * One document routinely carries two rate tables for two books — a Commercial schedule and a
   * Part D schedule — printed with their own BINs and PCNs. Choosing between them on days supply
   * alone picks whichever the reader happened to list first, which is a coin toss on two-thirds of
   * this pharmacy's claims. Where a line names routing, it is about this claim only if the claim
   * matches it; where no line names routing, nothing is excluded and the old behaviour stands.
   */
  const routed = contract.rates.filter((r) => routes(r, claim) === true);
  const unrouted = contract.rates.filter((r) => routes(r, claim) === null);
  const pool = routed.length > 0 ? routed : unrouted.length > 0 ? unrouted : [];
  const fits = pool.filter((r) => {
    if (days === null) return r.daysSupplyMin === null && r.daysSupplyMax === null;
    if (r.daysSupplyMin !== null && days < r.daysSupplyMin) return false;
    if (r.daysSupplyMax !== null && days > r.daysSupplyMax) return false;
    return true;
  });
  const width = (r: RateForMatch) =>
    r.daysSupplyMin === null && r.daysSupplyMax === null ? Infinity : (r.daysSupplyMax ?? 999) - (r.daysSupplyMin ?? 0);
  return fits.sort((a, b) => width(a) - width(b))[0] ?? pool.find((r) => r.daysSupplyMin === null && r.daysSupplyMax === null) ?? null;
}

/**
 * Whether a rate line's own routing is about this claim.
 *
 * Three answers, not two: true where the line names routing the claim matches, false where it
 * names routing the claim does not, and null where it names none — which is not a mismatch, it is
 * a line that inherits the document's routing and applies to everything the document does.
 */
export function routes(rate: Pick<RateForMatch, "bins" | "pcns" | "groupIds">, claim: ClaimForMatch): boolean | null {
  const has = (xs: string[]) => xs.map(norm).filter((x): x is string => x !== null);
  const bins = has(rate.bins);
  const pcns = has(rate.pcns);
  const groups = has(rate.groupIds);
  if (bins.length === 0 && pcns.length === 0 && groups.length === 0) return null;
  if (bins.length > 0 && !(claim.bin && bins.includes(norm(claim.bin)!))) return false;
  if (pcns.length > 0 && !(claim.pcn && pcns.includes(norm(claim.pcn)!))) return false;
  if (groups.length > 0 && !(claim.groupNumber && groups.includes(norm(claim.groupNumber)!))) return false;
  return true;
}

export type Priced =
  | {
      ok: true;
      expectedCents: number;
      basis: string;
      feeCents: number;
      quote: string | null;
      /** Where the published price came from; a derived one finds candidates rather than settling them. */
      awpSource: "claim" | "catalogue";
    }
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
  return {
    ok: true,
    expectedCents: ingredient + feeCents,
    basis,
    feeCents,
    quote: rate.citationQuote,
    awpSource: claim.awpSource ?? "claim",
  };
}

export type ClaimCheck = {
  matched: { documentName: string; counterparty: string | null; why: MatchWhy } | null;
  priced: Priced | null;
  /** What the plan paid less what the contract says it should have. Negative is a shortfall. */
  differenceCents: number | null;
};

/** One claim, against the contracts on file: what governs it, what it should have paid, and the gap. */
export function checkClaim(claim: ClaimForMatch, contracts: ContractForMatch[], binShape?: BinShape | null): ClaimCheck {
  const hit = contractFor(claim, contracts, binShape);
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
