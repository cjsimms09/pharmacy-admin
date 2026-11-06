import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { supplierNamedOn } from "../src/lib/invoices";

/*
 * Who sent an invoice, read off the page.
 *
 * The owner, 10 September: "I believe it labeled the parmed invoice as cardinal." He was right.
 * ParMed Pharmaceuticals is a Cardinal Health company, its paper carries Cardinal's name, ParMed
 * was not on the list at all and CARDINAL was — so every ParMed invoice was filed under a
 * wholesaler this pharmacy does not buy from, and its stock was timed for return against the wrong
 * supplier's policy or against none.
 */

describe("a subsidiary's own name beats its parent's", () => {
  test("a ParMed invoice carrying Cardinal Health's letterhead reads as ParMed", () => {
    const page = [
      "Cardinal Health",
      "7000 Cardinal Place, Dublin OH 43017",
      "ParMed Pharmaceuticals",
      "INVOICE DATE PAYER # SHIPPED ON 09/09/2026 2057167199 09/09/2026",
    ].join("\n");
    assert.equal(supplierNamedOn(page)?.toUpperCase().replace(/\s/g, ""), "PARMED");
  });

  test("the parent's name appearing first on the page does not win", () => {
    /*
     * The reason adding the name was not on its own enough. The list used to be one alternation
     * matched against the first line containing any of it, and an alternation matches at the
     * earliest position rather than in the order written — so Cardinal, printed above ParMed, would
     * have answered Cardinal however the alternatives were ordered. Each name is now its own pass.
     */
    assert.match(supplierNamedOn("CARDINAL HEALTH\nPARMED PHARMACEUTICALS")!, /par ?med/i);
    assert.match(supplierNamedOn("PARMED PHARMACEUTICALS\nCARDINAL HEALTH")!, /par ?med/i);
  });

  test("Kinray is Cardinal's too, and is read as Kinray", () => {
    assert.match(supplierNamedOn("Cardinal Health\nKinray Distribution")!, /kinray/i);
  });

  test("a genuine Cardinal invoice with no subsidiary on it still reads as Cardinal", () => {
    assert.match(supplierNamedOn("CARDINAL HEALTH 110 LLC\nInvoice No: 4471203")!, /cardinal/i);
  });

  test("ParMed written as two words is the same company", () => {
    assert.match(supplierNamedOn("PAR MED PHARMACEUTICALS")!, /par ?med/i);
  });
});

describe("the suppliers this pharmacy actually buys from", () => {
  test("each is recognised on its own", () => {
    assert.match(supplierNamedOn("MCKESSON DRUG CO")!, /mckesson/i);
    assert.match(supplierNamedOn("Independent Pharmacy Cooperative")!, /Independent Pharmacy Cooperative/i);
    assert.match(supplierNamedOn("Independent Pharmacy Distributor")!, /Independent Pharmacy Distributor/i);
    assert.match(supplierNamedOn("ANDA INC")!, /anda/i);
    assert.match(supplierNamedOn("ParMed Pharmaceuticals")!, /par ?med/i);
  });

  test("IPD and IPC print their names in full and are not confused with each other", () => {
    assert.match(supplierNamedOn("Independent Pharmacy Distributor")!, /Distributor/i);
    assert.match(supplierNamedOn("Independent Pharmacy Cooperative")!, /Cooperative/i);
  });
});

describe("what it refuses to name", () => {
  test("a page naming no wholesaler answers null rather than guessing", () => {
    // Null flows to the sender-matched name, and to "sender unknown" where there is none. A wrong
    // name is worse than no name: it files the invoice under a supplier and times its stock there.
    assert.equal(supplierNamedOn("INVOICE\nThank you for your business\nTotal 100.00"), null);
    assert.equal(supplierNamedOn(""), null);
  });

  test("the word inside another word is not a supplier", () => {
    assert.equal(supplierNamedOn("ANDANTE SOLUTIONS LLC"), null, "ANDA must not match inside ANDANTE");
    assert.equal(supplierNamedOn("CARDINALITY LTD"), null);
  });
});
