import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/lib/contract-digest";
import { ContractTerms, fillNulls, type ContractTermsT } from "../src/lib/contract-terms";
import { z } from "zod";

/**
 * The point of the digest is that nothing a read finds is thrown away. So the test that matters is
 * not "does it render" — it is that every field of the schema which is not already a payer-page row
 * reaches a line somewhere. An audit found twenty that did not; this is what stops the twenty-first.
 */

/** An empty read: every array empty, every optional absent, then filled with nulls as the site sees it. */
const empty = (): ContractTermsT =>
  fillNulls(ContractTerms, {
    counterparty: "Example PBM",
    documentTitle: "Agreement",
    contractType: "payer_network",
    documentRole: "base",
    supersedes: [],
    bins: [], pcns: [], groupIds: [], chainCodes: [], networkNames: [], networkReimbursementIds: [],
    pharmacyNcpdps: [], pharmacyNpis: [], linesOfBusiness: [],
    rates: [], effectiveRateGuarantees: [], postPointOfSaleDiscounts: [], disputeWindows: [],
    reportsOwed: [], transactionFees: [], performanceMeasures: [], keyDefinitions: [],
    incorporatesByReference: [], macAppealRequiredFields: [], contacts: [], gcrTiers: [],
    noticesOwedByPharmacy: [], sections: [], unclearOrMissing: [],
    pricingCompendium: {}, macListAccess: {}, dawRules: {}, recoupmentTerms: {}, dirFeeBasis: {},
    macAppealWindowDays: {}, macAppealMethod: {}, gcrDefinition: {}, terminationRights: {}, allProductsClause: {},
    confidence: 0.9,
  }) as ContractTermsT;

describe("the digest", () => {
  test("a read that found nothing beyond its identity shows nothing", () => {
    const groups = digest(empty());
    // "What this document is" always has the chain; nothing else should appear.
    assert.deepEqual(groups.map((g) => g.title), ["What this document is"]);
  });

  test("every group that has a term shows it, with the sentence behind it", () => {
    const t = empty();
    t.promptPayDays = 30;
    t.latePaymentInterest = "1% per month";
    t.postPointOfSaleDiscounts = [{ name: "GDR fee", trigger: "generic dispensing rate below 88%", calculation: "0.5% of ingredient cost", collectionMethod: "offset against the next cycle", frequency: "quarterly", appliesToPbmVendor: null, citation: { quote: "A fee of 0.5% applies where GDR falls below 88%.", page: 4, section: null } }];
    t.pricingCompendium = { value: "Medi-Span, date of service", citation: { quote: "AWP means the Medi-Span published price on the date of service.", page: 2, section: null } };
    t.remittance = { paidBy: null, paymentMethod: null, paymentCycle: null, eraOffered: null, enrollmentMethod: null, remittanceContact: null, payerNamesOnRemittance: ["EXAMPLE HEALTH PLAN INC"], payerIdentifiers: ["87726"], citation: null };
    t.noticesOwedByPharmacy = [{ subject: "Change of pharmacist-in-charge", withinDays: 10, method: "written notice to Network Relations", consequenceIfMissed: "material breach", citation: null }];

    const groups = digest(t);
    const flat = groups.flatMap((g) => g.lines.map((l) => `${l.label}: ${l.value}`)).join("\n");
    assert.match(flat, /Days to pay a clean claim: 30 days/);
    assert.match(flat, /Interest when late: 1% per month/);
    assert.match(flat, /GDR fee: .*below 88%/);
    assert.match(flat, /Pricing compendium: Medi-Span/);
    assert.match(flat, /Names on the remittance: EXAMPLE HEALTH PLAN INC/);
    assert.match(flat, /Payer identifiers: 87726/);
    assert.match(flat, /Change of pharmacist-in-charge: 10 days/);

    const dir = groups.find((g) => g.title.startsWith("Money taken back"));
    assert.equal(dir?.lines[0].quote, "A fee of 0.5% applies where GDR falls below 88%.");
  });

  test("no field of the schema is left with nowhere to go", () => {
    /*
     * The five the payer pages own — rates, the appeal terms, the contacts, the payment path and
     * the plan links — plus the identity and honesty fields the page shows in its own right.
     */
    const elsewhere = new Set([
      "counterparty", "documentTitle", "contractType", "documentRole", "parentAgreement", "amendmentNumber",
      "bins", "pcns", "groupIds", "linesOfBusiness", "effectiveDate", "endDate",
      "rates", "contacts", "remittance", "sections", "unclearOrMissing", "confidence",
      "macAppealWindowDays", "macAppealWindowBasis", "macAppealMethod", "macAppealResponseDays",
      "macAppealRetroactive", "macAppealRequiredFields", "macAppealInvoiceRequired", "macAppealSubmissionTarget",
    ]);
    const shape = (ContractTerms as unknown as { _zod: { def: { shape: Record<string, z.ZodTypeAny> } } })._zod.def.shape;

    // A read with something in every field, so a group that would show it does show it.
    const t = empty();
    t.agreementNumber = "AGR-1";
    t.supersedes = ["Prior exhibit"];
    t.incorporatesByReference = ["Provider Manual"];
    t.definitionsDelegatedTo = "the Provider Manual";
    t.autoRenews = true;
    t.terminationNoticeDays = 90;
    t.amendmentNoticeDays = 30;
    t.terminationRights = { value: "Either party, without cause, on 90 days", citation: null };
    t.allProductsClause = { value: "Participation in one network requires all", citation: null };
    t.noticesOwedByPharmacy = [{ subject: "Change of ownership", withinDays: 30, method: null, consequenceIfMissed: null, citation: null }];
    t.claimSubmissionWindowDays = 90;
    t.reversalWindowDays = 14;
    t.effectiveRateGuarantees = [{ pbmVendor: null, network: null, costSharingTier: "both", daysSupplyMin: null, daysSupplyMax: null, brandEffectiveRate: "AWP-20%", genericEffectiveRate: "AWP-84.5%", measurementBasis: "all pharmacies", reconciledBy: "the plan, annually", citation: null }];
    t.postPointOfSaleDiscounts = [{ name: "DIR", trigger: null, calculation: null, collectionMethod: null, frequency: null, appliesToPbmVendor: null, citation: null }];
    t.disputeWindows = [{ subject: "MAC pricing", days: 30, runsFrom: null, consequenceIfMissed: null, escalation: null, citation: null }];
    t.reportsOwed = [{ name: "Annual reconciliation", owedBy: null, dueBy: null, format: null, granularity: null, citation: null }];
    t.transactionFees = [{ name: "Switch fee", amount: "$0.10", appliesTo: null, citation: null }];
    t.pricingCompendium = { value: "Medi-Span", citation: null };
    t.macListAccess = { value: "On request", citation: null };
    t.performanceMeasures = [{ measure: "GDR", threshold: "88%", effect: "DIR tier", period: null, citation: null }];
    t.dawRules = { value: "DAW 1 honoured", citation: null };
    t.promptPayDays = 30;
    t.latePaymentInterest = "1%";
    t.recoupmentTerms = { value: "Offset on 30 days notice", citation: null };
    t.keyDefinitions = [{ term: "Generic", definition: "Multi-source Y", citation: null }];
    t.usualAndCustomaryDefinition = "The cash price";
    t.dirFeeBasis = { value: "Percentage of ingredient cost", citation: null };
    t.dirMeasurementPeriod = "quarterly";
    t.auditLookbackYears = 2;
    t.auditExtrapolationAllowed = false;
    t.gcrTiers = [{ minPercent: 85, maxPercent: 90, rebatePercent: 3, citation: null }];
    t.gcrDefinition = { value: "Generic spend over total", citation: null };
    t.primarySupplierRequirementPercent = 85;
    t.rebatePaymentTerms = "Quarterly in arrears";
    t.chainCodes = ["605"];
    t.networkNames = ["Premier"];
    t.networkReimbursementIds = ["ABC1"];
    t.pharmacyNcpdps = ["1234567"];
    t.pharmacyNpis = ["1999999999"];

    const groups = digest(t);
    const labels = groups.flatMap((g) => g.lines.map((l) => l.label.toLowerCase())).join(" | ");
    const values = groups.flatMap((g) => g.lines.map((l) => l.value.toLowerCase())).join(" | ");
    const seen = `${labels} | ${values}`;

    // Each remaining field must be recognisable somewhere in what the digest shows.
    const proof: Record<string, string> = {
      agreementNumber: "agr-1", supersedes: "prior exhibit", incorporatesByReference: "provider manual",
      definitionsDelegatedTo: "the provider manual", autoRenews: "renews itself",
      terminationNoticeDays: "notice to terminate", amendmentNoticeDays: "notice before an amendment",
      terminationRights: "without cause", allProductsClause: "all-products",
      noticesOwedByPharmacy: "change of ownership", claimSubmissionWindowDays: "claim submission window",
      reversalWindowDays: "reversal window", effectiveRateGuarantees: "awp-84.5%",
      postPointOfSaleDiscounts: "dir", disputeWindows: "mac pricing", reportsOwed: "annual reconciliation",
      transactionFees: "switch fee", pricingCompendium: "medi-span", macListAccess: "on request",
      performanceMeasures: "gdr", dawRules: "daw 1", promptPayDays: "days to pay a clean claim",
      latePaymentInterest: "interest when late", recoupmentTerms: "recoupment",
      keyDefinitions: "multi-source y", usualAndCustomaryDefinition: "the cash price",
      dirFeeBasis: "percentage of ingredient cost", dirMeasurementPeriod: "measured over",
      auditLookbackYears: "audit look-back", auditExtrapolationAllowed: "extrapolated",
      gcrTiers: "gcr 85%", gcrDefinition: "generic spend over total",
      primarySupplierRequirementPercent: "primary supplier requirement", rebatePaymentTerms: "quarterly in arrears",
      chainCodes: "chain codes governed", networkNames: "networks named",
      networkReimbursementIds: "545-2f", pharmacyNcpdps: "pharmacy ncpdp", pharmacyNpis: "pharmacy npi",
    };

    const orphans = Object.keys(shape).filter((k) => !elsewhere.has(k) && !proof[k]);
    assert.deepEqual(orphans, [], `these fields of the schema are shown nowhere and have no proof here: ${orphans.join(", ")}`);
    for (const [field, needle] of Object.entries(proof)) {
      assert.ok(seen.includes(needle), `${field} is read from the contract but appears nowhere in the digest`);
    }
  });
});
