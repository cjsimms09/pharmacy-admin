import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sameWholesaler } from "../src/lib/supplier-match";

/*
 * Whether two names are the same wholesaler.
 *
 * Written after the invoice proof shipped without it. On 14 September it reported ten invoices
 * "filed under a different wholesaler than the page now names", and all ten were one wholesaler
 * written two ways — nine filed IPC against pages reading "Independent Pharmacy Cooperative", one
 * filed IPD against "Independent Pharmacy Distributor". The sentence was false on ten of ten, and a
 * real ParMed-filed-under-Cardinal would have been indistinguishable from the noise.
 *
 * The check had been written twice, in the proof and in drug-cost-source.ts, and both copies missed
 * the same case. One function now, and these are its cases.
 */

describe("the ten that were wrong", () => {
  test("IPC is Independent Pharmacy Cooperative", () => {
    // 11490216, 11490227, 11493051, 11493052, 11495629, 11495630, 11497542, 11497543, CM107761.
    assert.equal(sameWholesaler("IPC", "Independent Pharmacy Cooperative"), true);
    assert.equal(sameWholesaler("Independent Pharmacy Cooperative", "IPC"), true, "and in either order");
  });

  test("IPD is Independent Pharmacy Distributor", () => {
    // 1008931.
    assert.equal(sameWholesaler("IPD", "Independent Pharmacy Distributor"), true);
  });

  test("and the two of them are still not each other", () => {
    // The acronyms differ by one letter and the expansions by one word. Collapsing these would
    // trade ten false alarms for a silence that hides a genuine misfiling.
    assert.equal(sameWholesaler("IPC", "IPD"), false);
    assert.equal(sameWholesaler("IPC", "Independent Pharmacy Distributor"), false);
    assert.equal(sameWholesaler("Independent Pharmacy Cooperative", "Independent Pharmacy Distributor"), false);
  });
});

describe("the fault it exists to catch", () => {
  test("ParMed filed under Cardinal is a real disagreement", () => {
    // 10 September: ParMed is a Cardinal Health company and was not on the name list, so its
    // invoices filed under a wholesaler this pharmacy does not buy from.
    assert.equal(sameWholesaler("ParMed", "Cardinal Health"), false);
    assert.equal(sameWholesaler("PARMED PHARMACEUTICALS", "Cardinal Health"), false);
  });

  test("two unrelated wholesalers disagree", () => {
    assert.equal(sameWholesaler("McKesson", "ANDA"), false);
    assert.equal(sameWholesaler("Kinray", "Cardinal Health"), false, "a subsidiary is not its parent here either");
  });
});

describe("the same company written longer", () => {
  test("a prefix of at least four characters is the same company", () => {
    assert.equal(sameWholesaler("ParMed", "PARMED PHARMACEUTICALS"), true);
    assert.equal(sameWholesaler("McKesson", "McKesson Corporation"), true);
    assert.equal(sameWholesaler("mckesson connect", "McKesson"), true);
  });

  test("a prefix shorter than four characters is a coin toss and is refused", () => {
    /*
     * The rule `rateForSupplier` above was given for the same reason: two- and three-letter names
     * appear inside unrelated company names often enough that the test alone proves nothing.
     */
    assert.equal(sameWholesaler("AND", "ANDA"), false);
    assert.equal(sameWholesaler("HD", "HD Smith"), false);
  });

  test("punctuation and case are not a difference", () => {
    assert.equal(sameWholesaler("par-med, inc.", "PARMED"), true);
    assert.equal(sameWholesaler("  McKesson  ", "mckesson"), true);
  });
});

describe("what it will not claim", () => {
  test("a name nobody recorded cannot disagree with one that was", () => {
    assert.equal(sameWholesaler(null, "McKesson"), true);
    assert.equal(sameWholesaler("McKesson", ""), true);
    assert.equal(sameWholesaler(undefined, undefined), true);
  });

  test("initials need two real words, so a stray letter does not form one", () => {
    // "J M Smith" must not collapse to something that matches half the register.
    assert.equal(sameWholesaler("JMS", "J M Smith"), false);
    assert.equal(sameWholesaler("M", "McKesson"), false);
  });

  test("an acronym is not matched against a single word", () => {
    assert.equal(sameWholesaler("MC", "McKesson"), false);
  });
});
