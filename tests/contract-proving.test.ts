import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PROVING_PAGES, PROVING_TEXT, checkProving } from "../src/lib/contract-proving";
import { quoteInText } from "../src/lib/contract-apply";
import { pdfText } from "../src/lib/pdf-text";
import { pdfPageCount } from "../src/lib/contract-run";

/** The proving document and its marking scheme stay in step with each other and with the PDF on disk. */
describe("the proving document", () => {
  test("the PDF in fixtures is the pages in code: every line reads back through the site's own reader", () => {
    const buf = fs.readFileSync("fixtures/contracts/proving-agreement.pdf");
    assert.equal(pdfPageCount(buf), PROVING_PAGES.length);
    const text = pdfText(buf);
    for (const line of PROVING_PAGES.flat().filter((l) => l.length > 20)) {
      assert.equal(quoteInText(line, text), true, `not read back: ${line}`);
    }
  });

  test("a correct answer passes every check; a guarantee filed as a rate fails the one that matters", () => {
    const good = {
      counterparty: "Provingtown Health Plan", documentRole: "base",
      bins: ["999123"], pcns: ["PRVTEST"], groupIds: ["PROVE1"], chainCodes: ["605", "630"],
      effectiveDate: "2026-01-01", endDate: "2026-12-31", terminationNoticeDays: 90,
      rates: [
        { network: "Provingtown Preferred Network", daysSupplyMin: 1, daysSupplyMax: 34, brandFormula: "AWP minus 17.0%", brandDispensingFee: 1.5, genericBasis: "the lesser of MAC or AWP minus 45.0%", genericDispensingFee: 2, citation: { quote: "Brand drugs: AWP minus 17.0% plus a dispensing fee of $1.50 per claim." } },
        { network: "Provingtown Preferred Network", daysSupplyMin: 35, daysSupplyMax: 90, brandFormula: "AWP minus 18.0%", brandDispensingFee: 1, genericBasis: "the lesser of MAC or AWP minus 47.0%", genericDispensingFee: 1, citation: { quote: "Brand drugs: AWP minus 18.0% plus a dispensing fee of $1.00 per claim." } },
      ],
      effectiveRateGuarantees: [{ genericEffectiveRate: "AWP minus 84.0%" }],
      postPointOfSaleDiscounts: [{ calculation: "3.0% of ingredient cost", collectionMethod: "offset against the next remittance" }],
      macAppealWindowDays: { value: 14, citation: { quote: "The Pharmacy may appeal a MAC price within fourteen (14) days of the date of adjudication" } },
      macAppealWindowBasis: "date_of_adjudication", macAppealResponseDays: 7,
      remittance: { paymentMethod: "EFT", eraOffered: true },
      disputeWindows: [{ days: 60 }],
      supersedes: ["Exhibit B dated January 1, 2025"],
      pricingCompendium: { value: "Medi-Span AWP as of the date of service" },
    };
    const checks = checkProving(good, quoteInText);
    assert.deepEqual(checks.filter((c) => !c.ok).map((c) => c.check), []);
    const bad = { ...good, rates: [...good.rates, { ...good.rates[0], daysSupplyMin: null, daysSupplyMax: null, genericBasis: "AWP minus 84.0%" }], effectiveRateGuarantees: [] };
    const failed = checkProving(bad, quoteInText).filter((c) => !c.ok).map((c) => c.check);
    assert.ok(failed.includes("The GER guarantee is a guarantee, not a rate"));
  });

  test("the text the checks quote against is the pages", () => {
    assert.match(PROVING_TEXT, /BIN 999123, PCN PRVTEST and Group PROVE1/);
  });
});
