import type { ContractTermsT } from "./contract-terms";

/**
 * A counterparty's file: everything its documents said, organised the way it is used.
 *
 * The reader keeps each document's answer whole, and the payer tables hold the four things a
 * claim needs (the rate, the appeal terms, the people, the payment path). Everything else the
 * documents carry — what is taken back after a claim pays, the clocks, the reports owed, the
 * fees, the measures that move DIR, the definitions the money rests on, the wholesaler's ladder —
 * was in the drafts and on no page. This puts it on one, per counterparty, each line naming the
 * document it came from and carrying the document's own sentence. Pure, so it is tested.
 */

export type Doc = { id: string; name: string; terms: ContractTermsT | null; state: string; fileName: string | null; pages: number | null };

type From = { doc: string; docId: string; quote: string | null; page: number | null; section: string | null };

export type Clock = {
  what: string;
  /** The day it falls, where it can be computed; else null with the rule in `rule`. */
  on: string | null;
  rule: string;
  consequence: string | null;
  from: From;
};

export type CounterpartyFile = {
  counterparty: string;
  documents: {
    id: string;
    name: string;
    role: string;
    title: string | null;
    effective: string | null;
    ends: string | null;
    supersedes: string[];
    parent: string | null;
    state: string;
    pages: number | null;
    confidence: number | null;
    linesOfBusiness: string[];
    rates: number;
    caveats: string[];
  }[];
  /** Every identifier any document printed, so a claim's BIN can be found here. */
  identifiers: { bins: string[]; pcns: string[]; groups: string[]; chainCodes: string[]; networkIds: string[]; networks: string[] };
  takenBack: { name: string | null; trigger: string | null; calculation: string | null; collection: string | null; frequency: string | null; vendor: string | null; from: From }[];
  clocks: Clock[];
  reportsOwed: { name: string; owedBy: string | null; dueBy: string | null; granularity: string | null; from: From }[];
  fees: { name: string; amount: string | null; appliesTo: string | null; from: From }[];
  measures: { measure: string; threshold: string | null; effect: string | null; period: string | null; from: From }[];
  moneyRules: { what: string; value: string; from: From }[];
  definitions: { term: string; definition: string; from: From }[];
  guarantees: { vendor: string | null; network: string | null; brand: string | null; generic: string | null; basis: string | null; reconciledBy: string | null; from: From }[];
  ladder: { tiers: { minPercent: number | null; maxPercent: number | null; rebatePercent: number | null; from: From }[]; definition: string | null; primaryRequirementPercent: number | null; paymentTerms: string | null } | null;
  unanswered: { doc: string; docId: string; what: string }[];
};

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.map((x) => (x ?? "").trim()).filter(Boolean))].sort();

export function counterpartyFile(counterparty: string, docs: Doc[]): CounterpartyFile {
  const from = (d: Doc, c: { quote: string; page: number | null; section: string | null } | null | undefined): From => ({ doc: d.name, docId: d.id, quote: c?.quote ?? null, page: c?.page ?? null, section: c?.section ?? null });
  const out: CounterpartyFile = {
    counterparty,
    documents: [],
    identifiers: { bins: [], pcns: [], groups: [], chainCodes: [], networkIds: [], networks: [] },
    takenBack: [],
    clocks: [],
    reportsOwed: [],
    fees: [],
    measures: [],
    moneyRules: [],
    definitions: [],
    guarantees: [],
    ladder: null,
    unanswered: [],
  };
  const ids = { bins: [] as string[], pcns: [] as string[], groups: [] as string[], chainCodes: [] as string[], networkIds: [] as string[], networks: [] as string[] };

  for (const d of docs) {
    const t = d.terms;
    out.documents.push({
      id: d.id,
      name: d.name,
      role: t?.documentRole ?? "unread",
      title: t?.documentTitle ?? null,
      effective: t?.effectiveDate ?? null,
      ends: t?.endDate ?? null,
      supersedes: t?.supersedes ?? [],
      parent: t?.parentAgreement ?? null,
      state: d.state,
      pages: d.pages,
      confidence: t?.confidence ?? null,
      linesOfBusiness: t?.linesOfBusiness ?? [],
      rates: t?.rates.length ?? 0,
      caveats: t?.unclearOrMissing ?? [],
    });
    if (!t) continue;
    ids.bins.push(...t.bins); ids.pcns.push(...t.pcns); ids.groups.push(...t.groupIds); ids.chainCodes.push(...t.chainCodes); ids.networkIds.push(...t.networkReimbursementIds); ids.networks.push(...t.networkNames);

    for (const p of t.postPointOfSaleDiscounts) {
      out.takenBack.push({ name: p.name, trigger: p.trigger, calculation: p.calculation, collection: p.collectionMethod, frequency: p.frequency, vendor: p.appliesToPbmVendor, from: from(d, p.citation) });
    }

    // ── The clocks: every deadline the documents set, with the day where it can be computed ──
    if (t.terminationNoticeDays != null) {
      const on = t.endDate ? addDays(t.endDate, -t.terminationNoticeDays) : null;
      out.clocks.push({ what: "Notice to terminate or not renew", on, rule: `${t.terminationNoticeDays} days before ${t.endDate ? `the end date ${t.endDate}` : "the term ends (end date not stated)"}${t.autoRenews ? "; renews on its own otherwise" : ""}`, consequence: t.autoRenews ? "The agreement renews for another term." : null, from: from(d, null) });
    }
    if (t.amendmentNoticeDays != null) {
      out.clocks.push({ what: "Notice the counterparty owes before an amendment takes effect", on: null, rule: `${t.amendmentNoticeDays} days`, consequence: "An amendment not objected to in time stands.", from: from(d, null) });
    }
    for (const w of t.disputeWindows) {
      out.clocks.push({ what: `Dispute: ${w.subject}`, on: null, rule: `${w.days != null ? `${w.days} days` : "no number stated"}${w.runsFrom ? ` from ${w.runsFrom}` : ""}${w.escalation ? `; escalate to ${w.escalation}` : ""}`, consequence: w.consequenceIfMissed, from: from(d, w.citation) });
    }
    if (t.macAppealWindowDays.value != null) {
      out.clocks.push({ what: "MAC appeal", on: null, rule: `${t.macAppealWindowDays.value} days${t.macAppealWindowBasis && t.macAppealWindowBasis !== "unknown" ? ` from ${t.macAppealWindowBasis.replace(/_/g, " ")}` : ""}${t.macAppealResponseDays != null ? `; they answer within ${t.macAppealResponseDays} days` : ""}`, consequence: "An appeal after the window is not heard.", from: from(d, t.macAppealWindowDays.citation) });
    }
    if (t.claimSubmissionWindowDays != null) out.clocks.push({ what: "Claim submission", on: null, rule: `${t.claimSubmissionWindowDays} days from dispensing`, consequence: "A claim submitted later is not paid.", from: from(d, null) });
    if (t.reversalWindowDays != null) out.clocks.push({ what: "Claim reversal", on: null, rule: `${t.reversalWindowDays} days from dispensing`, consequence: null, from: from(d, null) });
    if (t.promptPayDays != null) out.clocks.push({ what: "They pay a clean claim within", on: null, rule: `${t.promptPayDays} days${t.latePaymentInterest ? `; late interest ${t.latePaymentInterest}` : ""}`, consequence: null, from: from(d, null) });
    if (t.auditLookbackYears != null) out.clocks.push({ what: "Audit look-back", on: null, rule: `${t.auditLookbackYears} years${t.auditExtrapolationAllowed ? "; findings may be extrapolated" : t.auditExtrapolationAllowed === false ? "; no extrapolation" : ""}`, consequence: null, from: from(d, null) });

    for (const r of t.reportsOwed) out.reportsOwed.push({ name: r.name, owedBy: r.owedBy, dueBy: r.dueBy, granularity: r.granularity, from: from(d, r.citation) });
    for (const f of t.transactionFees) out.fees.push({ name: f.name, amount: f.amount, appliesTo: f.appliesTo, from: from(d, f.citation) });
    for (const m of t.performanceMeasures) out.measures.push({ measure: m.measure, threshold: m.threshold, effect: m.effect, period: m.period, from: from(d, m.citation) });

    const rule = (what: string, v: { value: string | null; citation: { quote: string; page: number | null; section: string | null } | null } | null | undefined) => {
      if (v?.value) out.moneyRules.push({ what, value: v.value, from: from(d, v.citation) });
    };
    rule("Pricing compendium and its date basis", t.pricingCompendium);
    rule("Where the MAC list is published", t.macListAccess);
    rule("DAW and brand penalties", t.dawRules);
    rule("Recoupment and offset", t.recoupmentTerms);
    rule("DIR fee basis", t.dirFeeBasis);
    if (t.dirMeasurementPeriod) out.moneyRules.push({ what: "DIR measurement period", value: t.dirMeasurementPeriod, from: from(d, null) });
    if (t.usualAndCustomaryDefinition) out.definitions.push({ term: "Usual and customary", definition: t.usualAndCustomaryDefinition, from: from(d, null) });
    for (const k of t.keyDefinitions) out.definitions.push({ term: k.term, definition: k.definition, from: from(d, k.citation) });
    for (const g of t.effectiveRateGuarantees) out.guarantees.push({ vendor: g.pbmVendor, network: g.network, brand: g.brandEffectiveRate, generic: g.genericEffectiveRate, basis: g.measurementBasis, reconciledBy: g.reconciledBy, from: from(d, g.citation) });

    if (t.gcrTiers.length > 0 || t.gcrDefinition.value || t.primarySupplierRequirementPercent != null) {
      const ladder = out.ladder ?? { tiers: [], definition: null, primaryRequirementPercent: null, paymentTerms: null };
      ladder.tiers.push(...t.gcrTiers.map((g) => ({ minPercent: g.minPercent, maxPercent: g.maxPercent, rebatePercent: g.rebatePercent, from: from(d, g.citation) })));
      ladder.definition = ladder.definition ?? t.gcrDefinition.value;
      ladder.primaryRequirementPercent = ladder.primaryRequirementPercent ?? t.primarySupplierRequirementPercent;
      ladder.paymentTerms = ladder.paymentTerms ?? t.rebatePaymentTerms;
      out.ladder = ladder;
    }

    for (const u of t.unclearOrMissing) out.unanswered.push({ doc: d.name, docId: d.id, what: u });
    if (t.incorporatesByReference.length) out.unanswered.push({ doc: d.name, docId: d.id, what: `Cannot be read alone: incorporates ${t.incorporatesByReference.join(", ")}.` });
    if (t.definitionsDelegatedTo) out.unanswered.push({ doc: d.name, docId: d.id, what: `Definitions live in ${t.definitionsDelegatedTo}.` });
  }

  out.identifiers = { bins: uniq(ids.bins), pcns: uniq(ids.pcns), groups: uniq(ids.groups), chainCodes: uniq(ids.chainCodes), networkIds: uniq(ids.networkIds), networks: uniq(ids.networks) };
  // Base first, then amendments and exhibits by effective date, so the chain reads top to bottom.
  const order: Record<string, number> = { base: 0, amendment: 1, addendum: 2, exhibit: 3, rate_sheet: 4, manual: 5, notice: 6, unknown: 7, unread: 8 };
  out.documents.sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || (a.effective ?? "").localeCompare(b.effective ?? "") || a.name.localeCompare(b.name));
  out.clocks.sort((a, b) => (a.on && b.on ? a.on.localeCompare(b.on) : a.on ? -1 : b.on ? 1 : a.what.localeCompare(b.what)));
  return out;
}

/** The clocks that fall within a window of days from today: what Today and the payer landing raise. */
export function clocksDue(file: CounterpartyFile, today: string, withinDays: number): Clock[] {
  const until = addDays(today, withinDays);
  return file.clocks.filter((c) => c.on && c.on >= today && c.on <= until);
}
