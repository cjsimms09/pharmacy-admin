/**
 * A MAC appeal, assembled from what the site already holds.
 *
 * An appeal is the same six facts every time: the claim, what it paid, what the contract says it
 * should have paid, what the drug cost on the invoice, the deadline, and where it goes. Every one
 * of those is on file somewhere in this site once the contracts have been read, so the packet is
 * assembled rather than written. What cannot be assembled is said, not guessed: an appeal missing
 * the invoice the PBM requires is not sent with an estimate in its place.
 *
 * ── What is appealed ──
 *
 * A claim paid under the contract's own formula, by more than a tolerance, on a generic where the
 * pharmacy holds the invoice. The formula is priced by `rate-formula.ts`; where it prices "at
 * most" (a lesser-of with the MAC not held) the shortfall is against the ceiling, and the packet
 * says so, because the PBM's answer will be the MAC and the question is whether the MAC is below
 * acquisition cost — which is the appeal a MAC appeal actually is.
 *
 * Pure. The page decides how to send it: the PBM's channel from `macAppealTerms`.
 */

import { addDays } from "./supplies";

export type AppealClaim = {
  rxNumber: string;
  fillNumber: number | null;
  dateFilled: string;
  /** Adjudication and remittance dates, where the site knows them; the window may run from either. */
  adjudicatedOn?: string | null;
  remittedOn?: string | null;
  ndc11: string;
  drugName: string | null;
  quantityThousandths: number | null;
  daysSupply?: number | null;
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  pbmName: string;
  claimReference?: string | null;
  /** Ingredient cost paid plus dispensing fee paid, in cents. */
  paidCents: number;
  ingredientPaidCents: number | null;
};

export type AppealTerms = {
  pbmName: string;
  submissionChannel: string | null;
  submissionTarget: string | null;
  appealWindowDays: number | null;
  windowBasis: string | null;
  requiredFields: string | null;
  invoiceRequired: string | null;
  responseSlaDays: number | null;
};

export type Invoice = { supplier: string; invoiceNumber: string | null; invoiceDate: string; unitCostMicros: number; packUnits: number | null };

export type Packet = {
  ok: boolean;
  /** Why it cannot be sent as it stands. Empty when ok. */
  blockers: string[];
  deadline: string | null;
  deadlineBasis: string;
  daysLeft: number | null;
  shortfallCents: number;
  /** True where the contract figure is a ceiling (a MAC leg not held). */
  againstCeiling: boolean;
  /** The unit acquisition cost the appeal cites, and the paid unit price. */
  acquisitionUnitMicros: number | null;
  paidUnitMicros: number | null;
  fields: { label: string; value: string }[];
  narrative: string;
  attachments: string[];
  sendVia: { channel: string | null; target: string | null };
};

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const perUnit = (m: number) => `$${(m / 1_000_000).toFixed(4)}`;

/** The day the window closes, from the basis the contract names. Null where the basis date is not held. */
export function deadlineFor(terms: AppealTerms, claim: AppealClaim): { deadline: string | null; basis: string } {
  if (terms.appealWindowDays == null) return { deadline: null, basis: "The contract does not state an appeal window." };
  const basis = terms.windowBasis ?? "date_of_fill";
  const from =
    basis === "date_of_adjudication" ? claim.adjudicatedOn ?? null : basis === "date_of_remittance" ? claim.remittedOn ?? null : claim.dateFilled;
  if (!from) return { deadline: null, basis: `The window runs from the ${basis.replace(/_/g, " ")}, which the site does not hold for this claim.` };
  return { deadline: addDays(from, terms.appealWindowDays), basis: `${terms.appealWindowDays} days from the ${basis.replace(/_/g, " ")} (${from}).` };
}

export function buildPacket(a: {
  claim: AppealClaim;
  terms: AppealTerms | null;
  /** What the contract says it should have paid, from `expectedCents`. */
  expected: { totalCents: number | null; atMost: boolean; why: string; formulaText: string | null };
  invoice: Invoice | null;
  today: string;
  /** Below this the shortfall is not worth the PBM's time or the pharmacy's. */
  minShortfallCents?: number;
  pharmacy: { name: string; ncpdp: string | null; npi: string | null };
}): Packet {
  const { claim, terms, expected, invoice, today } = a;
  const min = a.minShortfallCents ?? 300;
  const blockers: string[] = [];
  const units = claim.quantityThousandths ? claim.quantityThousandths / 1000 : null;
  const paidUnit = units && claim.ingredientPaidCents != null ? Math.round((claim.ingredientPaidCents * 10_000) / units) : null;
  const shortfall = expected.totalCents != null ? expected.totalCents - claim.paidCents : 0;

  if (!terms) blockers.push(`No appeal terms on file for ${claim.pbmName}: read the contract, or enter the window and the address on the payer page.`);
  if (expected.totalCents == null) blockers.push(`The contract rate cannot be priced for this claim: ${expected.why}`);
  else if (shortfall < min) blockers.push(`Paid within ${money(min)} of the contract figure (${money(shortfall)} short): not worth an appeal.`);
  const wantsInvoice = terms?.invoiceRequired === "yes" || /invoice/i.test(terms?.requiredFields ?? "");
  if (wantsInvoice && !invoice) blockers.push(`${claim.pbmName} requires the invoice, and no invoice line is on file for ${claim.ndc11}.`);
  if (!units) blockers.push("No quantity on the claim.");

  const dl = terms ? deadlineFor(terms, claim) : { deadline: null, basis: "No appeal terms on file." };
  const daysLeft = dl.deadline ? Math.round((Date.parse(dl.deadline) - Date.parse(today)) / 86_400_000) : null;
  if (daysLeft !== null && daysLeft < 0) blockers.push(`The appeal window closed on ${dl.deadline}.`);

  const acq = invoice ? invoice.unitCostMicros : null;
  const fields: { label: string; value: string }[] = [
    { label: "Pharmacy", value: [a.pharmacy.name, a.pharmacy.ncpdp && `NCPDP ${a.pharmacy.ncpdp}`, a.pharmacy.npi && `NPI ${a.pharmacy.npi}`].filter(Boolean).join(" · ") },
    { label: "Rx / fill", value: `${claim.rxNumber}${claim.fillNumber != null ? `-${claim.fillNumber}` : ""}` },
    { label: "Date of service", value: claim.dateFilled },
    { label: "BIN / PCN / group", value: [claim.bin, claim.pcn, claim.groupNumber].map((x) => x ?? "—").join(" / ") },
    { label: "NDC", value: `${claim.ndc11}${claim.drugName ? ` (${claim.drugName})` : ""}` },
    { label: "Quantity", value: units != null ? `${units}` : "—" },
    { label: "Paid", value: `${money(claim.paidCents)}${paidUnit != null ? ` (${perUnit(paidUnit)} a unit)` : ""}` },
    { label: expected.atMost ? "Contract rate (at most)" : "Contract rate", value: expected.totalCents != null ? `${money(expected.totalCents)}${expected.formulaText ? ` per "${expected.formulaText}"` : ""}` : "—" },
    { label: "Shortfall", value: expected.totalCents != null ? money(shortfall) : "—" },
    { label: "Acquisition cost", value: invoice ? `${perUnit(invoice.unitCostMicros)} a unit, ${invoice.supplier} invoice ${invoice.invoiceNumber ?? ""} of ${invoice.invoiceDate}`.replace(/\s+of/, " of") : "no invoice on file" },
  ];
  if (claim.claimReference) fields.splice(2, 0, { label: "Claim reference", value: claim.claimReference });

  const underCost = acq != null && paidUnit != null && paidUnit < acq;
  const narrative =
    `${a.pharmacy.name} requests review of the reimbursement on Rx ${claim.rxNumber}${claim.fillNumber != null ? `-${claim.fillNumber}` : ""}, NDC ${claim.ndc11}${claim.drugName ? ` (${claim.drugName})` : ""}, ` +
    `date of service ${claim.dateFilled}, quantity ${units ?? "—"}. ` +
    (expected.totalCents != null
      ? `The claim paid ${money(claim.paidCents)}; the contracted rate${expected.formulaText ? ` ("${expected.formulaText}")` : ""} yields ${money(expected.totalCents)}${expected.atMost ? " before any MAC" : ""}, a difference of ${money(shortfall)}. `
      : "") +
    (acq != null
      ? `The pharmacy's acquisition cost was ${perUnit(acq)} a unit (${invoice!.supplier}, invoice ${invoice!.invoiceNumber ?? "attached"}, ${invoice!.invoiceDate})${paidUnit != null ? `, against ${perUnit(paidUnit)} a unit paid` : ""}${underCost ? ": the claim was paid below acquisition cost" : ""}. `
      : "") +
    `Please adjust the MAC for this NDC to no less than acquisition cost and reprocess the claim${terms?.responseSlaDays ? ` within the ${terms.responseSlaDays} days the agreement provides` : ""}.`;

  const attachments = [
    ...(invoice ? [`Invoice ${invoice.invoiceNumber ?? ""} from ${invoice.supplier}, ${invoice.invoiceDate}, the line for ${claim.ndc11}`] : []),
    "The claim's adjudication record from PioneerRx",
  ];

  return {
    ok: blockers.length === 0,
    blockers,
    deadline: dl.deadline,
    deadlineBasis: dl.basis,
    daysLeft,
    shortfallCents: Math.max(0, shortfall),
    againstCeiling: expected.atMost,
    acquisitionUnitMicros: acq,
    paidUnitMicros: paidUnit,
    fields,
    narrative,
    attachments,
    sendVia: { channel: terms?.submissionChannel ?? null, target: terms?.submissionTarget ?? null },
  };
}
