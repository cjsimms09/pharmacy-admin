import "server-only";
import type { ContractTermsT } from "./contract-terms";

/**
 * Everything a read found that is not a rate, an appeal, a contact, a payment path or a plan link.
 *
 * Those five become rows on a payer page, because something acts on them. The rest had nowhere to
 * go: an audit of the schema against the site found twenty extracted fields — DIR, effective rate
 * guarantees, performance measures, prompt-pay clocks, recoupment rights, the pricing compendium,
 * every wholesaler term — that were read out of the document, stored, and displayed nowhere. Paying
 * to read a contract and then not showing what it said is the worst of both.
 *
 * So this is the rest of the document, grouped the way somebody would ask for it. It is display, not
 * inference: every line is a term the document stated, and a group with nothing in it is not shown.
 */

export type DigestLine = { label: string; value: string; quote?: string | null };
export type DigestGroup = { title: string; why: string; lines: DigestLine[] };

const text = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};
const yesNo = (b: boolean | null | undefined): string | null => (b == null ? null : b ? "yes" : "no");
const days = (n: number | null | undefined): string | null => (n == null ? null : `${n} day${n === 1 ? "" : "s"}`);
const join = (xs: (string | null | undefined)[], sep = " · "): string | null =>
  text(xs.map(text).filter(Boolean).join(sep));

/** A `cited(...)` field: its value with the sentence behind it. */
type Cited = { value: string | number | null; citation: { quote: string | null } | null } | null | undefined;
const citedLine = (label: string, c: Cited): DigestLine | null => {
  const v = c?.value == null ? null : text(String(c.value));
  return v ? { label, value: v, quote: c?.citation?.quote ?? null } : null;
};

export function digest(t: ContractTermsT): DigestGroup[] {
  const groups: DigestGroup[] = [];
  const group = (title: string, why: string, lines: (DigestLine | null)[]) => {
    const kept = lines.filter((l): l is DigestLine => l !== null);
    if (kept.length) groups.push({ title, why, lines: kept });
  };

  group("What this document is", "Which paper governs, and what it replaced. A rate sheet supersedes the exhibit before it.", [
    text(t.agreementNumber) ? { label: "Agreement number", value: t.agreementNumber! } : null,
    text(t.documentRole) ? { label: "Its place in the chain", value: join([t.documentRole?.replace(/_/g, " "), t.amendmentNumber && `amendment ${t.amendmentNumber}`, t.parentAgreement && `attaches to ${t.parentAgreement}`])! } : null,
    t.supersedes.length ? { label: "Supersedes", value: t.supersedes.join("; ") } : null,
    t.incorporatesByReference.length ? { label: "Cannot be read alone", value: t.incorporatesByReference.join("; ") } : null,
    text(t.definitionsDelegatedTo) ? { label: "Definitions live in", value: t.definitionsDelegatedTo! } : null,
  ]);

  group("Leaving, and staying", "Whether this can be ended, on whose notice, and whether one network can be left without the rest.", [
    yesNo(t.autoRenews) ? { label: "Renews itself", value: yesNo(t.autoRenews)! } : null,
    days(t.terminationNoticeDays) ? { label: "Notice to terminate", value: days(t.terminationNoticeDays)! } : null,
    days(t.amendmentNoticeDays) ? { label: "Notice before an amendment binds", value: days(t.amendmentNoticeDays)! } : null,
    citedLine("Who may terminate, and how", t.terminationRights),
    citedLine("All-products clause", t.allProductsClause),
  ]);

  group("What this pharmacy must tell them", "Clocks that run the other way. A missed notice is how a contract ends without anybody deciding to end it.", [
    ...t.noticesOwedByPharmacy.map((n) => ({
      label: n.subject,
      value: join([days(n.withinDays), n.method, n.consequenceIfMissed]) ?? "stated, no period given",
      quote: n.citation?.quote ?? null,
    })),
  ]);

  group("Money taken back after the claim paid", "DIR by whatever name. This is why a remittance does not reconcile to what was adjudicated.", [
    ...t.postPointOfSaleDiscounts.map((d) => ({
      label: text(d.name) ?? "Post point-of-sale discount",
      value: join([d.trigger, d.calculation, d.collectionMethod, d.frequency, d.appliesToPbmVendor && `on ${d.appliesToPbmVendor}`]) ?? "named, no terms given",
      quote: d.citation?.quote ?? null,
    })),
    citedLine("How the fee is calculated", t.dirFeeBasis),
    text(t.dirMeasurementPeriod) ? { label: "Measured over", value: t.dirMeasurementPeriod! } : null,
  ]);

  group("Performance that moves the money", "Thresholds that turn into a DIR tier, a bonus or a penalty.", [
    ...t.performanceMeasures.map((m) => ({
      label: m.measure,
      value: join([m.threshold, m.effect, m.period]) ?? "named, no threshold given",
      quote: m.citation?.quote ?? null,
    })),
  ]);

  group(
    "Effective rate guarantees",
    "Aggregate discounts reconciled annually across the whole PSAO — never what a claim pays. Kept so the reconciliation can be checked for arrival.",
    t.effectiveRateGuarantees.map((g) => ({
      label: join([g.pbmVendor, g.network, g.costSharingTier !== "unknown" && g.costSharingTier !== "both" ? g.costSharingTier : null]) ?? "All",
      value: join([g.brandEffectiveRate && `brand ${g.brandEffectiveRate}`, g.genericEffectiveRate && `generic ${g.genericEffectiveRate}`, g.measurementBasis, g.reconciledBy && `reconciled by ${g.reconciledBy}`]) ?? "stated, no figures given",
      quote: g.citation?.quote ?? null,
    })),
  );

  group("What the formula is measured against", "Two contracts both saying AWP-15% pay differently on these alone.", [
    citedLine("Pricing compendium", t.pricingCompendium),
    citedLine("Where the MAC list is published", t.macListAccess),
    citedLine("DAW and brand penalties", t.dawRules),
    text(t.usualAndCustomaryDefinition) ? { label: "Usual and customary, as defined here", value: t.usualAndCustomaryDefinition! } : null,
  ]);

  group("Getting paid, and getting it back", "How long they have, what late costs them, and what they may take back.", [
    days(t.promptPayDays) ? { label: "Days to pay a clean claim", value: days(t.promptPayDays)! } : null,
    text(t.latePaymentInterest) ? { label: "Interest when late", value: t.latePaymentInterest! } : null,
    citedLine("Recoupment and offset", t.recoupmentTerms),
    days(t.auditLookbackYears == null ? null : t.auditLookbackYears * 365) && t.auditLookbackYears != null
      ? { label: "Audit look-back", value: `${t.auditLookbackYears} year${t.auditLookbackYears === 1 ? "" : "s"}` }
      : null,
    yesNo(t.auditExtrapolationAllowed) ? { label: "Audit findings may be extrapolated", value: yesNo(t.auditExtrapolationAllowed)! } : null,
  ]);

  group("Clocks the pharmacy is running against", "Each one usually ends in “deemed accepted”, whether or not anybody noticed it started.", [
    ...t.disputeWindows.map((d) => ({
      label: d.subject,
      value: join([days(d.days), d.runsFrom && `from the ${d.runsFrom}`, d.consequenceIfMissed, d.escalation && `escalates to ${d.escalation}`]) ?? "stated, no period given",
      quote: d.citation?.quote ?? null,
    })),
    days(t.claimSubmissionWindowDays) ? { label: "Claim submission window", value: days(t.claimSubmissionWindowDays)! } : null,
    days(t.reversalWindowDays) ? { label: "Reversal window", value: days(t.reversalWindowDays)! } : null,
  ]);

  group("Reports they owe", "A report that is not arriving is itself a finding.", [
    ...t.reportsOwed.map((r) => ({
      label: r.name,
      value: join([r.owedBy && `from ${r.owedBy}`, r.dueBy, r.format, r.granularity]) ?? "named, no schedule given",
      quote: r.citation?.quote ?? null,
    })),
  ]);

  group("How the money will name itself", "An 835 identifies its payer by a name string and nothing else. These are the join.", [
    t.remittance?.payerNamesOnRemittance.length ? { label: "Names on the remittance", value: t.remittance.payerNamesOnRemittance.join("; ") } : null,
    t.remittance?.payerIdentifiers.length ? { label: "Payer identifiers", value: t.remittance.payerIdentifiers.join("; ") } : null,
    text(t.remittance?.enrollmentMethod) ? { label: "How EFT/ERA is set up or changed", value: t.remittance!.enrollmentMethod! } : null,
    text(t.remittance?.remittanceContact) ? { label: "Who to ask", value: t.remittance!.remittanceContact! } : null,
  ]);

  group("Per-claim fees", "Charged to the pharmacy on top of everything else.", [
    ...t.transactionFees.map((f) => ({ label: f.name, value: join([f.amount, f.appliesTo]) ?? "named, no amount given", quote: f.citation?.quote ?? null })),
  ]);

  group("Wholesaler terms", "Only a supply agreement carries these.", [
    ...t.gcrTiers.map((g) => ({
      label: `GCR ${g.minPercent ?? "—"}% to ${g.maxPercent ?? "—"}%`,
      value: g.rebatePercent == null ? "no rebate stated" : `${g.rebatePercent}% rebate`,
      quote: g.citation?.quote ?? null,
    })),
    citedLine("What counts in the GCR", t.gcrDefinition),
    t.primarySupplierRequirementPercent == null ? null : { label: "Primary supplier requirement", value: `${t.primarySupplierRequirementPercent}%` },
    text(t.rebatePaymentTerms) ? { label: "When the rebate is paid", value: t.rebatePaymentTerms! } : null,
  ]);

  group("Identifiers and definitions", "What a claim will carry, and what the words mean here.", [
    t.networkReimbursementIds.length ? { label: "Network reimbursement ids (545-2F)", value: t.networkReimbursementIds.join(", ") } : null,
    t.chainCodes.length ? { label: "Chain codes governed", value: t.chainCodes.join(", ") } : null,
    t.networkNames.length ? { label: "Networks named", value: t.networkNames.join(", ") } : null,
    t.pharmacyNcpdps.length ? { label: "Pharmacy NCPDP", value: t.pharmacyNcpdps.join(", ") } : null,
    t.pharmacyNpis.length ? { label: "Pharmacy NPI", value: t.pharmacyNpis.join(", ") } : null,
    ...t.keyDefinitions.map((d) => ({ label: `Defines “${d.term}”`, value: d.definition, quote: d.citation?.quote ?? null })),
  ]);

  return groups;
}
