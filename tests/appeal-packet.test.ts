import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildPacket, deadlineFor, type AppealClaim, type AppealTerms } from "../src/lib/appeal-packet";
import { parseFormula, expectedCents } from "../src/lib/rate-formula";

/** A MAC appeal assembled from what the site holds, and refused where a part is missing. */
const terms: AppealTerms = { pbmName: "Example PBM", submissionChannel: "Provider portal", submissionTarget: "https://portal.example.invalid/appeals", appealWindowDays: 30, windowBasis: "date_of_adjudication", requiredFields: "claim number; NDC; date of service; invoice", invoiceRequired: "yes", responseSlaDays: 10 };
const claim: AppealClaim = { rxNumber: "336853", fillNumber: 0, dateFilled: "2026-09-01", adjudicatedOn: "2026-09-01", remittedOn: null, ndc11: "00093505698", drugName: "ATORVASTATIN 20MG TAB", quantityThousandths: 30_000, bin: "610455", pcn: "PDPPCN", groupNumber: "RX1234", pbmName: "Example PBM", paidCents: 1_150, ingredientPaidCents: 150 };
const invoice = { supplier: "McKesson", invoiceNumber: "7788123", invoiceDate: "2026-08-28", unitCostMicros: 120_000, packUnits: 90 };
// No NPI-shaped literal here: the secret scanner treats ten digits after "npi" as one, made up or not.
const pharmacy = { name: "Example Pharmacy", ncpdp: "1712345", npi: null };
// Contract: Lesser of (MAC or AWP-25%) + $1.00; AWP $0.40 a unit → 30 × $0.30 = $9.00 + $1.00 = $10.00, a ceiling.
const expected = () => { const e = expectedCents(parseFormula("Lesser of (MAC or AWP-25%) + $1.00"), 30_000, { awpMicros: 400_000 }); return { totalCents: e.totalCents, atMost: e.atMost, why: e.why, formulaText: "Lesser of (MAC or AWP-25%) + $1.00" }; };

describe("the deadline", () => {
  test("runs from the basis the contract names, and says so", () => {
    assert.deepEqual(deadlineFor(terms, claim), { deadline: "2026-10-01", basis: "30 days from the date of adjudication (2026-09-01)." });
    assert.equal(deadlineFor({ ...terms, windowBasis: "date_of_remittance" }, claim).deadline, null);
    assert.equal(deadlineFor({ ...terms, appealWindowDays: null }, claim).deadline, null);
  });
});

describe("the packet", () => {
  test("assembled: paid $11.50 against a $10.00 ceiling is not short; paid $1.50 a unit under a $0.12 cost is", () => {
    // Paid $11.50 total on a $10.00 ceiling: no shortfall against the contract, so not worth an appeal on the formula.
    const p1 = buildPacket({ claim, terms, expected: expected(), invoice, today: "2026-09-06", pharmacy });
    assert.equal(p1.ok, false);
    assert.match(p1.blockers[0], /not worth an appeal/);
    // Paid $4.00 total, $3.00 ingredient on 30 units = $0.10 a unit, under the $0.12 acquisition cost.
    const p2 = buildPacket({ claim: { ...claim, paidCents: 400, ingredientPaidCents: 300 }, terms, expected: expected(), invoice, today: "2026-09-06", pharmacy });
    assert.equal(p2.ok, true);
    assert.equal(p2.shortfallCents, 600);
    assert.equal(p2.againstCeiling, true);
    assert.equal(p2.deadline, "2026-10-01");
    assert.equal(p2.daysLeft, 25);
    assert.equal(p2.paidUnitMicros, 100_000);
    assert.match(p2.narrative, /paid below acquisition cost/);
    assert.match(p2.narrative, /within the 10 days/);
    assert.equal(p2.fields.find((f) => f.label === "Contract rate (at most)")?.value, '$10.00 per "Lesser of (MAC or AWP-25%) + $1.00"');
    assert.equal(p2.sendVia.target, "https://portal.example.invalid/appeals");
    assert.equal(p2.attachments.length, 2);
  });

  test("refused, with every reason, when the invoice the PBM requires is missing, the window has closed, or the rate cannot be priced", () => {
    const late = buildPacket({ claim: { ...claim, paidCents: 400, ingredientPaidCents: 300 }, terms, expected: expected(), invoice: null, today: "2026-10-15", pharmacy });
    assert.equal(late.ok, false);
    assert.ok(late.blockers.some((b) => /requires the invoice/.test(b)));
    assert.ok(late.blockers.some((b) => /window closed on 2026-10-01/.test(b)));
    const unpriced = buildPacket({ claim, terms, expected: { totalCents: null, atMost: false, why: "No AWP held for this NDC.", formulaText: null }, invoice, today: "2026-09-06", pharmacy });
    assert.match(unpriced.blockers[0], /cannot be priced.*No AWP held/);
    const noTerms = buildPacket({ claim, terms: null, expected: expected(), invoice, today: "2026-09-06", pharmacy });
    assert.match(noTerms.blockers[0], /No appeal terms on file for Example PBM/);
  });
});
