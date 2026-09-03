import "server-only";
import { z } from "zod";

/**
 * What we pull out of a payer or wholesaler agreement.
 *
 * Two rules shape this schema, and both exist because a wrong number here becomes a wrong appeal:
 *
 *  1. Every figure that decides money carries the contract's own words and where they were found.
 *     A rate without a quote is rejected rather than stored — see requireCitations below. An appeal
 *     filed on a number nobody can trace back to a sentence is not defensible.
 *
 *  2. Nothing is inferred. A term that is not stated comes back null. "Typical for this PBM" is
 *     how you end up arguing with Caremark about a rate that is in someone else's contract.
 */

export const Citation = z.object({
  quote: z.string().describe("The contract's own words, copied exactly. Never paraphrased."),
  page: z.number().int().nullable().describe("Page number if visible, else null."),
  section: z.string().nullable().describe("Section or exhibit reference, e.g. 'Exhibit B-11' or '4.2(a)'."),
});

const cited = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, citation: Citation.nullable() });

export const RateTerm = z.object({
  /** Which network or plan this rate applies to, as the document names it. */
  network: z.string().nullable(),
  /** Brand: usually "AWP - 15%" or similar. Copy the formula as written. */
  brandFormula: z.string().nullable(),
  brandDispensingFee: z.number().nullable(),
  /** Generic: MAC, NADAC-based, or an AWP discount. Copy as written. */
  genericBasis: z.string().nullable(),
  genericDispensingFee: z.number().nullable(),
  specialtyTerms: z.string().nullable(),
  compoundTerms: z.string().nullable(),
  vaccineTerms: z.string().nullable(),
  /** 90-day / extended day supply, where priced differently. */
  extendedDaySupplyTerms: z.string().nullable(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  citation: Citation.nullable(),
});

export const ContractTerms = z.object({
  // ── Identity ───────────────────────────────────────────────────────
  counterparty: z.string().describe("The PBM, payer or wholesaler, as named on the document."),
  documentTitle: z.string(),
  contractType: z.enum(["payer_network", "wholesaler", "psao", "unknown"]),
  /**
   * Where this document sits in its chain. A rate sheet supersedes the exhibit before it; the base
   * agreement rarely carries rates at all. Getting this wrong applies last year's price to this
   * year's claim.
   */
  documentRole: z.enum(["base", "amendment", "exhibit", "rate_sheet", "addendum", "manual", "notice", "unknown"]),
  parentAgreement: z.string().nullable().describe("Name of the agreement this attaches to, if it is not itself the base."),
  amendmentNumber: z.string().nullable(),
  supersedes: z.array(z.string()).describe("Documents or exhibits this one replaces, as named in it."),

  // ── Which claims it governs ────────────────────────────────────────
  // HMA publishes BINs only. PCNs, group IDs and chain codes are printed inside the exhibits,
  // so this is where the routing gaps get filled.
  bins: z.array(z.string()),
  pcns: z.array(z.string()),
  groupIds: z.array(z.string()),
  chainCodes: z.array(z.string()).describe("e.g. 605, 630. An exhibit only governs a pharmacy whose chain code is listed."),
  networkNames: z.array(z.string()),
  linesOfBusiness: z.array(z.string()).describe("Commercial, Medicare Part D, Medicaid, FEHB, and so on."),

  // ── Dates with clocks on them ──────────────────────────────────────
  effectiveDate: z.string().nullable(),
  endDate: z.string().nullable(),
  autoRenews: z.boolean().nullable(),
  terminationNoticeDays: z.number().int().nullable(),
  amendmentNoticeDays: z.number().int().nullable(),

  // ── Money ──────────────────────────────────────────────────────────
  rates: z.array(RateTerm),
  usualAndCustomaryDefinition: z.string().nullable(),
  dirFeeBasis: cited(z.string().nullable()),
  dirMeasurementPeriod: z.string().nullable(),

  // ── Appeals and audit — the operational half ───────────────────────
  macAppealWindowDays: cited(z.number().int().nullable()),
  macAppealWindowBasis: z.enum(["date_of_fill", "date_of_adjudication", "date_of_remittance", "unknown"]).nullable(),
  macAppealMethod: cited(z.string().nullable()),
  macAppealResponseDays: z.number().int().nullable(),
  macAppealRetroactive: z.boolean().nullable(),
  auditLookbackYears: z.number().int().nullable(),
  auditExtrapolationAllowed: z.boolean().nullable(),

  // ── Wholesaler only ────────────────────────────────────────────────
  gcrTiers: z.array(
    z.object({
      minPercent: z.number().nullable(),
      maxPercent: z.number().nullable(),
      rebatePercent: z.number().nullable(),
      citation: Citation.nullable(),
    }),
  ),
  gcrDefinition: cited(z.string().nullable()).describe("What counts in the numerator and denominator, and what is excluded."),
  primarySupplierRequirementPercent: z.number().nullable(),
  rebatePaymentTerms: z.string().nullable(),

  // ── Honesty about the read ─────────────────────────────────────────
  unclearOrMissing: z.array(z.string()).describe("What could not be read, or was not stated. Be specific."),
  confidence: z.number().min(0).max(1),
});

export type ContractTermsT = z.infer<typeof ContractTerms>;

export const EXTRACT_SYSTEM = `You read pharmacy contracts — PBM and payer network agreements, rate exhibits, amendments, and wholesaler supply agreements — and pull out the terms an independent pharmacy needs to check whether it was paid correctly.

What this is used for, so you understand the stakes: the pharmacy will compute what a claim should have paid from these terms and compare it to what it actually received. Where it was short-paid, it files a MAC appeal quoting your extraction. A number you invent becomes an appeal that gets rejected and costs them credibility with the payer.

RULES, in order of importance:

1. **Never infer a number.** If a rate, fee, window or date is not stated in this document, return null. Do not fill it from what is typical, from another PBM, or from an earlier version. A null is useful; a guess is dangerous.

2. **Cite every figure that decides money.** Rates, dispensing fees, GCR tiers, appeal windows, DIR terms — each carries the contract's own words in its quote field, copied exactly, with the page and section where you found them. Copy the sentence, not your summary of it.

3. **Read the whole document before answering.** Rates are often in an exhibit at the back, appeal windows in a general-provisions section, and effective dates on a signature page.

4. **Say where this document sits in its chain.** A rate sheet or amendment usually replaces something. Name what it supersedes exactly as the document names it. Base agreements often carry no rates at all — that is normal, return an empty rates array rather than hunting for something to put there.

5. **Capture the identifiers.** BINs, PCNs, group IDs, chain codes and network names are how a live claim gets matched back to this contract. They are frequently printed only inside a rate exhibit. Chain codes matter especially: an exhibit headed "Chain Codes 605 & 630" governs only pharmacies with one of those codes.

6. **A document can carry several rates** — different networks, lines of business, or effective periods. Return one entry per distinct rate set rather than blending them.

7. **Be specific in unclearOrMissing.** "Generic rate for the Medicare Preferred network is referenced as Exhibit C but Exhibit C is not attached" is useful. "Some terms unclear" is not.

Set confidence honestly. A clean, complete rate exhibit is 0.9+. A scan where half the table is illegible is 0.4, and you say which half.`;

/** Fields that may not be stored without the contract's own words behind them. */
export type CitationFailure = { field: string; value: string };

export function requireCitations(t: ContractTermsT): CitationFailure[] {
  const missing: CitationFailure[] = [];
  t.rates.forEach((r, i) => {
    const hasMoney = r.brandFormula || r.genericBasis || r.brandDispensingFee != null || r.genericDispensingFee != null;
    if (hasMoney && !r.citation?.quote?.trim()) {
      missing.push({ field: `rates[${i}]${r.network ? ` (${r.network})` : ""}`, value: r.brandFormula ?? r.genericBasis ?? "rate" });
    }
  });
  t.gcrTiers.forEach((g, i) => {
    if (g.rebatePercent != null && !g.citation?.quote?.trim()) {
      missing.push({ field: `gcrTiers[${i}]`, value: `${g.rebatePercent}%` });
    }
  });
  if (t.macAppealWindowDays.value != null && !t.macAppealWindowDays.citation?.quote?.trim()) {
    missing.push({ field: "macAppealWindowDays", value: String(t.macAppealWindowDays.value) });
  }
  if (t.dirFeeBasis.value && !t.dirFeeBasis.citation?.quote?.trim()) {
    missing.push({ field: "dirFeeBasis", value: t.dirFeeBasis.value });
  }
  return missing;
}
