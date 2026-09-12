import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { counterpartyFile, clocksDue, type Doc } from "../src/lib/contract-file";
import { termsFromObject } from "../src/lib/contract-terms";

/** A counterparty's file, built from two documents' drafts: base agreement and rate exhibit. */
const cite = (quote: string, page = 3) => ({ quote, page, section: "4.2" });
const base = termsFromObject({
  counterparty: "Example PBM", documentTitle: "Pharmacy Network Agreement", contractType: "payer_network", documentRole: "base", parentAgreement: null, amendmentNumber: null, supersedes: [],
  bins: ["610014"], pcns: [], groupIds: [], chainCodes: ["605", "630"], networkNames: ["Preferred"], linesOfBusiness: ["Commercial"],
  effectiveDate: "2026-01-01", endDate: "2026-12-31", autoRenews: true, terminationNoticeDays: 90, amendmentNoticeDays: 30, claimSubmissionWindowDays: 90, reversalWindowDays: 14,
  rates: [], effectiveRateGuarantees: [], postPointOfSaleDiscounts: [{ name: "Network performance fee", trigger: "GDR under 85%", calculation: "3% of ingredient cost", collectionMethod: "offset against the next remittance", frequency: "quarterly", appliesToPbmVendor: null, citation: cite("A Network Performance Fee of 3% of ingredient cost is assessed quarterly where GDR is below 85%.") }],
  disputeWindows: [{ subject: "Remittance", days: 60, runsFrom: "remittance date", consequenceIfMissed: "deemed accepted", escalation: null, citation: cite("Remittances not disputed within 60 days are deemed accepted.") }],
  reportsOwed: [{ name: "Annual GER reconciliation", owedBy: "the PBM", dueBy: "March 31", format: null, granularity: "by NCPDP", citation: null }],
  transactionFees: [{ name: "Transaction fee", amount: "$0.10 per claim", appliesTo: "all claims", citation: null }],
  pricingCompendium: { value: "Medi-Span, date of service", citation: cite("Pricing is based on Medi-Span AWP as of the date of service.") }, macListAccess: { value: null, citation: null }, performanceMeasures: [{ measure: "Generic dispensing rate", threshold: "85%", effect: "3% fee below it", period: "quarter", citation: null }],
  dawRules: { value: null, citation: null }, promptPayDays: 30, latePaymentInterest: null, recoupmentTerms: { value: "Offset on 30 days' notice", citation: null },
  keyDefinitions: [{ term: "Generic", definition: "A drug with an FDA orange book A rating", citation: null }], incorporatesByReference: ["Provider Manual"], definitionsDelegatedTo: null, usualAndCustomaryDefinition: null,
  dirFeeBasis: { value: null, citation: null }, dirMeasurementPeriod: null,
  macAppealWindowDays: { value: 14, citation: cite("Appeals must be filed within 14 days of adjudication.") }, macAppealWindowBasis: "date_of_adjudication", macAppealMethod: { value: null, citation: null }, macAppealResponseDays: 7, macAppealRetroactive: null, macAppealRequiredFields: [], macAppealInvoiceRequired: null, macAppealSubmissionTarget: null,
  contacts: [], remittance: null, auditLookbackYears: 2, auditExtrapolationAllowed: false, gcrTiers: [], gcrDefinition: { value: null, citation: null }, primarySupplierRequirementPercent: null, rebatePaymentTerms: null, sections: [],
  unclearOrMissing: ["Exhibit C referenced and not attached."], confidence: 0.8,
});
const exhibit = termsFromObject({ ...JSON.parse(JSON.stringify(base)), documentTitle: "Exhibit B", documentRole: "rate_sheet", supersedes: ["Exhibit B (2025)"], effectiveDate: "2026-03-01", endDate: null, terminationNoticeDays: null, amendmentNoticeDays: null, claimSubmissionWindowDays: null, reversalWindowDays: null, postPointOfSaleDiscounts: [], disputeWindows: [], reportsOwed: [], transactionFees: [], performanceMeasures: [], keyDefinitions: [], incorporatesByReference: [], promptPayDays: null, auditLookbackYears: null, recoupmentTerms: { value: null, citation: null }, pricingCompendium: { value: null, citation: null }, macAppealWindowDays: { value: null, citation: null }, unclearOrMissing: [], pcns: ["PDMI"], rates: [{ pbmVendor: null, network: "Preferred", lineOfBusiness: null, costSharingTier: "both", daysSupplyMin: null, daysSupplyMax: null, brandFormula: "AWP-17%", brandDispensingFee: 1.5, genericBasis: "MAC", genericDispensingFee: 1.5, specialtyTerms: null, compoundTerms: null, vaccineTerms: null, effectiveFrom: null, effectiveTo: null, citation: cite("Brand AWP-17% + $1.50; generic MAC + $1.50.") }] });
const docs: Doc[] = [
  { id: "d2", name: "Exhibit B 2026", terms: exhibit, state: "done", fileName: "b.pdf", pages: 4 },
  { id: "d1", name: "Base agreement", terms: base, state: "done", fileName: "a.pdf", pages: 40 },
  { id: "d3", name: "Something unread", terms: null, state: "none", fileName: "c.pdf", pages: null },
];

describe("a counterparty's file", () => {
  const f = counterpartyFile("Example PBM", docs);
  test("the chain reads base first, then the exhibit, then the unread", () => {
    assert.deepEqual(f.documents.map((d) => [d.name, d.role]), [["Base agreement", "base"], ["Exhibit B 2026", "rate_sheet"], ["Something unread", "unread"]]);
    assert.deepEqual(f.documents[1].supersedes, ["Exhibit B (2025)"]);
  });
  test("every identifier any document printed, once, sorted", () => {
    assert.deepEqual(f.identifiers.bins, ["610014"]);
    assert.deepEqual(f.identifiers.pcns, ["PDMI"]);
    assert.deepEqual(f.identifiers.chainCodes, ["605", "630"]);
  });
  test("what is taken back, with its sentence and the document it came from", () => {
    assert.equal(f.takenBack.length, 1);
    assert.equal(f.takenBack[0].collection, "offset against the next remittance");
    assert.equal(f.takenBack[0].from.doc, "Base agreement");
    assert.match(f.takenBack[0].from.quote ?? "", /3% of ingredient cost/);
  });
  test("the clocks: the notice deadline is a day, the windows are rules, the dated one sorts first", () => {
    const notice = f.clocks.find((c) => c.what.startsWith("Notice to terminate"));
    assert.equal(notice?.on, "2026-10-02", "ninety days before the end date");
    assert.equal(f.clocks[0].what, notice?.what);
    assert.ok(f.clocks.some((c) => c.what === "MAC appeal" && /14 days from date of adjudication/.test(c.rule)));
    assert.ok(f.clocks.some((c) => c.what === "Dispute: Remittance" && c.consequence === "deemed accepted"));
    assert.deepEqual(clocksDue(f, "2026-09-07", 30).map((c) => c.on), ["2026-10-02"]);
    assert.deepEqual(clocksDue(f, "2026-09-07", 10), []);
  });
  test("reports, fees, measures, the money rules and the definitions all land, each from its document", () => {
    assert.equal(f.reportsOwed[0].name, "Annual GER reconciliation");
    assert.equal(f.fees[0].amount, "$0.10 per claim");
    assert.equal(f.measures[0].threshold, "85%");
    assert.deepEqual(f.moneyRules.map((r) => r.what), ["Pricing compendium and its date basis", "Recoupment and offset"]);
    assert.equal(f.definitions[0].term, "Generic");
    assert.deepEqual(f.unanswered.map((u) => u.what), ["Exhibit C referenced and not attached.", "Cannot be read alone: incorporates Provider Manual."]);
    assert.equal(f.ladder, null, "a payer has no rebate ladder");
  });
});
