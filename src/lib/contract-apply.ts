/**
 * From a contract as read to the tables the site prices and appeals from.
 *
 * The extractor (`contract-extract.ts`) leaves each document as a draft: the terms, each with the
 * contract's own words beside it. Nothing about a draft is a fact until a person has looked at the
 * quote and agreed. This module is the step between: it turns a draft into *proposals*, one per
 * table row it would write, each carrying the quote and marked new, same or changed against what
 * the table already holds, so a page can show them as a checklist and a click writes the accepted
 * ones. It also proposes which of the pharmacy's own plans the document governs, from the BINs,
 * PCNs and groups printed in it, and says when a BIN is claimed by more than one document.
 *
 * ── The rules ──
 *
 * A rate proposal without a quote is not made (`requireCitations` already refuses to store it).
 * A plan match is proposed, never applied: the identifiers in an exhibit are facts, but which
 * document governs a claim when two exhibits share a BIN is a decision. A term that would change
 * a row already on file is shown as a change with both values, never silently overwritten.
 *
 * Pure. The page loads the draft, the tables and the plan register, and decides what to write.
 */

import type { ContractTermsT } from "./contract-terms";
import { matchScore } from "./payer-links";
import { parseFormula } from "./rate-formula";

export type Standing = "new" | "same" | "changed";

export type RateProposal = {
  kind: "rate";
  standing: Standing;
  row: {
    pbmName: string;
    sourceLabel: string;
    lineOfBusiness: string;
    network: string;
    /** The routing printed against this line, comma separated. Null where the line carries none. */
    bins: string | null;
    pcns: string | null;
    groupIds: string | null;
    effectiveDate: string | null;
    /** The last day it applies, where the exhibit says; null while it runs. */
    effectiveTo: string | null;
    daysSupply: string | null;
    brandRate: string | null;
    genericRate: string | null;
    /** The effective-rate guarantees that sit over this line, as words. Never used to price a claim. */
    berGuardrail: string | null;
    gerGuardrail: string | null;
    notes: string | null;
  };
  /** Whether the site can price a claim on it, and if not why. */
  readable: { brand: boolean; generic: boolean };
  quote: string | null;
  /**
   * Whether the quote appears in the document's own text: true, false, or null where the document
   * has no text of its own to check (a scan). A false is a figure the reader may have invented,
   * and it is never applied without a person looking.
   */
  quoteFound: boolean | null;
  existing?: Record<string, string | null>;
};

export type AppealProposal = {
  kind: "appeal";
  standing: Standing;
  row: {
    pbmName: string;
    sourceLabel: string;
    submissionChannel: string | null;
    submissionTarget: string | null;
    appealWindowDays: number | null;
    windowBasis: string | null;
    requiredFields: string | null;
    invoiceRequired: string | null;
    responseSlaDays: number | null;
    adjustmentRetroactive: string | null;
    escalationContact: string | null;
    notes: string | null;
  };
  quote: string | null;
  existing?: Record<string, string | number | null>;
};

export type ContactProposal = {
  kind: "contact";
  standing: Standing;
  row: { pbmName: string; sourceLabel: string; contactType: string; phone: string | null; email: string | null; portalUrl: string | null; notes: string | null };
  quote: string | null;
};

export type RoutingProposal = {
  kind: "routing";
  standing: Standing;
  row: { pbmName: string; sourceLabel: string; paysVia: string | null; paymentMethod: string | null; remittanceSource: string | null; paymentCycle: string | null; notes: string | null };
  quote: string | null;
  existing?: Record<string, string | null>;
};

export type PlanMatch = {
  /** The plan as the claims know it. */
  plan: { id: string; bin: string | null; groupNumber: string | null; pcn?: string | null; payerLabel: string | null; claims: number; networkIds?: string[] };
  /** Which identifiers in the document matched: the more, the surer. A network id is the PBM's own name for the contract. */
  matchedOn: ("bin" | "pcn" | "group" | "network")[];
  /** Other documents that also print this plan's BIN. The person picks. */
  contested: string[];
  proposedLink: { bin: string | null; pcn: string | null; groupNumber: string | null; contractId: string | null; pbmName: string; basis: string };
};

export type Proposals = {
  pbmName: string;
  sourceLabel: string;
  /**
   * Whether this document governs this pharmacy at all. An exhibit headed "Chain codes 605 & 630"
   * governs only pharmacies with one of those codes, and a document naming NCPDPs governs only
   * those. `ok` false is a document read correctly that does not apply here; null is unknown
   * because the pharmacy's own code is not in Settings yet.
   */
  governs: { ok: boolean | null; why: string | null };
  rates: RateProposal[];
  appeal: AppealProposal | null;
  contacts: ContactProposal[];
  routing: RoutingProposal | null;
  plans: PlanMatch[];
  /** What the document says it cannot answer alone, carried through so the checklist shows it. */
  caveats: string[];
};

export type Existing = {
  rates?: { pbmName: string; lineOfBusiness: string; network: string; bins?: string | null; daysSupply: string | null; brandRate: string | null; genericRate: string | null }[];
  appeal?: { pbmName: string; submissionChannel: string | null; submissionTarget: string | null; appealWindowDays: number | null; windowBasis: string | null } | null;
  contacts?: { pbmName: string; contactType: string; phone: string | null; email: string | null; portalUrl: string | null }[];
  routing?: { pbmName: string; paysVia: string | null; paymentMethod: string | null; remittanceSource: string | null; paymentCycle: string | null } | null;
  /** Every other document's identifiers, to find a BIN claimed twice. */
  otherDocuments?: { name: string; bins: string[] }[];
};

export type PlanForMatch = { id: string; bin: string | null; groupNumber: string | null; pcn?: string | null; payerLabel: string | null; claims: number; networkIds?: string[] };

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase() || null;
const same = (a: string | number | null | undefined, b: string | number | null | undefined) => (a ?? null) === (b ?? null);

function standingOf(existing: Record<string, string | number | null> | undefined, row: Record<string, string | number | null>, keys: string[]): Standing {
  if (!existing) return "new";
  return keys.every((k) => same(existing[k], row[k])) ? "same" : "changed";
}

/** The PBM a rate belongs to: the vendor named on the line, else the document's counterparty. */
function pbmOf(t: ContractTermsT, vendor: string | null, fallback: string): string {
  return (vendor ?? "").trim() || fallback;
}

export type Pharmacy = { chainCode: string | null; ncpdp: string | null; npi: string | null };

/**
 * Whether a quote appears in a document's own text.
 *
 * Both sides are reduced to lowercase letters and digits with single spaces, so a line break or a
 * curly quote in the PDF does not fail a sentence the reader copied faithfully. A long quote is
 * checked on its first sixty letters and its last sixty, because scanners and readers both lose
 * the middle of a table row before they lose its ends. Null where there is no text to check.
 */
export function quoteInText(quote: string | null | undefined, text: string | null | undefined): boolean | null {
  const fold = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // The site's own PDF reader runs lines together ("date ofadjudication"), so the check is also
  // made with every space removed: a quote is present if its letters are, in order.
  const tight = (x: string) => fold(x).replace(/ /g, "");
  if (!text || fold(text).length < 40) return null;
  const q = fold(quote ?? "");
  if (q.length < 12) return null;
  const t = fold(text);
  const tt = tight(text);
  const tq = tight(q);
  if (t.includes(q) || tt.includes(tq)) return true;
  if (q.length > 80) return t.includes(q.slice(0, 60)) || t.includes(q.slice(-60)) || tt.includes(tq.slice(0, 50)) || tt.includes(tq.slice(-50));
  return false;
}

/** Whether the document governs this pharmacy, from the chain codes and NCPDPs it names. */
/**
 * A chain code as one PBM prints it against the same code as another prints it.
 *
 * An independent pharmacy has no chain code of its own; the code on its contracts is its PSAO's.
 * This pharmacy's library is signed by Health Mart Atlas "as attorney-in-fact on behalf of its
 * participating pharmacies (Chain Code: 605, 630)", and the same PSAO appears as 841 at Capital
 * Rx and ESI, as A605 at Caremark, as 00605 and 00630 at Prime, as 0000630 at ESI. The letter and
 * the zeros are the PBM's formatting of one code, so comparison is on the digits with the leading
 * zeros gone. Settings holds every code the PSAO goes by, comma-separated.
 */
export function chainCodeKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return digits || null;
}

/** Every chain code the pharmacy answers to, from the comma- or space-separated setting. */
export function pharmacyChainCodes(setting: string | null | undefined): string[] {
  return (setting ?? "")
    .split(/[,;\s]+/)
    .map(chainCodeKey)
    .filter((c): c is string => c !== null);
}

export function governsPharmacy(t: ContractTermsT, pharmacy: Pharmacy | undefined): { ok: boolean | null; why: string | null } {
  const codes = t.chainCodes.map((c) => chainCodeKey(c)).filter((c): c is string => c !== null);
  const ncpdps = t.pharmacyNcpdps.map((c) => (c ?? "").replace(/\D/g, "")).filter(Boolean);
  if (ncpdps.length > 0) {
    const mine = (pharmacy?.ncpdp ?? "").replace(/\D/g, "");
    if (!mine) return { ok: null, why: `Names NCPDP ${ncpdps.join(", ")}; the pharmacy's NCPDP is not in Settings, so whether this is ours is not known.` };
    if (!ncpdps.includes(mine)) return { ok: false, why: `Names NCPDP ${ncpdps.join(", ")}, not this pharmacy's ${mine}.` };
  }
  if (codes.length > 0) {
    const mine = pharmacyChainCodes(pharmacy?.chainCode);
    if (mine.length === 0) return { ok: null, why: `Governs chain code${codes.length === 1 ? "" : "s"} ${codes.join(", ")}; the pharmacy's chain codes are not in Settings, so whether this applies is not known.` };
    if (!codes.some((c) => mine.includes(c))) return { ok: false, why: `Governs chain code${codes.length === 1 ? "" : "s"} ${codes.join(", ")}, not this pharmacy's ${mine.join(", ")}.` };
  }
  return { ok: true, why: null };
}

export function proposeFromContract(
  t: ContractTermsT,
  documentName: string,
  plans: PlanForMatch[],
  existing: Existing = {},
  opts: { pbmName?: string; pharmacy?: Pharmacy; text?: string | null } = {},
): Proposals {
  const sourceLabel = documentName;
  // The payer pages are keyed on one canonical name per PBM; the document's own spelling is kept in the rows' notes.
  const pbmName = opts.pbmName?.trim() || t.counterparty;
  const governs = governsPharmacy(t, opts.pharmacy);

  // ── Rates: one row per line of the schedule, priced only where the sentence reads ──
  const rates: RateProposal[] = [];
  for (const r of t.rates) {
    const hasMoney = r.brandFormula || r.genericBasis || r.brandDispensingFee != null || r.genericDispensingFee != null;
    if (!hasMoney || !r.citation?.quote?.trim()) continue;
    const fee = (f: number | null) => (f == null ? "" : ` + $${f.toFixed(2)}`);
    const brandRate = r.brandFormula ? `${r.brandFormula}${/\$/.test(r.brandFormula) ? "" : fee(r.brandDispensingFee)}` : null;
    const genericRate = r.genericBasis ? `${r.genericBasis}${/\$/.test(r.genericBasis) ? "" : fee(r.genericDispensingFee)}` : null;
    const daysSupply = r.daysSupplyMin != null || r.daysSupplyMax != null ? `${r.daysSupplyMin ?? 1}-${r.daysSupplyMax ?? ""}`.replace(/-$/, "+") : null;
    /*
     * The effective-rate guarantees that sit over this line — the same vendor and network, or the
     * document's only guarantee — kept as words beside the rate. They are aggregates the payer
     * reconciles yearly and never price a claim; they are here so the annual reconciliation can be
     * checked for arrival against the line it applies to.
     */
    const over = t.effectiveRateGuarantees.filter((g) => (g.pbmVendor == null || norm(g.pbmVendor) === norm(r.pbmVendor ?? t.counterparty)) && (g.network == null || norm(g.network) === norm(r.network)));
    const guard = over.length === 1 ? over[0] : over.find((g) => norm(g.network) === norm(r.network)) ?? null;
    /*
     * The book this line prices, and the routing it prices for.
     *
     * `linesOfBusiness[0]` used to stamp every rate in a document with whichever book was listed
     * first, so a document carrying a Commercial schedule and a Part D schedule filed both as
     * Commercial. The line's own book is used where the schedule states it; the document's is used
     * only where it states exactly one, and "unknown" is the honest answer to the rest.
     */
    const lineOfBusiness = r.lineOfBusiness?.trim() || (t.linesOfBusiness.length === 1 ? t.linesOfBusiness[0] : "unknown");
    const csv = (xs: string[]) => {
      const kept = [...new Set(xs.map((x) => x.trim().toUpperCase()).filter(Boolean))];
      return kept.length ? kept.join(", ") : null;
    };
    const row = {
      pbmName: pbmOf(t, r.pbmVendor, pbmName),
      sourceLabel,
      lineOfBusiness,
      network: [r.network, r.costSharingTier !== "unknown" && r.costSharingTier !== "both" ? r.costSharingTier : null].filter(Boolean).join(" · ") || "all",
      bins: csv(r.bins),
      pcns: csv(r.pcns),
      groupIds: csv(r.groupIds),
      networkIds: csv(r.networkIds ?? []),
      effectiveDate: r.effectiveFrom ?? t.effectiveDate ?? null,
      effectiveTo: r.effectiveTo ?? t.endDate ?? null,
      daysSupply,
      brandRate,
      genericRate,
      berGuardrail: guard?.brandEffectiveRate ?? null,
      gerGuardrail: guard?.genericEffectiveRate ?? null,
      notes: [r.specialtyTerms && `Specialty: ${r.specialtyTerms}`, r.compoundTerms && `Compounds: ${r.compoundTerms}`, r.vaccineTerms && `Vaccines: ${r.vaccineTerms}`].filter(Boolean).join(" ") || null,
    };
    const prior = existing.rates?.find(
      (e) =>
        norm(e.pbmName) === norm(row.pbmName) &&
        norm(e.network) === norm(row.network) &&
        norm(e.lineOfBusiness) === norm(row.lineOfBusiness) &&
        same(e.daysSupply, row.daysSupply) &&
        same(e.bins ?? null, row.bins),
    );
    rates.push({
      kind: "rate",
      standing: standingOf(prior as Record<string, string | null> | undefined, row, ["brandRate", "genericRate"]),
      row,
      readable: { brand: !brandRate || parseFormula(brandRate).kind === "priced", generic: !genericRate || parseFormula(genericRate).kind === "priced" },
      quote: r.citation?.quote ?? null,
      quoteFound: quoteInText(r.citation?.quote, opts.text),
      existing: prior ? { brandRate: prior.brandRate, genericRate: prior.genericRate } : undefined,
    });
  }

  // ── The appeal terms: one row per document, only where the document says something ──
  let appeal: AppealProposal | null = null;
  const windowDays = t.macAppealWindowDays.value;
  const method = t.macAppealMethod.value;
  if (windowDays != null || method || t.macAppealSubmissionTarget || t.macAppealRequiredFields.length > 0) {
    const appealsDesk = t.contacts.find((c) => c.purpose === "mac_appeals");
    const row = {
      pbmName,
      sourceLabel,
      submissionChannel: method ?? null,
      submissionTarget: t.macAppealSubmissionTarget ?? appealsDesk?.portalUrl ?? appealsDesk?.email ?? appealsDesk?.fax ?? null,
      appealWindowDays: windowDays ?? null,
      windowBasis: t.macAppealWindowBasis ?? null,
      requiredFields: t.macAppealRequiredFields.length ? t.macAppealRequiredFields.join("; ") : null,
      invoiceRequired: t.macAppealInvoiceRequired == null ? null : t.macAppealInvoiceRequired ? "yes" : "no",
      responseSlaDays: t.macAppealResponseDays ?? null,
      adjustmentRetroactive: t.macAppealRetroactive == null ? null : t.macAppealRetroactive ? "yes" : "no",
      escalationContact: t.disputeWindows.find((d) => /mac|appeal|pric/i.test(d.subject))?.escalation ?? null,
      notes: null,
    };
    const prior = existing.appeal && norm(existing.appeal.pbmName) === norm(pbmName) ? existing.appeal : undefined;
    appeal = {
      kind: "appeal",
      standing: standingOf(prior as Record<string, string | number | null> | undefined, row, ["submissionChannel", "submissionTarget", "appealWindowDays", "windowBasis"]),
      row,
      quote: t.macAppealWindowDays.citation?.quote ?? t.macAppealMethod.citation?.quote ?? null,
      existing: prior ? { submissionChannel: prior.submissionChannel, submissionTarget: prior.submissionTarget, appealWindowDays: prior.appealWindowDays, windowBasis: prior.windowBasis } : undefined,
    };
  }

  // ── Contacts, by purpose ──
  const contacts: ContactProposal[] = t.contacts.map((c) => {
    const row = {
      pbmName,
      sourceLabel,
      contactType: c.purpose,
      phone: c.phone ?? c.fax ?? null,
      email: c.email ?? null,
      portalUrl: c.portalUrl ?? null,
      notes: [c.name, c.organisation, c.postalAddress, c.fax ? `fax ${c.fax}` : null].filter(Boolean).join(" · ") || null,
    };
    const prior = existing.contacts?.find((e) => norm(e.pbmName) === norm(pbmName) && e.contactType === row.contactType);
    return { kind: "contact", standing: standingOf(prior as Record<string, string | null> | undefined, row, ["phone", "email", "portalUrl"]), row, quote: c.citation?.quote ?? null };
  });

  // ── How the money travels ──
  let routing: RoutingProposal | null = null;
  if (t.remittance && (t.remittance.paidBy || t.remittance.paymentMethod || t.remittance.paymentCycle || t.remittance.eraOffered != null)) {
    const r = t.remittance;
    const row = {
      pbmName,
      sourceLabel,
      paysVia: r.paidBy ?? null,
      paymentMethod: r.paymentMethod ?? null,
      remittanceSource: r.eraOffered == null ? null : r.eraOffered ? "835 offered" : "no 835",
      paymentCycle: r.paymentCycle ?? null,
      notes: [r.enrollmentMethod && `Enrollment: ${r.enrollmentMethod}`, r.remittanceContact && `Ask: ${r.remittanceContact}`].filter(Boolean).join(" ") || null,
    };
    const prior = existing.routing && norm(existing.routing.pbmName) === norm(pbmName) ? existing.routing : undefined;
    routing = {
      kind: "routing",
      standing: standingOf(prior as Record<string, string | null> | undefined, row, ["paysVia", "paymentMethod", "remittanceSource", "paymentCycle"]),
      row,
      quote: r.citation?.quote ?? null,
      existing: prior ? { paysVia: prior.paysVia, paymentMethod: prior.paymentMethod, remittanceSource: prior.remittanceSource, paymentCycle: prior.paymentCycle } : undefined,
    };
  }

  // ── Which of the pharmacy's plans this document governs ──
  const bins = new Set(t.bins.map((b) => norm(b)).filter(Boolean) as string[]);
  const pcns = new Set(t.pcns.map((b) => norm(b)).filter(Boolean) as string[]);
  const groups = new Set(t.groupIds.map((b) => norm(b)).filter(Boolean) as string[]);
  const networks = new Set(t.networkReimbursementIds.map((b) => norm(b)).filter(Boolean) as string[]);
  const matches: PlanMatch[] = [];
  for (const p of plans) {
    const on: PlanMatch["matchedOn"] = [];
    if (norm(p.bin) && bins.has(norm(p.bin)!)) on.push("bin");
    if (norm(p.pcn) && pcns.has(norm(p.pcn)!)) on.push("pcn");
    if (norm(p.groupNumber) && groups.has(norm(p.groupNumber)!)) on.push("group");
    // The network reimbursement id the claims carry is the PBM's own name for the contract that priced them.
    const netHit = (p.networkIds ?? []).map(norm).find((n) => n && networks.has(n)) ?? null;
    if (netHit) on.push("network");
    // A group alone is not a match: group numbers repeat across PBMs. A BIN, a PCN or a network id is.
    if (!on.includes("bin") && !on.includes("pcn") && !on.includes("network")) continue;
    const contested = (existing.otherDocuments ?? []).filter((d) => d.name !== documentName && d.bins.some((b) => norm(b) === norm(p.bin))).map((d) => d.name);
    const link = {
      bin: p.bin,
      pcn: on.includes("pcn") ? (p.pcn ?? null) : null,
      groupNumber: on.includes("group") ? p.groupNumber : null,
      contractId: netHit,
      pbmName,
      basis: `${documentName} prints ${on.map((x) => (x === "bin" ? `BIN ${p.bin}` : x === "pcn" ? `PCN ${p.pcn}` : x === "group" ? `group ${p.groupNumber}` : `network id ${netHit}`)).join(", ")}.`,
    };
    // The proposed link must actually match the plan, or the page would write a link that never fires.
    if (matchScore(link, { bin: p.bin, pcn: p.pcn ?? null, groupNumber: p.groupNumber, contractId: netHit }) === null) continue;
    matches.push({ plan: p, matchedOn: on, contested: netHit ? [] : contested, proposedLink: link });
  }
  matches.sort((a, b) => b.matchedOn.length - a.matchedOn.length || b.plan.claims - a.plan.claims);

  const caveats = [
    ...(governs.why ? [governs.why] : []),
    ...rates.filter((r) => r.quoteFound === false).map((r) => `The ${r.row.network} rate's quote was not found in the document's own text; look before applying it.`),
    ...t.unclearOrMissing,
    ...(t.incorporatesByReference.length ? [`Cannot be read alone: incorporates ${t.incorporatesByReference.join(", ")}.`] : []),
    ...(t.definitionsDelegatedTo ? [`Definitions (AWP, brand, generic, U&C) live in ${t.definitionsDelegatedTo}.`] : []),
    ...rates.filter((r) => !r.readable.brand || !r.readable.generic).map((r) => `The ${r.row.network} rate is written in words the site cannot price: "${!r.readable.brand ? r.row.brandRate : r.row.genericRate}".`),
  ];

  return { pbmName, sourceLabel, governs, rates, appeal, contacts, routing, plans: matches, caveats };
}

/** Third parties grouped: every document under the counterparty it names, with what each contributes. */
export function groupByCounterparty(docs: { name: string; terms: ContractTermsT | null; pbmName: string | null }[]): { counterparty: string; documents: { name: string; role: string; effective: string | null; rates: number; hasAppeal: boolean; contacts: number }[] }[] {
  const by = new Map<string, { counterparty: string; documents: { name: string; role: string; effective: string | null; rates: number; hasAppeal: boolean; contacts: number }[] }>();
  for (const d of docs) {
    const key = (d.terms?.counterparty ?? d.pbmName ?? "Unnamed").trim();
    const g = by.get(key) ?? { counterparty: key, documents: [] };
    g.documents.push({
      name: d.name,
      role: d.terms?.documentRole ?? "unknown",
      effective: d.terms?.effectiveDate ?? null,
      rates: d.terms?.rates.length ?? 0,
      hasAppeal: d.terms?.macAppealWindowDays.value != null || Boolean(d.terms?.macAppealMethod.value),
      contacts: d.terms?.contacts.length ?? 0,
    });
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => a.counterparty.localeCompare(b.counterparty));
}
