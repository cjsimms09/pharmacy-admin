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
  /**
   * Which PBM adjudicates under this rate. One agreement routinely carries different rates per
   * vendor — the Aetna Part D agreement pays AWP-15% + $1.00 on CVS/Caremark and AWP-16% + $0.75
   * on Express Scripts, in the same schedule. A rate without its vendor cannot price a claim.
   */
  pbmVendor: z.string().nullable(),
  /** Which network or plan this rate applies to, as the document names it. */
  network: z.string().nullable(),
  /** Preferred or standard cost sharing, where the schedule splits on it. */
  costSharingTier: z.enum(["preferred", "standard", "both", "unknown"]),
  /** Rates split by days supply — "Monthly (1-34 days)" against "Extended Day Supply (35+)". */
  daysSupplyMin: z.number().int().nullable(),
  daysSupplyMax: z.number().int().nullable(),
  /** Copy the formula as written: "AWP-15% + $1.00". */
  brandFormula: z.string().nullable(),
  brandDispensingFee: z.number().nullable(),
  /** Often a lesser-of inside the ingredient cost: "Lesser of (MAC or AWP-25%) + $1.00". */
  genericBasis: z.string().nullable(),
  genericDispensingFee: z.number().nullable(),
  specialtyTerms: z.string().nullable(),
  compoundTerms: z.string().nullable(),
  vaccineTerms: z.string().nullable(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  citation: Citation.nullable(),
});

/**
 * Effective rate guarantees — deliberately kept apart from RateTerm.
 *
 * These look like rates and are not. A Brand or Generic Effective Rate is an aggregate discount
 * measured across every pharmacy, network and PBM in the PSAO over a whole year, then reconciled
 * by the payer. The Aetna agreement guarantees a GER of AWP-84.5% to -92.3% while paying claims at
 * AWP-25%; reading the guarantee as a per-claim rate would understate expected reimbursement by an
 * order of magnitude and produce a schedule of nonsense.
 *
 * An individual pharmacy cannot verify these — it does not have the aggregate. They are recorded
 * so the annual reconciliation can be checked for arrival, not so a claim can be priced.
 */
export const EffectiveRateGuarantee = z.object({
  pbmVendor: z.string().nullable(),
  network: z.string().nullable(),
  costSharingTier: z.enum(["preferred", "standard", "both", "unknown"]),
  daysSupplyMin: z.number().int().nullable(),
  daysSupplyMax: z.number().int().nullable(),
  brandEffectiveRate: z.string().nullable(),
  genericEffectiveRate: z.string().nullable(),
  measurementBasis: z.string().nullable().describe("What it is aggregated across, and over what period."),
  reconciledBy: z.string().nullable().describe("Who calculates it, and by when."),
  citation: Citation.nullable(),
});

/** Money taken back after the claim paid — DIR by whatever name the contract gives it. */
export const PostPointOfSaleDiscount = z.object({
  name: z.string().nullable(),
  trigger: z.string().nullable().describe("What has to happen for it to apply, e.g. a generic dispensing rate threshold."),
  calculation: z.string().nullable(),
  collectionMethod: z.string().nullable().describe("How it is taken — offset against future payments, invoiced, or otherwise."),
  frequency: z.string().nullable(),
  appliesToPbmVendor: z.string().nullable(),
  citation: Citation.nullable(),
});

/** A clock the pharmacy or its PSAO is running against, and what happens when it expires. */
export const DisputeWindow = z.object({
  subject: z.string().describe("What can be disputed."),
  days: z.number().int().nullable(),
  runsFrom: z.string().nullable(),
  consequenceIfMissed: z.string().nullable().describe("Usually: deemed accepted."),
  escalation: z.string().nullable(),
  citation: Citation.nullable(),
});

/** A report the counterparty owes, and when. If one is not arriving, that is itself a finding. */
export const ReportOwed = z.object({
  name: z.string(),
  owedBy: z.string().nullable(),
  dueBy: z.string().nullable(),
  format: z.string().nullable(),
  granularity: z.string().nullable().describe("e.g. by NCPDP, by claim, aggregate only."),
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
  effectiveRateGuarantees: z.array(EffectiveRateGuarantee),
  postPointOfSaleDiscounts: z.array(PostPointOfSaleDiscount),
  disputeWindows: z.array(DisputeWindow),
  reportsOwed: z.array(ReportOwed),
  /**
   * Documents this one cannot be read without. A PSAO network agreement routinely delegates the
   * pricing formula, and the meaning of AWP, brand, generic and U&C, to a separate PBM contract.
   * Extracting the rate without knowing that is extracting half an answer.
   */
  incorporatesByReference: z.array(z.string()),
  definitionsDelegatedTo: z.string().nullable(),
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

6. **A document can carry several rates** — and the axes are not obvious. One Medicare Part D agreement carries different rates per **PBM vendor** (CVS/Caremark at AWP-15% + $1.00, Express Scripts at AWP-16% + $0.75, in the same schedule), per **network** (Premier, Standard, Value, Saver), per **cost sharing tier** (preferred against standard), and per **days supply band** (1-34 days against 35+). Return one entry per distinct combination. A rate without its vendor and network cannot price a claim.

7. **Never put an effective rate guarantee in the rates array.** This is the most damaging mistake available to you. A Brand or Generic Effective Rate (BER / GER) is an aggregate discount measured across every pharmacy, network and PBM in a PSAO over a year and reconciled annually by the payer — it is not what a claim pays. The same Aetna agreement pays generics at "Lesser of (MAC or AWP-25%) + $1.00" while guaranteeing a Generic Effective Rate of "AWP-84.5%". Both appear under headings about generic rates, one page apart. Putting the guarantee in "rates" would understate expected reimbursement by an order of magnitude and produce a schedule of nonsense that gets a filing thrown out. Effective rate guarantees go in "effectiveRateGuarantees", always.

8. **Capture what is taken back after the claim paid.** Post point-of-sale discounts, DIR, generic dispensing rate payments — whatever the contract calls them — go in "postPointOfSaleDiscounts" with how they are collected. Money withheld from a later payment cycle is why remittances do not reconcile to adjudicated amounts.

9. **Capture the clocks.** A dispute window with "deemed accepted" at the end of it is a deadline the pharmacy is running against whether or not it knows. Record every one, with what starts it and what happens if it is missed.

10. **Capture the reports owed.** If the counterparty must produce an annual reconciliation by a given date, at NCPDP level, that is something the pharmacy should be receiving — and its absence is itself a finding.

11. **Say what the document cannot answer on its own.** Many agreements delegate the pricing formula, and the meaning of AWP, brand, generic and usual & customary, to a separate PBM contract. Put those documents in "incorporatesByReference" and name where definitions live. An extraction that reports a rate while silently omitting that the lesser-of formula lives elsewhere is half an answer presented as a whole one.

12. **Be specific in unclearOrMissing.** "Generic rate for the Medicare Preferred network is referenced as Exhibit C but Exhibit C is not attached" is useful. "Some terms unclear" is not.

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
