import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseRebateReport, termsFromReport, gprTermsFromReport, bandFor, monthDayYear, looksLikeRebateReport } from "../src/lib/rebate-report";
import { RebateTerms } from "../src/lib/supplier-terms";

/**
 * McKesson's monthly rebate breakdown, as it really prints.
 *
 * Copied from the pharmacy's May statement, with the layout kept exactly: the labels run into
 * their figures with no space, and the two tier ladders are printed side by side with no separator
 * either. The value of the document is that it checks itself — the achieved rate, the band that
 * rate falls in, and the money paid all have to agree — and this is what lets eleven bands of a
 * contract be filed without anybody typing them.
 */
const REPORT = [
  "McKesson Rebate Breakdown",
  " Pharmacy:W WICHITA",
  " Location ID:78366",
  " Primary Account #:326136",
  " Start:May 01 2025End:May 31 2025",
  "Paid:Jun 17 2025",
  "Net Purchased$28,788.29",
  "Miscellaneous Pass Thru$0.00",
  "HealthMart Fees$287.89",
  "IPC Dues$50.00",
  "Total Fees / Reimbursement$337.89",
  "Quarterly 10% Rebate$0.00",
  "Quarterly RTL2 12% Rebate$0.00",
  "Brand Purchases$14,566.42",
  "Brand Factor0.75%",
  "Brand Rebate$109.25",
  "OneStop Purchases$2,872.67",
  "GCR Generic Rebate %29.00%",
  "GCR Generic Rebate$833.07",
  "GPR Generic Rebate %0.00%",
  "GPR Generic Rebate$0.00",
  "Generic Rebate$833.07",
  "Total Paid$1,280.21",
  "GPR: 0.00%Scrubbed GCR: 20.64%",
  "0-74.99%0.00%0-8.99%15.00%0.00%",
  "75-79.99%1.00%9-10.99%17.00%0.00%",
  "80-84.99%2.00%11-11.99%20.00%0.00%",
  "85-85.99%3.00%12-12.99%22.00%0.00%",
  "86-86.99%4.00%13-14.99%24.00%0.00%",
  "87-87.99%5.00%15-15.99%27.00%0.00%",
  "88-88.99%6.00%16-16.99%28.00%0.50%",
  "89-89.99%7.00%17-18.99%29.00%0.50%",
  "90-92.99%8.00%19-22.99%29.00%0.75%",
  "93-94.99%9.00%23-23.99%30.00%0.75%",
  "95+%10.00%24+%30.00%1.00%",
].join("\n");

describe("reading the statement", () => {
  const r = parseRebateReport(REPORT);

  test("it is recognised before anything is read out of it", () => {
    assert.ok(looksLikeRebateReport(REPORT));
    assert.ok(!looksLikeRebateReport("Supplier Catalog Item Search Results\nMcKesson"));
  });

  test("the period, the account and the money all come off", () => {
    assert.equal(r.statement.periodFrom, "2025-05-01");
    assert.equal(r.statement.periodTo, "2025-05-31");
    assert.equal(r.statement.paidOn, "2025-06-17");
    assert.equal(r.statement.accountNumber, "326136");
    assert.equal(r.statement.netPurchasedCents, 2_878_829);
    assert.equal(r.statement.oneStopPurchasedCents, 287_267);
    assert.equal(r.statement.brandPurchasedCents, 1_456_642);
    assert.equal(r.statement.totalPaidCents, 128_021);
  });

  test("the rate earned and the rate achieved are different figures, and both are read", () => {
    // 20.64% is what the pharmacy achieved; 29% is what that earns. Confusing the two would take
    // twenty-nine percent off the wrong prices, or twenty.
    assert.equal(r.statement.scrubbedGcrPercent, 20.64);
    assert.equal(r.statement.gcrRatePercent, 29);
    assert.equal(r.statement.brandFactorPercent, 0.75);
  });
});

describe("reading the ladder", () => {
  const r = parseRebateReport(REPORT);

  test("all eleven bands come off, from two ladders printed with no separator", () => {
    assert.equal(r.ladder.gcr.length, 11);
    assert.equal(r.ladder.gpr.length, 11);
    assert.deepEqual(r.ladder.gcr[0], { fromPercent: 0, toPercent: 8.99, genericPercent: 15, brandPercent: 0 });
    assert.deepEqual(r.ladder.gcr[10], { fromPercent: 24, toPercent: null, genericPercent: 30, brandPercent: 1 });
  });

  test("the GPR ladder beside it is not mistaken for the one that pays", () => {
    // Its bands run 0-74.99 to 95+ and it paid nothing this month. Reading it as the GCR ladder
    // would put the pharmacy in the bottom band for ever.
    assert.equal(r.ladder.gpr[0].fromPercent, 0);
    assert.equal(r.ladder.gpr[10].fromPercent, 95);
    assert.equal(r.ladder.gpr[10].rebatePercent, 10);
  });

  test("a rate lands in the band whose floor it reaches, not the next one up", () => {
    assert.equal(bandFor(r.ladder.gcr, 20.64)!.genericPercent, 29);
    assert.equal(bandFor(r.ladder.gcr, 19)!.fromPercent, 19);
    assert.equal(bandFor(r.ladder.gcr, 18.99)!.fromPercent, 17);
    assert.equal(bandFor(r.ladder.gcr, 0)!.genericPercent, 15);
    assert.equal(bandFor(r.ladder.gcr, 99)!.genericPercent, 30, "the top band is open-ended");
  });
});

describe("the report checking itself", () => {
  test("every check passes on a real statement, so the tiers can be trusted", () => {
    const r = parseRebateReport(REPORT);
    assert.equal(r.checks.length, 4);
    assert.ok(r.checks.every((c) => c.ok), r.checks.filter((c) => !c.ok).map((c) => c.detail).join(" | "));
    assert.equal(r.trustworthy, true);
    assert.deepEqual(r.problems, []);
  });

  test("a ladder that disagrees with the rate paid is refused, not stored", () => {
    // The failure this exists to catch: a tier table read slightly wrong would misprice every
    // generic in the purchasing comparison, and nothing anywhere would say so.
    const bent = REPORT.replace("90-92.99%8.00%19-22.99%29.00%0.75%", "90-92.99%8.00%19-22.99%24.00%0.75%");
    const r = parseRebateReport(bent);
    assert.equal(r.trustworthy, false);
    assert.ok(r.checks.some((c) => !c.ok));
    assert.ok(r.problems.some((p) => /do not agree/i.test(p)));
  });

  test("a rebate that does not match the purchases it was paid on is caught", () => {
    const bent = REPORT.replace("GCR Generic Rebate$833.07", "GCR Generic Rebate$933.07");
    const r = parseRebateReport(bent);
    assert.equal(r.trustworthy, false);
  });

  test("a document with no tier table is refused rather than half-read", () => {
    const r = parseRebateReport(REPORT.split("\n").filter((l) => !/%\d/.test(l)).join("\n"));
    assert.equal(r.trustworthy, false);
    assert.ok(r.problems.some((p) => /tier table/i.test(p)));
  });
});

describe("what gets filed", () => {
  test("the tiers fit the shape the rest of the site stores terms in", () => {
    const terms = termsFromReport(parseRebateReport(REPORT));
    const parsed = RebateTerms.safeParse(terms);
    assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
    assert.equal(terms.tiers.length, 11);
    assert.equal(terms.eligibility, "catalog_rebate_flag", "only what the catalogue marks rebated earns it");
  });

  test("the scrub is written down rather than modelled", () => {
    // Which products McKesson excludes is not in this report and is not published, so the rate is
    // taken as stated. A ratio this software recomputed would be a number it invented.
    const terms = termsFromReport(parseRebateReport(REPORT));
    assert.match(terms.ratioDefinition, /GLP-1/);
    assert.match(terms.ratioDefinition, /not published/);
  });

  test("the brand ladder is kept in the notes, not silently dropped", () => {
    assert.match(termsFromReport(parseRebateReport(REPORT)).notes, /Brand purchases earn a separate factor/);
  });
});

describe("dates", () => {
  test("the report's own date format reads, and nothing else is guessed at", () => {
    assert.equal(monthDayYear("May 01 2025"), "2025-05-01");
    assert.equal(monthDayYear("Jun 17 2025"), "2025-06-17");
    assert.equal(monthDayYear("sometime"), null);
  });
});

/**
 * The second ladder, which pays this pharmacy nothing.
 *
 * That is exactly why it is stored. A purchase ratio of 0.00% against a first paying band of 75%
 * is money not being earned, and money not being earned is invisible unless something holds the
 * shape of what would earn it.
 */
describe("the purchase-ratio ladder", () => {
  const r = parseRebateReport(REPORT);

  test("it is filed as a programme of its own, not folded into the one that pays", () => {
    const gpr = gprTermsFromReport(r)!;
    assert.equal(gpr.tiers.length, 11);
    assert.deepEqual(gpr.tiers[0], { thresholdPercent: 0, rebatePercent: 0 });
    assert.deepEqual(gpr.tiers[1], { thresholdPercent: 75, rebatePercent: 1 });
    assert.deepEqual(gpr.tiers[10], { thresholdPercent: 95, rebatePercent: 10 });
    assert.equal(gpr.eligibility, "all_generics", "a different measure from the OneStop contract flag");
    assert.equal(RebateTerms.safeParse(gpr).success, true);
  });

  test("the notes say where the first money is", () => {
    assert.match(gprTermsFromReport(r)!.notes, /Nothing is paid below 75%/);
  });

  test("the two ladders are never confused for one another", () => {
    // The compliance ladder starts paying at 0%; the purchase-ratio ladder pays nothing until 75%.
    // Reading one for the other would put this pharmacy four bands from where it actually is.
    assert.equal(termsFromReport(r).tiers[0].rebatePercent, 15);
    assert.equal(gprTermsFromReport(r)!.tiers[0].rebatePercent, 0);
  });
});

