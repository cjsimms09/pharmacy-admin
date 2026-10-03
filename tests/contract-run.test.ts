import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planBatches, estimateCost, pdfPageCount, batchIdsIn, pdfPageLimit, PDF_PAGE_LIMIT, PDF_PAGE_LIMIT_LONG, PDF_PAGE_LIMIT_SHORT, BATCH_BYTES_LIMIT, BATCH_REQUEST_LIMIT } from "../src/lib/contract-run";

/** The run's arithmetic: what fits in a batch, what a read costs, how long a document is. */
describe("batches under the limits", () => {
  test("requests are grouped in order, breaking on bytes and on count, never leaving one behind", () => {
    const items = Array.from({ length: 250 }, (_, i) => ({ item: i, bytes: 1_000_000 }));
    const groups = planBatches(items);
    assert.equal(groups.flat().length, 250);
    assert.deepEqual(groups.map((g) => g.length), [100, 100, 50]);
    assert.deepEqual(groups[0].slice(0, 3), [0, 1, 2]);
    const big = [{ item: "a", bytes: BATCH_BYTES_LIMIT - 1 }, { item: "b", bytes: 2 }, { item: "c", bytes: 1 }];
    assert.deepEqual(planBatches(big), [["a"], ["b", "c"]]);
    assert.equal(BATCH_REQUEST_LIMIT, 100);
  });
  test("a single request larger than a whole batch still goes, alone", () => {
    assert.deepEqual(planBatches([{ item: "x", bytes: BATCH_BYTES_LIMIT * 2 }, { item: "y", bytes: 1 }]), [["x"], ["y"]]);
  });
  test("nothing in, nothing out", () => {
    assert.deepEqual(planBatches([]), []);
  });
});

describe("the estimate", () => {
  test("uses the rates typed in settings, halved for the batch, and grows with pages", () => {
    // 120 pages at $5/$25 per million, halved for the batch: in 180k–360k tokens → $0.45–$0.90;
    // out 10 documents × 4k–8k tokens → $0.50–$1.00. Low $0.95, high $1.90.
    const e = estimateCost(120, "claude-opus-5", { in: 5, out: 25 });
    assert.ok(Math.abs(e.low - 0.95) < 0.01, String(e.low));
    assert.ok(Math.abs(e.high - 1.9) < 0.01, String(e.high));
    // Untyped rates fall back to the family's list price: Sonnet under Opus, Haiku under Sonnet.
    assert.ok(estimateCost(120, "claude-haiku-4-5").high < estimateCost(120, "claude-sonnet-5").high);
    assert.ok(estimateCost(240, "claude-opus-5", { in: 5, out: 25 }).high > e.high);
    assert.ok(estimateCost(120, "claude-sonnet-5").high < e.high);
  });
});

describe("the page count", () => {
  test("counts page objects and never says zero", () => {
    assert.equal(pdfPageCount({ toString: () => "/Type /Page\n/Type /Pages\n/Type /Page\n" }), 2);
    assert.equal(pdfPageCount({ toString: () => "nothing" }), 1);
  });
});

import { searchBodyFromTerms } from "../src/lib/contract-run";

/** A scan has no words of its own; the read's cited lines become what it is searched by. */
describe("search text written back from a read", () => {
  const terms = {
    counterparty: "Example PBM",
    documentTitle: "Pharmacy Network Agreement — Rate Exhibit",
    contractType: "payer_network",
    documentRole: "exhibit",
    parentAgreement: "Pharmacy Network Agreement 2024",
    amendmentNumber: null,
    supersedes: ["Rate Exhibit 2025"],
    bins: ["610455"],
    pcns: ["MOCKPCN"],
    groupIds: [],
    chainCodes: ["605"],
    networkNames: ["Preferred"],
    networkReimbursementIds: ["PREF01"],
    pharmacyNcpdps: [],
    pharmacyNpis: [],
    contacts: [{ purpose: "mac_appeals", name: null, organisation: "Example PBM MAC desk", phone: null, fax: "800-555-0100", email: "mac@example.invalid", portalUrl: null, postalAddress: null, citation: { page: 7 } }],
    macAppealSubmissionTarget: "fax to 800-555-0100",
    keyDefinitions: [{ term: "Generic", definition: "A drug rated AB by the FDA and listed on the MAC list.", citation: { page: 3 } }],
    sections: [{ title: "Exhibit B-11", pageFrom: 5, pageTo: 6, gist: "Generic rate: lesser of MAC or AWP-25% plus $1.00." }, { title: "Term", pageFrom: null, pageTo: null, gist: "One year, evergreen." }],
    incorporatesByReference: ["Provider Manual"],
    unclearOrMissing: ["Brand rate not stated"],
  };
  test("every identifier, contact, definition and section is on its own line with its page", () => {
    const body = searchBodyFromTerms(terms);
    assert.match(body, /^\[From the read, not the scan/);
    assert.match(body, /BIN: 610455/);
    assert.match(body, /PCN: MOCKPCN/);
    assert.match(body, /Network reimbursement id: PREF01/);
    assert.match(body, /Contact for mac appeals \(page 7\): Example PBM MAC desk, fax 800-555-0100, mac@example.invalid/);
    assert.match(body, /Defines Generic \(page 3\): A drug rated AB/);
    assert.match(body, /Section Exhibit B-11 \(pages 5–6\): Generic rate/);
    assert.match(body, /Section Term \(page not given\)/);
    assert.match(body, /Not read or not stated: Brand rate not stated/);
    // Empty lists print nothing, so a search for "Group" does not hit every read.
    assert.doesNotMatch(body, /^Group:/m);
  });
});

describe("the batch ids a run left behind", () => {
  test("found in the audit lines, newest first, each once, nothing else", () => {
    const lines = [
      "3 document(s), 40 pages, 2 batch(es): msgbatch_01Newest, msgbatch_01Second; estimate $0.10–$0.40",
      null,
      "1 document(s), 3 pages, 1 batch(es): msgbatch_01Older; estimate $0.01–$0.03",
      "again: msgbatch_01Second",
      "not one: msgbatch_ and msgbatch-01Bad",
    ];
    assert.deepEqual(batchIdsIn(lines), ["msgbatch_01Newest", "msgbatch_01Second", "msgbatch_01Older"]);
    assert.deepEqual(batchIdsIn([]), []);
  });
});

describe("how many PDF pages may go to a model", () => {
  test("a million-token model reads a 150-page agreement whole", () => {
    // The reason the limit was raised at all: splitting a 150-page contract by hand is not a job
    // to hand the owner.
    assert.equal(pdfPageLimit("claude-opus-5"), 300);
    assert.ok(150 <= pdfPageLimit("claude-opus-5"));
    assert.equal(pdfPageLimit("claude-sonnet-5"), 300);
    assert.equal(pdfPageLimit("claude-fable-5-1"), 300);
  });

  test("the sort's model gets the smaller limit, because its window is two hundred thousand", () => {
    // Haiku 4.5 holds 200,000 tokens. At 3,000 a page, 150 pages is 450,000 — refused by the API
    // at 100 pages and by the model again, inside a batch already paid for.
    assert.equal(pdfPageLimit("claude-haiku-4-5-20251001"), 50);
    assert.ok(150 > pdfPageLimit("claude-haiku-4-5-20251001"), "a 150-page scan never reaches the sort");
  });

  test("a model nobody recognises gets the cautious limit", () => {
    // The model is free text in Settings. Being asked to split a long PDF is an annoyance; paying
    // for a batch that cannot succeed is not.
    assert.equal(pdfPageLimit("gpt-whatever"), PDF_PAGE_LIMIT_SHORT);
    assert.equal(pdfPageLimit(""), PDF_PAGE_LIMIT_SHORT);
    assert.equal(pdfPageLimit("  CLAUDE-OPUS-5  "), PDF_PAGE_LIMIT_LONG, "case and spacing are not a reason to refuse");
  });

  test("the unnamed-model default is the cautious one, never the generous one", () => {
    assert.equal(PDF_PAGE_LIMIT, PDF_PAGE_LIMIT_SHORT);
  });
});
