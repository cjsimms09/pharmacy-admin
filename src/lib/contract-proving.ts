/**
 * The proving document: a contract the site wrote itself, with an answer it knows.
 *
 * The reader is a request to a model, and the only way to know the request works today is to send
 * one and read the answer. Sending a real contract proves nothing about correctness, because
 * nobody has an independent answer for a real contract. This one is invented — a plan sponsor
 * that does not exist, a PBM that does not exist, identifiers that route nowhere — and every
 * figure in it is known, so the answer can be marked. It lives in `fixtures/contracts/` as a PDF
 * made from these pages by `scripts/make-proving-pdf.ts`, and the checks below say what a correct
 * read must contain. Run it before a paid run, and after any change to the prompt or the schema.
 */

export const PROVING_TITLE = "Provingtown Health Plan — Pharmacy Network Agreement (Exhibit B)";

/** The pages, as lines. The PDF is generated from these, so the text and the checks cannot drift apart. */
export const PROVING_PAGES: string[][] = [
  [
    "PROVINGTOWN HEALTH PLAN",
    "PHARMACY NETWORK AGREEMENT",
    "",
    "This Pharmacy Network Agreement (the Agreement) is entered into between",
    "Provingtown Health Plan, Inc. (the Plan) and the Pharmacy named on the signature page,",
    "and is administered on the Plan's behalf by Proving Benefit Managers LLC (the PBM).",
    "",
    "1. Term. This Agreement is effective January 1, 2026 and continues through December 31, 2026.",
    "It renews automatically for successive one-year terms unless either party gives written",
    "notice of non-renewal at least ninety (90) days before the end of the then-current term.",
    "",
    "2. Network. The Pharmacy participates in the Provingtown Preferred Network. Claims are",
    "identified by BIN 999123, PCN PRVTEST and Group PROVE1. This Exhibit governs only",
    "pharmacies with PSAO chain code 605 or 630.",
    "",
    "3. Pricing. Reimbursement for covered claims is set out in Exhibit B. All AWP references",
    "are to Medi-Span AWP as of the date of service.",
    "",
    "4. MAC appeals. The Pharmacy may appeal a MAC price within fourteen (14) days of the date of",
    "adjudication by submitting the claim number, NDC, date of service and a copy of the",
    "wholesaler invoice through the PBM's provider portal at https://appeals.proving.invalid.",
    "The PBM shall respond within seven (7) business days. An adjustment applies retroactively",
    "to the date of the appealed claim.",
  ],
  [
    "EXHIBIT B — REIMBURSEMENT SCHEDULE",
    "Effective January 1, 2026. This Exhibit B supersedes Exhibit B dated January 1, 2025.",
    "",
    "Provingtown Preferred Network, 1-34 day supply:",
    "Brand drugs: AWP minus 17.0% plus a dispensing fee of $1.50 per claim.",
    "Generic drugs: the lesser of MAC or AWP minus 45.0%, plus a dispensing fee of $2.00 per claim.",
    "",
    "Provingtown Preferred Network, 35-90 day supply:",
    "Brand drugs: AWP minus 18.0% plus a dispensing fee of $1.00 per claim.",
    "Generic drugs: the lesser of MAC or AWP minus 47.0%, plus a dispensing fee of $1.00 per claim.",
    "",
    "Generic Effective Rate. The PBM guarantees an aggregate Generic Effective Rate of AWP minus",
    "84.0% measured across all participating pharmacies over each calendar year and reconciled",
    "by the Plan by March 31 of the following year. This guarantee is not a per-claim rate.",
    "",
    "Network Performance Fee. A fee of 3.0% of ingredient cost is assessed each quarter on all",
    "claims where the Pharmacy's generic dispensing rate for the quarter is below 85%, and is",
    "collected by offset against the next remittance.",
    "",
    "Payment. The Plan pays clean claims by EFT twice monthly and provides an electronic",
    "remittance advice (835). EFT and ERA enrollment changes are made on the PBM's provider",
    "portal. Questions on payment go to payments@proving.invalid.",
    "",
    "Disputes. A remittance not disputed within sixty (60) days of the remittance date is deemed",
    "accepted.",
  ],
];

export const PROVING_TEXT = PROVING_PAGES.map((p) => p.join("\n")).join("\n\n");

export type ProvingCheck = { check: string; ok: boolean; got: string };

type Terms = {
  counterparty: string;
  documentRole: string;
  bins: string[];
  pcns: string[];
  groupIds: string[];
  chainCodes: string[];
  effectiveDate: string | null;
  endDate: string | null;
  terminationNoticeDays: number | null;
  rates: { network: string | null; daysSupplyMin: number | null; daysSupplyMax: number | null; brandFormula: string | null; brandDispensingFee: number | null; genericBasis: string | null; genericDispensingFee: number | null; citation: { quote: string } | null }[];
  effectiveRateGuarantees: { genericEffectiveRate: string | null }[];
  postPointOfSaleDiscounts: { calculation: string | null; collectionMethod: string | null }[];
  macAppealWindowDays: { value: number | null; citation: { quote: string } | null };
  macAppealWindowBasis: string | null;
  macAppealResponseDays: number | null;
  remittance: { paymentMethod: string | null; eraOffered: boolean | null } | null;
  disputeWindows: { days: number | null }[];
  supersedes: string[];
  pricingCompendium: { value: string | null };
};

const has = (s: string | null | undefined, re: RegExp) => !!s && re.test(s);

/**
 * What a correct read of the proving document must contain. Each check names one thing the
 * schema is for; a wrong one says exactly which part of the read to look at.
 */
export function checkProving(t: Terms, quoteInText: (q: string | null | undefined, text: string) => boolean | null): ProvingCheck[] {
  const out: ProvingCheck[] = [];
  const add = (check: string, ok: boolean, got: unknown) => out.push({ check, ok, got: typeof got === "string" ? got : JSON.stringify(got) });
  add("Counterparty is the Plan or its PBM", /proving/i.test(t.counterparty), t.counterparty);
  add("BIN 999123 read", t.bins.some((b) => b.replace(/\D/g, "") === "999123"), t.bins);
  add("PCN PRVTEST read", t.pcns.some((p) => /PRVTEST/i.test(p)), t.pcns);
  add("Group PROVE1 read", t.groupIds.some((g) => /PROVE1/i.test(g)), t.groupIds);
  add("Chain codes 605 and 630 read", ["605", "630"].every((c) => t.chainCodes.includes(c)), t.chainCodes);
  add("Effective 2026-01-01 and ends 2026-12-31", t.effectiveDate === "2026-01-01" && t.endDate === "2026-12-31", `${t.effectiveDate} → ${t.endDate}`);
  add("Ninety days' notice", t.terminationNoticeDays === 90, t.terminationNoticeDays);
  const short = t.rates.find((r) => (r.daysSupplyMax ?? 0) <= 34 || r.daysSupplyMax == null);
  const long = t.rates.find((r) => (r.daysSupplyMin ?? 0) >= 35);
  add("Two rate lines: 1-34 and 35-90 day supply", Boolean(short && long) && t.rates.length === 2, t.rates.map((r) => `${r.daysSupplyMin}-${r.daysSupplyMax}`));
  add("1-34 day brand: AWP minus 17% and a $1.50 fee", has(short?.brandFormula, /17/) && short?.brandDispensingFee === 1.5, `${short?.brandFormula} + ${short?.brandDispensingFee}`);
  add("1-34 day generic: lesser of MAC or AWP minus 45% and a $2.00 fee", has(short?.genericBasis, /45/) && has(short?.genericBasis, /mac/i) && has(short?.genericBasis, /less/i) && short?.genericDispensingFee === 2, `${short?.genericBasis} + ${short?.genericDispensingFee}`);
  add("35-90 day brand: AWP minus 18% and a $1.00 fee", has(long?.brandFormula, /18/) && long?.brandDispensingFee === 1, `${long?.brandFormula} + ${long?.brandDispensingFee}`);
  add("Every rate line carries a quote found in the document", t.rates.length > 0 && t.rates.every((r) => quoteInText(r.citation?.quote, PROVING_TEXT) === true), t.rates.map((r) => r.citation?.quote ?? "(none)"));
  add("The GER guarantee is a guarantee, not a rate", t.effectiveRateGuarantees.some((g) => has(g.genericEffectiveRate, /84/)) && !t.rates.some((r) => has(r.genericBasis, /84/) || has(r.brandFormula, /84/)), t.effectiveRateGuarantees.map((g) => g.genericEffectiveRate));
  add("The 3% network performance fee is money taken back, collected by offset", t.postPointOfSaleDiscounts.some((p) => has(p.calculation, /3/) && has(p.collectionMethod, /offset/i)), t.postPointOfSaleDiscounts);
  add("MAC appeal: 14 days from adjudication, answered in 7", t.macAppealWindowDays.value === 14 && /adjudication/.test(t.macAppealWindowBasis ?? "") && t.macAppealResponseDays === 7, `${t.macAppealWindowDays.value} from ${t.macAppealWindowBasis}, answered in ${t.macAppealResponseDays}`);
  add("The appeal window's quote is in the document", quoteInText(t.macAppealWindowDays.citation?.quote, PROVING_TEXT) === true, t.macAppealWindowDays.citation?.quote ?? "(none)");
  add("Paid by EFT with an 835", has(t.remittance?.paymentMethod, /eft/i) && t.remittance?.eraOffered === true, t.remittance);
  add("Remittance dispute window of 60 days", t.disputeWindows.some((d) => d.days === 60), t.disputeWindows.map((d) => d.days));
  add("Supersedes the 2025 Exhibit B", t.supersedes.some((s) => /2025/.test(s)), t.supersedes);
  add("Pricing compendium: Medi-Span as of the date of service", has(t.pricingCompendium.value, /medi-?span/i) && has(t.pricingCompendium.value, /date of service/i), t.pricingCompendium.value);
  return out;
}
