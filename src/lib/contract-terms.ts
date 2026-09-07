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
 *  2. Nothing is inferred. A term that is not stated is left out. "Typical for this PBM" is how you
 *     end up arguing with Caremark about a rate that is in someone else's contract.
 *
 * ── Why every optional field is omitted rather than null ──
 *
 * A field that may have no value was written `.nullable()`, which compiles to a JSON Schema type of
 * `["string", "null"]` — a union. The API allows sixteen union-typed parameters in one schema and
 * this one had a hundred and four, so every contract read was refused outright before it began:
 *
 *   Schemas contains too many parameters with union types (104 parameters with type arrays or
 *   anyOf). This causes exponential compilation cost.
 *
 * `.optional()` says the same thing without a union: the field simply leaves the `required` list
 * and its type stays a single type. Nothing downstream changes, because a term that is missing and
 * a term that is null are the same fact, and every reader of these fields already asks with `?.`,
 * `??` or `!= null`, all three of which treat the two alike.
 *
 * Drafts read before this change carry explicit nulls, and `.optional()` rejects a null. They are
 * still drafts, so `parseTerms` drops nulls on the way in rather than throwing the read away.
 */

export const Citation = z.object({
  quote: z.string().describe("The contract's own words, copied exactly. Never paraphrased."),
  page: z.number().int().optional().describe("Page number if visible. Leave it out if not."),
  section: z.string().optional().describe("Section or exhibit reference, e.g. 'Exhibit B-11' or '4.2(a)'."),
});

const cited = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, citation: Citation.optional() });

export const RateTerm = z.object({
  /**
   * Which PBM adjudicates under this rate. One agreement routinely carries different rates per
   * vendor — the Aetna Part D agreement pays AWP-15% + $1.00 on CVS/Caremark and AWP-16% + $0.75
   * on Express Scripts, in the same schedule. A rate without its vendor cannot price a claim.
   */
  pbmVendor: z.string().optional(),
  /** Which network or plan this rate applies to, as the document names it. */
  network: z.string().optional(),
  /**
   * The line of business this line prices — Commercial, Medicare Part D, Medicaid, FEHB — as the
   * exhibit heading names it. One agreement carries several, and a Part D rate applied to a
   * commercial claim is a wrong appeal. Left out where the document prices one line only (null
   * on this side, like every other unstated term).
   */
  lineOfBusiness: z.string().optional(),
  /** Preferred or standard cost sharing, where the schedule splits on it. */
  costSharingTier: z.enum(["preferred", "standard", "both", "unknown"]),
  /** Rates split by days supply — "Monthly (1-34 days)" against "Extended Day Supply (35+)". */
  daysSupplyMin: z.number().int().optional(),
  daysSupplyMax: z.number().int().optional(),
  /** Copy the formula as written: "AWP-15% + $1.00". */
  brandFormula: z.string().optional(),
  brandDispensingFee: z.number().optional(),
  /** Often a lesser-of inside the ingredient cost: "Lesser of (MAC or AWP-25%) + $1.00". */
  genericBasis: z.string().optional(),
  genericDispensingFee: z.number().optional(),
  specialtyTerms: z.string().optional(),
  compoundTerms: z.string().optional(),
  vaccineTerms: z.string().optional(),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().optional(),
  citation: Citation.optional(),
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
  pbmVendor: z.string().optional(),
  network: z.string().optional(),
  costSharingTier: z.enum(["preferred", "standard", "both", "unknown"]),
  daysSupplyMin: z.number().int().optional(),
  daysSupplyMax: z.number().int().optional(),
  brandEffectiveRate: z.string().optional(),
  genericEffectiveRate: z.string().optional(),
  measurementBasis: z.string().optional().describe("What it is aggregated across, and over what period."),
  reconciledBy: z.string().optional().describe("Who calculates it, and by when."),
  citation: Citation.optional(),
});

/** Money taken back after the claim paid — DIR by whatever name the contract gives it. */
export const PostPointOfSaleDiscount = z.object({
  name: z.string().optional(),
  trigger: z.string().optional().describe("What has to happen for it to apply, e.g. a generic dispensing rate threshold."),
  calculation: z.string().optional(),
  collectionMethod: z.string().optional().describe("How it is taken — offset against future payments, invoiced, or otherwise."),
  frequency: z.string().optional(),
  appliesToPbmVendor: z.string().optional(),
  citation: Citation.optional(),
});

/** A clock the pharmacy or its PSAO is running against, and what happens when it expires. */
export const DisputeWindow = z.object({
  subject: z.string().describe("What can be disputed."),
  days: z.number().int().optional(),
  runsFrom: z.string().optional(),
  consequenceIfMissed: z.string().optional().describe("Usually: deemed accepted."),
  escalation: z.string().optional(),
  citation: Citation.optional(),
});

/** A report the counterparty owes, and when. If one is not arriving, that is itself a finding. */
export const ReportOwed = z.object({
  name: z.string(),
  owedBy: z.string().optional(),
  dueBy: z.string().optional(),
  format: z.string().optional(),
  granularity: z.string().optional().describe("e.g. by NCPDP, by claim, aggregate only."),
  citation: Citation.optional(),
});

/** A person or desk the contract names, and what they are for. */
export const ContractContact = z.object({
  purpose: z.enum(["mac_appeals", "provider_relations", "payment_or_eft", "audit", "notices", "credentialing", "other"]),
  name: z.string().optional(),
  organisation: z.string().optional(),
  phone: z.string().optional(),
  fax: z.string().optional(),
  email: z.string().optional(),
  portalUrl: z.string().optional(),
  postalAddress: z.string().optional(),
  citation: Citation.optional(),
});

/**
 * How the money and the remittance travel. A contract rarely says how to *change* the routing —
 * that is an enrollment form on the PBM's portal — but it does say who pays, how often, whether an
 * 835 is offered, and whom to ask, which is what a pharmacy needs to start the change.
 */
export const RemittanceTerms = z.object({
  paidBy: z.string().optional().describe("Who actually pays: the PBM, the plan sponsor, a PSAO, a facilitator."),
  paymentMethod: z.string().optional().describe("EFT, check, or as stated."),
  paymentCycle: z.string().optional().describe("e.g. twice monthly, within 30 days of adjudication."),
  eraOffered: z.boolean().optional().describe("Whether an electronic remittance (835) is provided."),
  enrollmentMethod: z.string().optional().describe("How EFT/ERA is set up or changed: a form, a portal, a clearinghouse."),
  remittanceContact: z.string().optional(),
  citation: Citation.optional(),
});

/** A fee the counterparty charges the pharmacy per claim or per transaction, by whatever name. */
export const TransactionFee = z.object({
  name: z.string(),
  amount: z.string().optional().describe("As written: \"$0.10 per claim\", \"2% of ingredient cost\"."),
  appliesTo: z.string().optional(),
  citation: Citation.optional(),
});

/** A defined term, in the document's own words, because "generic" and "AWP" mean what the contract says they mean. */
export const KeyDefinition = z.object({
  term: z.string(),
  definition: z.string(),
  citation: Citation.optional(),
});

/**
 * The document's own map: every section or exhibit, where it is and what it covers, in a line.
 * Kept so a question nobody has asked yet can be answered from the map and the indexed text
 * without reading the document again.
 */
export const SectionEntry = z.object({
  title: z.string(),
  pageFrom: z.number().int().optional(),
  pageTo: z.number().int().optional(),
  gist: z.string().describe("One sentence: what this section decides."),
});

/** A performance measure that moves money: what is measured, the threshold, and what it does to the payment. */
export const PerformanceMeasure = z.object({
  measure: z.string().describe("e.g. generic dispensing rate, adherence (PDC), formulary compliance."),
  threshold: z.string().optional(),
  effect: z.string().optional().describe("What meeting or missing it does: a DIR tier, a bonus, a penalty, as written."),
  period: z.string().optional(),
  citation: Citation.optional(),
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
  parentAgreement: z.string().optional().describe("Name of the agreement this attaches to, if it is not itself the base."),
  amendmentNumber: z.string().optional(),
  supersedes: z.array(z.string()).describe("Documents or exhibits this one replaces, as named in it."),

  // ── Which claims it governs ────────────────────────────────────────
  // HMA publishes BINs only. PCNs, group IDs and chain codes are printed inside the exhibits,
  // so this is where the routing gaps get filled.
  bins: z.array(z.string()),
  pcns: z.array(z.string()),
  groupIds: z.array(z.string()),
  chainCodes: z.array(z.string()).describe("e.g. 605, 630. An exhibit only governs a pharmacy whose chain code is listed."),
  networkNames: z.array(z.string()),
  /** NCPDP field 545-2F values printed in the document: the PBM's own name for a network on a claim. */
  networkReimbursementIds: z.array(z.string()),
  /** The pharmacy's own NCPDP and NPI numbers where the document names them, so the right pharmacy's contract is known to be the right one. */
  pharmacyNcpdps: z.array(z.string()),
  pharmacyNpis: z.array(z.string()),
  linesOfBusiness: z.array(z.string()).describe("Commercial, Medicare Part D, Medicaid, FEHB, and so on."),

  // ── Dates with clocks on them ──────────────────────────────────────
  effectiveDate: z.string().optional(),
  endDate: z.string().optional(),
  autoRenews: z.boolean().optional(),
  terminationNoticeDays: z.number().int().optional(),
  amendmentNoticeDays: z.number().int().optional(),
  /** How long after dispensing a claim may still be submitted, and reversed. */
  claimSubmissionWindowDays: z.number().int().optional(),
  reversalWindowDays: z.number().int().optional(),

  // ── Money ──────────────────────────────────────────────────────────
  rates: z.array(RateTerm),
  effectiveRateGuarantees: z.array(EffectiveRateGuarantee),
  postPointOfSaleDiscounts: z.array(PostPointOfSaleDiscount),
  disputeWindows: z.array(DisputeWindow),
  reportsOwed: z.array(ReportOwed),
  transactionFees: z.array(TransactionFee),
  /** Which AWP or WAC compendium prices the formula, and as of which date. Two "AWP-15%" contracts pay differently on this alone. */
  pricingCompendium: cited(z.string().optional()).describe("e.g. Medi-Span, First Databank, and the date basis: date of service, date of adjudication."),
  /** Where the MAC list is published, how often it changes, and whether it is available on request. */
  macListAccess: cited(z.string().optional()),
  performanceMeasures: z.array(PerformanceMeasure),
  /** Penalties for dispensing brand where a generic exists, and which DAW codes are honoured. */
  dawRules: cited(z.string().optional()),
  /** Days to pay a clean claim, and interest owed when late. */
  promptPayDays: z.number().int().optional(),
  latePaymentInterest: z.string().optional(),
  /** Whether money may be offset against future payments, and the notice owed first. */
  recoupmentTerms: cited(z.string().optional()),
  keyDefinitions: z.array(KeyDefinition).describe("Brand, generic, AWP, WAC, MAC, U&C, specialty, compound: each as this document defines it, where it does."),
  /**
   * Documents this one cannot be read without. A PSAO network agreement routinely delegates the
   * pricing formula, and the meaning of AWP, brand, generic and U&C, to a separate PBM contract.
   * Extracting the rate without knowing that is extracting half an answer.
   */
  incorporatesByReference: z.array(z.string()),
  definitionsDelegatedTo: z.string().optional(),
  usualAndCustomaryDefinition: z.string().optional(),
  dirFeeBasis: cited(z.string().optional()),
  dirMeasurementPeriod: z.string().optional(),

  // ── Appeals and audit — the operational half ───────────────────────
  macAppealWindowDays: cited(z.number().int().optional()),
  macAppealWindowBasis: z.enum(["date_of_fill", "date_of_adjudication", "date_of_remittance", "unknown"]).optional(),
  macAppealMethod: cited(z.string().optional()),
  macAppealResponseDays: z.number().int().optional(),
  macAppealRetroactive: z.boolean().optional(),
  macAppealRequiredFields: z.array(z.string()).describe("What an appeal must carry: claim number, NDC, invoice, date of service, and so on, as listed."),
  macAppealInvoiceRequired: z.boolean().optional(),
  macAppealSubmissionTarget: z.string().optional().describe("The address, portal or fax the appeal goes to, as written."),

  // ── People and payment ─────────────────────────────────────────────
  contacts: z.array(ContractContact),
  remittance: RemittanceTerms.optional(),
  auditLookbackYears: z.number().int().optional(),
  auditExtrapolationAllowed: z.boolean().optional(),

  // ── Wholesaler only ────────────────────────────────────────────────
  gcrTiers: z.array(
    z.object({
      minPercent: z.number().optional(),
      maxPercent: z.number().optional(),
      rebatePercent: z.number().optional(),
      citation: Citation.optional(),
    }),
  ),
  gcrDefinition: cited(z.string().optional()).describe("What counts in the numerator and denominator, and what is excluded."),
  primarySupplierRequirementPercent: z.number().optional(),
  rebatePaymentTerms: z.string().optional(),

  // ── The document's own map ─────────────────────────────────────────
  sections: z.array(SectionEntry),

  // ── Honesty about the read ─────────────────────────────────────────
  unclearOrMissing: z.array(z.string()).describe("What could not be read, or was not stated. Be specific."),
  confidence: z.number().min(0).max(1),
});

/**
 * The same schema, rewritten so nothing in it is optional.
 *
 * The API caps a schema at 16 union-typed parameters *and* at 24 optional ones. `.nullable()` broke
 * the first — a nullable field is a union — so every one of them became `.optional()`, which broke
 * the second: 0 unions, 111 optionals. Both caps exist for the same reason, that either shape makes
 * the response grammar expensive to compile, and this schema is large enough to hit whichever one
 * it is allowed to.
 *
 * So the wire schema has neither. Every field is required, and "the contract does not state this"
 * is carried by a value the type can hold:
 *
 *   a text field that may be absent   ->  "" for absent
 *   a number that may be absent       ->  the number written as text, "" for absent
 *   a yes/no that may be absent       ->  "yes" | "no" | "not stated"
 *   an object that may be absent      ->  the object, with its own fields empty
 *
 * It is derived from the schema above rather than written out, because a hundred and eleven fields
 * transcribed by hand is a hundred and eleven chances to describe a field one way on the wire and
 * read it another. `fromWire` walks the same original schema to turn the answer back into the nulls,
 * numbers and booleans the rest of the site is written against.
 */

const NOT_STATED = "not stated";

type Def = { type?: string; innerType?: z.ZodTypeAny; element?: z.ZodTypeAny; shape?: unknown };
const defOf = (t: z.ZodTypeAny): Def | undefined => (t as unknown as { _zod?: { def?: Def } })._zod?.def;
const shapeOf = (d: Def): Record<string, z.ZodTypeAny> | undefined =>
  (typeof d.shape === "function" ? (d.shape as () => Record<string, z.ZodTypeAny>)() : d.shape) as
    | Record<string, z.ZodTypeAny>
    | undefined;

/** The schema with every field required, absence carried by a value. */
export function toWire(schema: z.ZodTypeAny): z.ZodTypeAny {
  const d = defOf(schema);
  if (!d) return schema;

  if (d.type === "optional" || d.type === "nullable") {
    const inner = d.innerType ? toWire(d.innerType) : z.string();
    const id = defOf(d.innerType ?? z.string());
    // A number or a yes/no cannot carry "absent" in its own type, so each gets one that can.
    if (id?.type === "number") return z.string();
    if (id?.type === "boolean") return z.enum(["yes", "no", NOT_STATED]);
    return inner;
  }
  if (d.type === "object") {
    const shape = shapeOf(d);
    if (!shape) return schema;
    return z.object(Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, toWire(v)])));
  }
  if (d.type === "array") return d.element ? z.array(toWire(d.element)) : schema;
  return schema;
}

/** The answer turned back into what the rest of the site reads: nulls, numbers and booleans. */
export function fromWire(schema: z.ZodTypeAny, value: unknown): unknown {
  const d = defOf(schema);
  if (!d) return value;

  if (d.type === "optional" || d.type === "nullable") {
    const id = defOf(d.innerType ?? z.string());
    if (value === undefined || value === null || value === "" || value === NOT_STATED) return null;
    if (id?.type === "number") {
      const n = Number(String(value).replace(/[$,\s]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    if (id?.type === "boolean") return value === "yes" ? true : value === "no" ? false : null;
    return d.innerType ? fromWire(d.innerType, value) : value;
  }
  if (d.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const shape = shapeOf(d);
    if (!shape) return value;
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = { ...src };
    for (const [k, child] of Object.entries(shape)) out[k] = fromWire(child, src[k]);
    return out;
  }
  if (d.type === "array") {
    if (!Array.isArray(value)) return value;
    return d.element ? value.map((v) => fromWire(d.element as z.ZodTypeAny, v)) : value;
  }
  return value;
}

/** The shape the answer must take. Described to the model rather than compiled into a grammar. */
export const ContractTermsWire = toWire(ContractTerms);

/**
 * Why the shape is described in words instead of enforced as a grammar.
 *
 * Structured outputs compile the schema into a grammar the model must generate against, and this
 * schema is too big for one: 61 top-level fields, 175 leaves, 24 arrays, 14KB of JSON Schema. The
 * API refused it three times over, once for each way of being too much —
 *
 *   104 union-typed parameters (limit 16)
 *   111 optional parameters    (limit 24)
 *   the compiled grammar is too large
 *
 * — and the third has no restructuring that answers it. A contract genuinely has this many terms in
 * it, and dropping half of them to fit would be losing the reason the read exists.
 *
 * So the schema goes in the prompt and the answer is validated here, strictly, against the very same
 * schema. What is lost is the guarantee that the answer parses first time; what is kept is every
 * term, one request per document, and a check that is if anything harsher than the grammar's —
 * a wrong shape is refused outright and the document is left to be read again.
 */
export function shapeForPrompt(): string {
  const described = (t: z.ZodTypeAny, indent: string): string => {
    const d = defOf(t);
    if (!d) return "string";
    if (d.type === "object") {
      const shape = shapeOf(d);
      if (!shape) return "object";
      const inner = Object.entries(shape)
        .map(([k, v]) => `${indent}  "${k}": ${described(v, `${indent}  `)}`)
        .join(",\n");
      return `{\n${inner}\n${indent}}`;
    }
    if (d.type === "array") return `[ ${d.element ? described(d.element, indent) : "string"} ]`;
    if (d.type === "enum") {
      const values = (d as unknown as { entries?: Record<string, string>; options?: string[] }).options
        ?? Object.values((d as unknown as { entries?: Record<string, string> }).entries ?? {});
      return values.length ? values.map((v) => JSON.stringify(v)).join(" | ") : "string";
    }
    if (d.type === "number") return "number";
    if (d.type === "boolean") return "true | false";
    return "string";
  };
  return described(ContractTermsWire, "");
}

/**
 * A term the contract does not state, as the rest of the site sees it: null, never missing.
 *
 * The schema sent to the API uses `.optional()` rather than `.nullable()` because a nullable field
 * is a union in JSON Schema and the API allows sixteen of those (see the note at the top). But
 * "absent" is an awkward thing for a hundred call sites to read, and every one of them was written
 * against nulls. So the wire says absent and the site says null, and `fillNulls` is the one place
 * that turns one into the other.
 */
type Nulled<T> = T extends (infer U)[]
  ? Nulled<U>[]
  : T extends object
    ? { [K in keyof T]-?: Nulled<Exclude<T[K], undefined>> | (undefined extends T[K] ? null : never) }
    : T;

export type ContractTermsT = Nulled<z.infer<typeof ContractTerms>>;

/**
 * Puts a null in every optional field the model left out, at any depth.
 *
 * Driven by the schema rather than by the value, so a field the document never mentioned is present
 * and null rather than simply missing — which is what makes `Nulled` above a description of the
 * object and not a hopeful cast. A key the schema does not know about is left as it is: an older
 * draft carrying a field since renamed is still the pharmacy's read of its own contract.
 */
export function fillNulls<T extends z.ZodTypeAny>(schema: T, value: unknown): unknown {
  const def = (schema as unknown as { _zod?: { def?: Record<string, unknown> } })._zod?.def as
    | { type?: string; shape?: unknown; innerType?: z.ZodTypeAny; element?: z.ZodTypeAny }
    | undefined;
  if (!def) return value;

  if (def.type === "optional" || def.type === "nullable") {
    if (value === undefined || value === null) return null;
    return def.innerType ? fillNulls(def.innerType, value) : value;
  }
  if (def.type === "array") {
    if (!Array.isArray(value)) return value;
    return def.element ? value.map((v) => fillNulls(def.element as z.ZodTypeAny, v)) : value;
  }
  if (def.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const shape = (typeof def.shape === "function" ? (def.shape as () => Record<string, z.ZodTypeAny>)() : def.shape) as
      | Record<string, z.ZodTypeAny>
      | undefined;
    if (!shape) return value;
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [k, child] of Object.entries(shape)) out[k] = fillNulls(child, out[k]);
    return out;
  }
  return value;
}

export const EXTRACT_SYSTEM = `You read pharmacy contracts — PBM and payer network agreements, rate exhibits, amendments, and wholesaler supply agreements — and pull out the terms an independent pharmacy needs to check whether it was paid correctly.

What this is used for, so you understand the stakes: the pharmacy will compute what a claim should have paid from these terms and compare it to what it actually received. Where it was short-paid, it files a MAC appeal quoting your extraction. A number you invent becomes an appeal that gets rejected and costs them credibility with the payer.

RULES, in order of importance:

1. **Never infer a number.** If a rate, fee, window or date is not stated in this document, give the empty string "" for it — and "not stated" where the field offers that. Every field is required, so answer every one; "" is the answer meaning the document does not say. Numbers are written as text: "180", or "" where there is none. Do not fill a figure from what is typical, from another PBM, or from an earlier version. An empty answer is useful; a guess is dangerous.

2. **Cite every figure that decides money.** Rates, dispensing fees, GCR tiers, appeal windows, DIR terms — each carries the contract's own words in its quote field, copied exactly, with the page and section where you found them. Copy the sentence, not your summary of it.

3. **Read the whole document before answering.** Rates are often in an exhibit at the back, appeal windows in a general-provisions section, and effective dates on a signature page.

4. **Say where this document sits in its chain.** A rate sheet or amendment usually replaces something. Name what it supersedes exactly as the document names it. Base agreements often carry no rates at all — that is normal, return an empty rates array rather than hunting for something to put there.

5. **Capture the identifiers.** BINs, PCNs, group IDs, chain codes and network names are how a live claim gets matched back to this contract. They are frequently printed only inside a rate exhibit. Chain codes matter especially: an exhibit headed "Chain Codes 605 & 630" governs only pharmacies with one of those codes.

6. **A document can carry several rates** — and the axes are not obvious. One Medicare Part D agreement carries different rates per **PBM vendor** (CVS/Caremark at AWP-15% + $1.00, Express Scripts at AWP-16% + $0.75, in the same schedule), per **line of business** (Commercial, Medicare Part D, Medicaid, FEHB — name it on each rate line where the document prices more than one), per **network** (Premier, Standard, Value, Saver), per **cost sharing tier** (preferred against standard), and per **days supply band** (1-34 days against 35+). Return one entry per distinct combination, with its own effective dates where the exhibit gives them. A rate without its vendor, line and network cannot price a claim.

7. **Never put an effective rate guarantee in the rates array.** This is the most damaging mistake available to you. A Brand or Generic Effective Rate (BER / GER) is an aggregate discount measured across every pharmacy, network and PBM in a PSAO over a year and reconciled annually by the payer — it is not what a claim pays. The same Aetna agreement pays generics at "Lesser of (MAC or AWP-25%) + $1.00" while guaranteeing a Generic Effective Rate of "AWP-84.5%". Both appear under headings about generic rates, one page apart. Putting the guarantee in "rates" would understate expected reimbursement by an order of magnitude and produce a schedule of nonsense that gets a filing thrown out. Effective rate guarantees go in "effectiveRateGuarantees", always.

8. **Capture what is taken back after the claim paid.** Post point-of-sale discounts, DIR, generic dispensing rate payments — whatever the contract calls them — go in "postPointOfSaleDiscounts" with how they are collected. Money withheld from a later payment cycle is why remittances do not reconcile to adjudicated amounts.

9. **Capture the clocks.** A dispute window with "deemed accepted" at the end of it is a deadline the pharmacy is running against whether or not it knows. Record every one, with what starts it and what happens if it is missed.

10. **Capture the reports owed.** If the counterparty must produce an annual reconciliation by a given date, at NCPDP level, that is something the pharmacy should be receiving — and its absence is itself a finding.

11. **Say what the document cannot answer on its own.** Many agreements delegate the pricing formula, and the meaning of AWP, brand, generic and usual & customary, to a separate PBM contract. Put those documents in "incorporatesByReference" and name where definitions live. An extraction that reports a rate while silently omitting that the lesser-of formula lives elsewhere is half an answer presented as a whole one.

12. **Capture the people and the payment path.** Every contact the document names — an appeals desk, provider relations, an EFT/ERA enrollment address, an audit contact, where notices go — with its purpose. And how the money travels: who pays, by what method, on what cycle, whether an 835 remittance is offered, and how enrollment is changed. An appeal cannot be sent and a remittance cannot be re-routed without these.

13. **Map the document.** List every section, exhibit and schedule with its pages and one sentence on what it decides. This read happens once; the map is how a question nobody has asked yet is answered from the document without reading it again.

14. **Capture what moves the money after the formula.** The pricing compendium and its date basis; where the MAC list is published and how often it changes; every performance measure with its threshold and its effect on DIR, bonus or penalty; DAW and brand penalties; days to pay a clean claim and interest when late; and recoupment and offset rights with the notice owed.

15. **Capture the identifiers the claims will carry and the definitions the money rests on.** Network reimbursement ids (NCPDP 545-2F) printed in the exhibits; the pharmacy's own NCPDP and NPI where the document names them; every per-claim or per-transaction fee; and each defined term — brand, generic, AWP, WAC, MAC, U&C, specialty, compound — as this document defines it, with the sentence. Claim submission and reversal windows go with the other clocks.

16. **Be specific in unclearOrMissing.** "Generic rate for the Medicare Preferred network is referenced as Exhibit C but Exhibit C is not attached" is useful. "Some terms unclear" is not.

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

/** Explicit nulls dropped at every depth: `.optional()` rejects a null, and old drafts are full of them. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== null) out[k] = withoutNulls(v);
    return out;
  }
  return value;
}

/**
 * A stored draft, or a fresh answer, as terms.
 *
 * Fields added to the schema after a document was read are absent from its draft; an old draft
 * is still a draft, not a failure, so the additions default to "not stated". Nulls are dropped on
 * the way in (drafts read before `.optional()` carry them) and put back by `fillNulls` on the way
 * out, so the site never sees a missing key.
 */
export function termsFromObject(raw: Record<string, unknown>): ContractTermsT {
  const clean = withoutNulls(raw) as Record<string, unknown>;
  const parsed = ContractTerms.parse({
    macAppealRequiredFields: [], contacts: [],
    networkReimbursementIds: [], pharmacyNcpdps: [], pharmacyNpis: [],
    transactionFees: [], keyDefinitions: [], sections: [],
    pricingCompendium: {}, macListAccess: {}, performanceMeasures: [],
    dawRules: {},
    recoupmentTerms: {},
    ...clean,
  });
  return fillNulls(ContractTerms, parsed) as ContractTermsT;
}

/**
 * The model's answer as terms, or a thrown reason.
 *
 * The answer is asked for in the wire shape (`ContractTermsWire`: every field required, "" and
 * "not stated" for what the document does not say) and read back through `fromWire`; an answer
 * in the readable shape — an older batch, the proving read, a draft — parses through
 * `termsFromObject` instead. The object is found between the first brace and the last, so a
 * fence or a line of preamble does not fail a paid read.
 */
export function termsFromAnswer(text: string): ContractTermsT {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the answer");
  const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  const wire = ContractTermsWire.safeParse(raw);
  if (wire.success) return fillNulls(ContractTerms, fromWire(ContractTerms, wire.data)) as ContractTermsT;
  return termsFromObject(raw);
}
