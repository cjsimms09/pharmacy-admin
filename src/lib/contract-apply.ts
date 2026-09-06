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
    effectiveDate: string | null;
    daysSupply: string | null;
    brandRate: string | null;
    genericRate: string | null;
    notes: string | null;
  };
  /** Whether the site can price a claim on it, and if not why. */
  readable: { brand: boolean; generic: boolean };
  quote: string | null;
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
  plan: { id: string; bin: string | null; groupNumber: string | null; pcn?: string | null; payerLabel: string | null; claims: number };
  /** Which identifiers in the document matched: the more, the surer. */
  matchedOn: ("bin" | "pcn" | "group")[];
  /** Other documents that also print this plan's BIN. The person picks. */
  contested: string[];
  proposedLink: { bin: string | null; pcn: string | null; groupNumber: string | null; contractId: string | null; pbmName: string; basis: string };
};

export type Proposals = {
  pbmName: string;
  sourceLabel: string;
  rates: RateProposal[];
  appeal: AppealProposal | null;
  contacts: ContactProposal[];
  routing: RoutingProposal | null;
  plans: PlanMatch[];
  /** What the document says it cannot answer alone, carried through so the checklist shows it. */
  caveats: string[];
};

export type Existing = {
  rates?: { pbmName: string; lineOfBusiness: string; network: string; daysSupply: string | null; brandRate: string | null; genericRate: string | null }[];
  appeal?: { pbmName: string; submissionChannel: string | null; submissionTarget: string | null; appealWindowDays: number | null; windowBasis: string | null } | null;
  contacts?: { pbmName: string; contactType: string; phone: string | null; email: string | null; portalUrl: string | null }[];
  routing?: { pbmName: string; paysVia: string | null; paymentMethod: string | null; remittanceSource: string | null; paymentCycle: string | null } | null;
  /** Every other document's identifiers, to find a BIN claimed twice. */
  otherDocuments?: { name: string; bins: string[] }[];
};

export type PlanForMatch = { id: string; bin: string | null; groupNumber: string | null; pcn?: string | null; payerLabel: string | null; claims: number };

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase() || null;
const same = (a: string | number | null | undefined, b: string | number | null | undefined) => (a ?? null) === (b ?? null);

function standingOf(existing: Record<string, string | number | null> | undefined, row: Record<string, string | number | null>, keys: string[]): Standing {
  if (!existing) return "new";
  return keys.every((k) => same(existing[k], row[k])) ? "same" : "changed";
}

/** The PBM a rate belongs to: the vendor named on the line, else the document's counterparty. */
function pbmOf(t: ContractTermsT, vendor: string | null): string {
  return (vendor ?? "").trim() || t.counterparty;
}

export function proposeFromContract(t: ContractTermsT, documentName: string, plans: PlanForMatch[], existing: Existing = {}): Proposals {
  const sourceLabel = documentName;
  const pbmName = t.counterparty;

  // ── Rates: one row per line of the schedule, priced only where the sentence reads ──
  const rates: RateProposal[] = [];
  for (const r of t.rates) {
    const hasMoney = r.brandFormula || r.genericBasis || r.brandDispensingFee != null || r.genericDispensingFee != null;
    if (!hasMoney || !r.citation?.quote?.trim()) continue;
    const fee = (f: number | null) => (f == null ? "" : ` + $${f.toFixed(2)}`);
    const brandRate = r.brandFormula ? `${r.brandFormula}${/\$/.test(r.brandFormula) ? "" : fee(r.brandDispensingFee)}` : null;
    const genericRate = r.genericBasis ? `${r.genericBasis}${/\$/.test(r.genericBasis) ? "" : fee(r.genericDispensingFee)}` : null;
    const daysSupply = r.daysSupplyMin != null || r.daysSupplyMax != null ? `${r.daysSupplyMin ?? 1}-${r.daysSupplyMax ?? ""}`.replace(/-$/, "+") : null;
    const row = {
      pbmName: pbmOf(t, r.pbmVendor),
      sourceLabel,
      lineOfBusiness: t.linesOfBusiness[0] ?? "unknown",
      network: [r.network, r.costSharingTier !== "unknown" && r.costSharingTier !== "both" ? r.costSharingTier : null].filter(Boolean).join(" · ") || "all",
      effectiveDate: r.effectiveFrom ?? t.effectiveDate ?? null,
      daysSupply,
      brandRate,
      genericRate,
      notes: [r.specialtyTerms && `Specialty: ${r.specialtyTerms}`, r.compoundTerms && `Compounds: ${r.compoundTerms}`, r.vaccineTerms && `Vaccines: ${r.vaccineTerms}`].filter(Boolean).join(" ") || null,
    };
    const prior = existing.rates?.find((e) => norm(e.pbmName) === norm(row.pbmName) && norm(e.network) === norm(row.network) && norm(e.lineOfBusiness) === norm(row.lineOfBusiness) && same(e.daysSupply, row.daysSupply));
    rates.push({
      kind: "rate",
      standing: standingOf(prior as Record<string, string | null> | undefined, row, ["brandRate", "genericRate"]),
      row,
      readable: { brand: !brandRate || parseFormula(brandRate).kind === "priced", generic: !genericRate || parseFormula(genericRate).kind === "priced" },
      quote: r.citation?.quote ?? null,
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
  const matches: PlanMatch[] = [];
  for (const p of plans) {
    const on: PlanMatch["matchedOn"] = [];
    if (norm(p.bin) && bins.has(norm(p.bin)!)) on.push("bin");
    if (norm(p.pcn) && pcns.has(norm(p.pcn)!)) on.push("pcn");
    if (norm(p.groupNumber) && groups.has(norm(p.groupNumber)!)) on.push("group");
    // A group alone is not a match: group numbers repeat across PBMs. A BIN is.
    if (!on.includes("bin") && !on.includes("pcn")) continue;
    const contested = (existing.otherDocuments ?? []).filter((d) => d.name !== documentName && d.bins.some((b) => norm(b) === norm(p.bin))).map((d) => d.name);
    const link = { bin: p.bin, pcn: on.includes("pcn") ? (p.pcn ?? null) : null, groupNumber: on.includes("group") ? p.groupNumber : null, contractId: null as string | null, pbmName, basis: `${documentName} prints ${on.map((x) => (x === "bin" ? `BIN ${p.bin}` : x === "pcn" ? `PCN ${p.pcn}` : `group ${p.groupNumber}`)).join(", ")}.` };
    // The proposed link must actually match the plan, or the page would write a link that never fires.
    if (matchScore(link, { bin: p.bin, pcn: p.pcn ?? null, groupNumber: p.groupNumber, contractId: null }) === null) continue;
    matches.push({ plan: p, matchedOn: on, contested, proposedLink: link });
  }
  matches.sort((a, b) => b.matchedOn.length - a.matchedOn.length || b.plan.claims - a.plan.claims);

  const caveats = [
    ...t.unclearOrMissing,
    ...(t.incorporatesByReference.length ? [`Cannot be read alone: incorporates ${t.incorporatesByReference.join(", ")}.`] : []),
    ...(t.definitionsDelegatedTo ? [`Definitions (AWP, brand, generic, U&C) live in ${t.definitionsDelegatedTo}.`] : []),
    ...rates.filter((r) => !r.readable.brand || !r.readable.generic).map((r) => `The ${r.row.network} rate is written in words the site cannot price: "${!r.readable.brand ? r.row.brandRate : r.row.genericRate}".`),
  ];

  return { pbmName, sourceLabel, rates, appeal, contacts, routing, plans: matches, caveats };
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
