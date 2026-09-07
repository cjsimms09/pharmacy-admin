import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { proposeFromContract, groupByCounterparty } from "../src/lib/contract-apply";
import type { ContractTermsT } from "../src/lib/contract-terms";

/**
 * From a contract as read to proposals a person accepts. The draft below is the shape the
 * extractor returns for a Part D rate exhibit; every figure carries its quote.
 */
const cite = (quote: string) => ({ quote, page: 12, section: "Exhibit B-11" });
const draft = (): ContractTermsT => ({
  counterparty: "Example Part D Plan",
  documentTitle: "2026 Pharmacy Rate Exhibit",
  contractType: "payer_network",
  documentRole: "exhibit",
  parentAgreement: "Pharmacy Network Agreement",
  amendmentNumber: null,
  supersedes: ["2025 Pharmacy Rate Exhibit"],
  bins: ["610455", "004336"],
  pcns: ["PDPPCN"],
  groupIds: ["RX1234"],
  chainCodes: ["605"],
  networkNames: ["Preferred", "Standard"],
  networkReimbursementIds: ["CNCKSNPN"],
  pharmacyNcpdps: [],
  pharmacyNpis: [],
  linesOfBusiness: ["Medicare Part D"],
  effectiveDate: "2026-01-01",
  endDate: null,
  autoRenews: true,
  agreementNumber: null,
  terminationRights: { value: null, citation: null },
  allProductsClause: { value: null, citation: null },
  noticesOwedByPharmacy: [],
  terminationNoticeDays: 90,
  amendmentNoticeDays: 30,
  claimSubmissionWindowDays: 90,
  reversalWindowDays: 14,
  rates: [
    { pbmVendor: "CVS Caremark", network: "Preferred", costSharingTier: "preferred", bins: [], pcns: [], groupIds: [], lineOfBusiness: null, daysSupplyMin: 1, daysSupplyMax: 34, brandFormula: "AWP-15%", brandDispensingFee: 1.0, genericBasis: "Lesser of (MAC or AWP-25%)", genericDispensingFee: 1.0, specialtyTerms: null, compoundTerms: null, vaccineTerms: null, effectiveFrom: "2026-01-01", effectiveTo: null, citation: cite("Brand: AWP-15% + $1.00. Generic: Lesser of (MAC or AWP-25%) + $1.00.") },
    { pbmVendor: "Express Scripts", network: "Preferred", costSharingTier: "preferred", bins: [], pcns: [], groupIds: [], lineOfBusiness: null, daysSupplyMin: 1, daysSupplyMax: 34, brandFormula: "AWP-16%", brandDispensingFee: 0.75, genericBasis: "Per Schedule 2 of the Provider Manual", genericDispensingFee: 0.75, specialtyTerms: null, compoundTerms: null, vaccineTerms: null, effectiveFrom: null, effectiveTo: null, citation: cite("Express Scripts: AWP-16% + $0.75.") },
    // A rate with money and no quote: refused, as requireCitations would refuse it.
    { pbmVendor: "Unknown", network: "Value", costSharingTier: "unknown", bins: [], pcns: [], groupIds: [], lineOfBusiness: null, daysSupplyMin: null, daysSupplyMax: null, brandFormula: "AWP-20%", brandDispensingFee: null, genericBasis: null, genericDispensingFee: null, specialtyTerms: null, compoundTerms: null, vaccineTerms: null, effectiveFrom: null, effectiveTo: null, citation: null },
  ],
  effectiveRateGuarantees: [],
  postPointOfSaleDiscounts: [],
  disputeWindows: [{ subject: "MAC pricing", days: 30, runsFrom: "date of adjudication", consequenceIfMissed: "deemed accepted", escalation: "Network Relations Director", citation: cite("Disputes not raised within 30 days are deemed accepted.") }],
  reportsOwed: [],
  transactionFees: [],
  pricingCompendium: { value: "Medi-Span, date of service", citation: cite("Pricing shall be based on Medi-Span AWP as of the date of service.") },
  macListAccess: { value: null, citation: null },
  performanceMeasures: [],
  dawRules: { value: null, citation: null },
  promptPayDays: 30,
  latePaymentInterest: null,
  recoupmentTerms: { value: null, citation: null },
  keyDefinitions: [],
  incorporatesByReference: ["PBM Provider Manual"],
  definitionsDelegatedTo: "PBM Provider Manual §2",
  usualAndCustomaryDefinition: null,
  dirFeeBasis: { value: null, citation: null },
  dirMeasurementPeriod: null,
  macAppealWindowDays: { value: 30, citation: cite("A MAC appeal must be submitted within 30 days of adjudication.") },
  macAppealWindowBasis: "date_of_adjudication",
  macAppealMethod: { value: "Provider portal", citation: cite("Appeals are submitted through the provider portal.") },
  macAppealResponseDays: 10,
  macAppealRetroactive: true,
  macAppealRequiredFields: ["claim number", "NDC", "date of service", "invoice"],
  macAppealInvoiceRequired: true,
  macAppealSubmissionTarget: "https://portal.example.invalid/appeals",
  contacts: [
    { purpose: "mac_appeals", name: "MAC Appeals", organisation: "Example PBM", phone: "800-555-0100", fax: null, email: "macappeals@example.invalid", portalUrl: null, postalAddress: null, citation: cite("MAC appeals: 800-555-0100.") },
    { purpose: "payment_or_eft", name: null, organisation: "Example PBM", phone: null, fax: null, email: "eft@example.invalid", portalUrl: "https://portal.example.invalid/eft", postalAddress: null, citation: null },
  ],
  remittance: { payerNamesOnRemittance: [], payerIdentifiers: [], paidBy: "Example PBM", paymentMethod: "EFT", paymentCycle: "twice monthly", eraOffered: true, enrollmentMethod: "EFT/ERA enrollment form on the provider portal", remittanceContact: "eft@example.invalid", citation: cite("Payment is made twice monthly by EFT with an 835 remittance.") },
  auditLookbackYears: 2,
  auditExtrapolationAllowed: false,
  gcrTiers: [],
  gcrDefinition: { value: null, citation: null },
  primarySupplierRequirementPercent: null,
  rebatePaymentTerms: null,
  sections: [{ title: "Exhibit B-11", pageFrom: 12, pageTo: 14, gist: "Rates by vendor and network." }],
  unclearOrMissing: ["Exhibit C (specialty) is referenced and not attached."],
  confidence: 0.9,
});

const plans = [
  { id: "p1", bin: "610455", groupNumber: "RX1234", pcn: "PDPPCN", payerLabel: "Example PDP", claims: 120 },
  { id: "p2", bin: "610455", groupNumber: "OTHER", pcn: "OTHERPCN", payerLabel: "Example other", claims: 20 },
  { id: "p3", bin: "004336", groupNumber: "RX1234", pcn: null, payerLabel: "Commercial via 004336", claims: 300 },
  { id: "p4", bin: "999999", groupNumber: "RX1234", pcn: null, payerLabel: "Same group, other PBM", claims: 50 },
];

describe("what a contract proposes", () => {
  test("one rate row per vendor and network, the uncited one refused, the unreadable one flagged", () => {
    const p = proposeFromContract(draft(), "2026 Rate Exhibit.pdf", plans);
    assert.equal(p.rates.length, 2);
    assert.equal(p.rates[0].row.pbmName, "CVS Caremark");
    assert.equal(p.rates[0].row.brandRate, "AWP-15% + $1.00");
    assert.equal(p.rates[0].row.genericRate, "Lesser of (MAC or AWP-25%) + $1.00");
    assert.equal(p.rates[0].row.daysSupply, "1-34");
    assert.equal(p.rates[0].row.network, "Preferred · preferred");
    assert.deepEqual(p.rates[0].readable, { brand: true, generic: true });
    assert.deepEqual(p.rates[1].readable, { brand: true, generic: false });
    assert.ok(p.caveats.some((c) => /cannot price/.test(c)));
    assert.ok(p.caveats.some((c) => /incorporates PBM Provider Manual/.test(c)));
  });

  test("the appeal terms, the contacts by purpose, and how the money travels", () => {
    const p = proposeFromContract(draft(), "2026 Rate Exhibit.pdf", plans);
    assert.equal(p.appeal?.row.appealWindowDays, 30);
    assert.equal(p.appeal?.row.windowBasis, "date_of_adjudication");
    assert.equal(p.appeal?.row.submissionTarget, "https://portal.example.invalid/appeals");
    assert.equal(p.appeal?.row.invoiceRequired, "yes");
    assert.equal(p.appeal?.row.escalationContact, "Network Relations Director");
    assert.equal(p.contacts.length, 2);
    assert.equal(p.contacts[0].row.contactType, "mac_appeals");
    assert.equal(p.contacts[0].row.phone, "800-555-0100");
    assert.equal(p.routing?.row.remittanceSource, "835 offered");
    assert.match(p.routing?.row.notes ?? "", /Enrollment: EFT\/ERA enrollment form/);
  });

  test("new, same and changed against what the tables hold", () => {
    const p = proposeFromContract(draft(), "2026 Rate Exhibit.pdf", plans, {
      rates: [{ pbmName: "CVS Caremark", lineOfBusiness: "Medicare Part D", network: "Preferred · preferred", daysSupply: "1-34", brandRate: "AWP-14% + $1.00", genericRate: "Lesser of (MAC or AWP-25%) + $1.00" }],
      appeal: { pbmName: "Example Part D Plan", submissionChannel: "Provider portal", submissionTarget: "https://portal.example.invalid/appeals", appealWindowDays: 30, windowBasis: "date_of_adjudication" },
    });
    assert.equal(p.rates[0].standing, "changed");
    assert.equal(p.rates[0].existing?.brandRate, "AWP-14% + $1.00");
    assert.equal(p.rates[1].standing, "new");
    assert.equal(p.appeal?.standing, "same");
  });
});

describe("which plans it governs", () => {
  test("BIN and PCN together beat BIN alone; a group alone is never a match; a contested BIN is named", () => {
    const p = proposeFromContract(draft(), "2026 Rate Exhibit.pdf", plans, { otherDocuments: [{ name: "Old Commercial Exhibit.pdf", bins: ["004336"] }] });
    assert.deepEqual(p.plans.map((m) => m.plan.id), ["p1", "p3", "p2"]);
    assert.deepEqual(p.plans[0].matchedOn, ["bin", "pcn", "group"]);
    assert.deepEqual(p.plans[2].matchedOn, ["bin"]);
    assert.deepEqual(p.plans[1].contested, ["Old Commercial Exhibit.pdf"]);
    assert.equal(p.plans[0].proposedLink.pcn, "PDPPCN");
    assert.equal(p.plans[2].proposedLink.pcn, null);
    assert.match(p.plans[0].proposedLink.basis, /prints BIN 610455, PCN PDPPCN, group RX1234/);
  });
});

describe("the network reimbursement id", () => {
  test("a plan whose claims carry a network id the document prints is matched on it, the link carries it, and it is not contested", () => {
    const withNet = [...plans, { id: "p5", bin: "777777", groupNumber: "G1", pcn: null, payerLabel: "Reached only by its network id", claims: 80, networkIds: ["CNCKSNPN", "OTHER"] }];
    const p = proposeFromContract(draft(), "2026 Rate Exhibit.pdf", withNet, { otherDocuments: [{ name: "Old Exhibit.pdf", bins: ["777777"] }] });
    const m = p.plans.find((x) => x.plan.id === "p5")!;
    assert.deepEqual(m.matchedOn, ["network"]);
    assert.equal(m.proposedLink.contractId, "CNCKSNPN");
    assert.deepEqual(m.contested, []);
    assert.match(m.proposedLink.basis, /network id CNCKSNPN/);
  });
});

describe("the third parties grouped", () => {
  test("every document under its counterparty, with what each contributes", () => {
    const d = draft();
    const g = groupByCounterparty([
      { name: "2026 Rate Exhibit.pdf", terms: d, pbmName: "Example Part D Plan" },
      { name: "Base Agreement.pdf", terms: { ...d, documentRole: "base", rates: [], contacts: [] }, pbmName: "Example Part D Plan" },
      { name: "download(7).pdf", terms: null, pbmName: "Another PBM" },
    ]);
    assert.deepEqual(g.map((x) => x.counterparty), ["Another PBM", "Example Part D Plan"]);
    assert.equal(g[1].documents.length, 2);
    assert.equal(g[1].documents[0].rates, 3);
    assert.equal(g[1].documents[1].role, "base");
    assert.equal(g[0].documents[0].role, "unknown");
  });
});

describe("a document carrying two books", () => {
  test("each rate keeps the book and the routing it was printed with, rather than the first in the list", () => {
    const t = draft();
    t.linesOfBusiness = ["Medicare Part D", "Commercial"];
    t.rates[0].lineOfBusiness = "Medicare Part D";
    t.rates[0].bins = ["610455"];
    t.rates[0].pcns = ["PDPPCN"];
    t.rates[1].lineOfBusiness = "Commercial";
    t.rates[1].bins = ["004336"];
    const p = proposeFromContract(t, "Exhibit B", []);
    assert.equal(p.rates[0].row.lineOfBusiness, "Medicare Part D");
    assert.equal(p.rates[0].row.bins, "610455");
    assert.equal(p.rates[0].row.pcns, "PDPPCN");
    assert.equal(p.rates[1].row.lineOfBusiness, "Commercial");
    assert.equal(p.rates[1].row.bins, "004336");
  });

  test("with two books stated and no rate saying which, the book is unknown rather than guessed", () => {
    const t = draft();
    t.linesOfBusiness = ["Medicare Part D", "Commercial"];
    const p = proposeFromContract(t, "Exhibit B", []);
    assert.equal(p.rates[0].row.lineOfBusiness, "unknown");
  });

  test("with one book stated, every rate takes it", () => {
    const t = draft();
    t.linesOfBusiness = ["Medicare Part D"];
    const p = proposeFromContract(t, "Exhibit B", []);
    assert.equal(p.rates[0].row.lineOfBusiness, "Medicare Part D");
  });
});
