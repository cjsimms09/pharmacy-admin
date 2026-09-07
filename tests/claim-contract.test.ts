import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { governs, contractFor, rateFor, priceFromRate, checkClaim, type ClaimForMatch, type ContractForMatch, type RateForMatch } from "../src/lib/claim-contract";

const rate = (a: Partial<RateForMatch> = {}): RateForMatch => ({
  network: null, daysSupplyMin: null, daysSupplyMax: null,
  brandFormula: "AWP - 15.0%", brandDispensingFee: 1, genericBasis: "MAC", genericDispensingFee: 1,
  citationQuote: "AWP less 15% plus $1.00", ...a,
});
const contract = (a: Partial<ContractForMatch> = {}): ContractForMatch => ({
  documentId: "d1", documentName: "Caremark Part D Exhibit B", counterparty: "CVS Caremark",
  bins: ["004336"], pcns: [], groupIds: [], effectiveDate: null, endDate: null, rates: [rate()], ...a,
});
const claim = (a: Partial<ClaimForMatch> = {}): ClaimForMatch => ({
  bin: "004336", pcn: "ADV", groupNumber: "RX1234", dateFilled: "2026-06-15", daysSupply: 30,
  remitCents: 8_500, awpCents: 10_000, acquisitionCents: 7_000, isBrand: true, ...a,
});

describe("which contract governs a claim", () => {
  test("a contract naming the BIN governs a claim on it", () => {
    const w = governs(contract(), claim());
    assert.deepEqual(w?.on, ["bin"]);
  });

  test("naming a narrower thing means the wider one is somebody else's contract", () => {
    // A contract written for group RX1234 does not govern the rest of the BIN.
    const narrow = contract({ groupIds: ["RX1234"] });
    assert.ok(governs(narrow, claim()));
    assert.equal(governs(narrow, claim({ groupNumber: "OTHER" })), null);
  });

  test("BIN alone is never the whole answer where the contract says more", () => {
    // One BIN carries a commercial plan and a Part D plan side by side, on different terms.
    const partD = contract({ pcns: ["ADV"] });
    assert.deepEqual(governs(partD, claim())?.on, ["bin", "pcn"]);
    assert.equal(governs(partD, claim({ pcn: "COMM" })), null);
  });

  test("case and stray spacing in a routing code are not a mismatch", () => {
    assert.ok(governs(contract({ pcns: ["adv"] }), claim({ pcn: " ADV " })));
  });

  test("a contract that names nothing routable cannot be matched to a claim", () => {
    assert.equal(governs(contract({ bins: [], pcns: [], groupIds: [] }), claim()), null);
  });

  test("an amendment signed in June does not govern a fill in March", () => {
    const june = contract({ effectiveDate: "2026-06-01" });
    assert.ok(governs(june, claim({ dateFilled: "2026-06-15" })));
    assert.equal(governs(june, claim({ dateFilled: "2026-03-15" })), null);
    const ended = contract({ endDate: "2026-05-31" });
    assert.equal(governs(ended, claim({ dateFilled: "2026-06-15" })), null);
  });

  test("the plan-specific agreement beats the network-wide one it sits under", () => {
    const network = contract({ documentName: "Network agreement", bins: ["004336"] });
    const plan = contract({ documentName: "Employer addendum", bins: ["004336"], pcns: ["ADV"], groupIds: ["RX1234"] });
    assert.equal(contractFor(claim(), [network, plan])?.contract.documentName, "Employer addendum");
    assert.equal(contractFor(claim(), [plan, network])?.contract.documentName, "Employer addendum");
  });

  test("between two equally specific contracts, the one that began most recently governs", () => {
    const old = contract({ documentName: "2025 rates", effectiveDate: "2025-01-01" });
    const now = contract({ documentName: "2026 rates", effectiveDate: "2026-01-01" });
    assert.equal(contractFor(claim(), [old, now])?.contract.documentName, "2026 rates");
  });
});

describe("which rate line covers the fill", () => {
  test("the days supply picks the band", () => {
    const c = contract({
      rates: [rate({ daysSupplyMin: 1, daysSupplyMax: 34, brandFormula: "AWP - 15.0%" }), rate({ daysSupplyMin: 35, daysSupplyMax: 90, brandFormula: "AWP - 20.0%" })],
    });
    assert.equal(rateFor(c, claim({ daysSupply: 30 }))?.brandFormula, "AWP - 15.0%");
    assert.equal(rateFor(c, claim({ daysSupply: 90 }))?.brandFormula, "AWP - 20.0%");
  });

  test("where several fit, the narrowest band wins", () => {
    // A rate written for 1 to 34 days is about this fill in a way an any-length rate is not.
    const c = contract({ rates: [rate({ brandFormula: "any length" }), rate({ daysSupplyMin: 1, daysSupplyMax: 34, brandFormula: "AWP - 15.0%" })] });
    assert.equal(rateFor(c, claim({ daysSupply: 30 }))?.brandFormula, "AWP - 15.0%");
  });

  test("a fill with no days supply falls back to the rate that states no band", () => {
    const c = contract({ rates: [rate({ daysSupplyMin: 1, daysSupplyMax: 34 }), rate({ brandFormula: "any length" })] });
    assert.equal(rateFor(c, claim({ daysSupply: null }))?.brandFormula, "any length");
  });
});

describe("what the contract says it should have paid", () => {
  test("a discount off the published price, plus the dispensing fee", () => {
    // $100.00 AWP less 15% is $85.00, plus $1.00.
    const p = priceFromRate(rate(), claim());
    assert.ok(p.ok);
    assert.equal(p.expectedCents, 8_600);
    assert.equal(p.quote, "AWP less 15% plus $1.00");
  });

  test("a mark-up off WAC is read the same way", () => {
    const p = priceFromRate(rate({ brandFormula: "WAC + 3%", brandDispensingFee: 0 }), claim());
    assert.ok(p.ok);
    assert.equal(p.expectedCents, 10_300);
  });

  test("MAC cannot be priced, and saying so is the point", () => {
    // The MAC list is not published and the argument about it is the appeal. A guessed figure would
    // create a shortfall nobody is owed, and an appeal filed on it would be withdrawn.
    const p = priceFromRate(rate(), claim({ isBrand: false }));
    assert.equal(p.ok, false);
    assert.match(p.ok === false ? p.why : "", /not published/);
  });

  test("no published price on the claim means the discount has nothing to apply to", () => {
    const p = priceFromRate(rate(), claim({ awpCents: null }));
    assert.equal(p.ok, false);
    assert.match(p.ok === false ? p.why : "", /no published price/);
  });

  test("a rate stated for the other kind of drug is not borrowed", () => {
    const p = priceFromRate(rate({ genericBasis: null }), claim({ isBrand: false }));
    assert.equal(p.ok, false);
    assert.match(p.ok === false ? p.why : "", /no rate for this kind/);
  });
});

describe("a claim checked against the contracts on file", () => {
  test("the gap between what arrived and what was owed", () => {
    // $85.00 arrived against $86.00 owed: a dollar short, on one fill.
    const r = checkClaim(claim(), [contract()]);
    assert.equal(r.matched?.documentName, "Caremark Part D Exhibit B");
    assert.equal(r.differenceCents, -100);
  });

  test("paid correctly is a difference of nothing, not a silence", () => {
    assert.equal(checkClaim(claim({ remitCents: 8_600 }), [contract()]).differenceCents, 0);
  });

  test("no contract on file for the plan says so rather than guessing", () => {
    const r = checkClaim(claim({ bin: "999999" }), [contract()]);
    assert.equal(r.matched, null);
    assert.equal(r.differenceCents, null);
  });

  test("matched but unpriceable keeps the match, so the contract is still named", () => {
    const r = checkClaim(claim({ isBrand: false }), [contract()]);
    assert.ok(r.matched, "the claim is governed by a contract even where the rate cannot be computed");
    assert.equal(r.priced?.ok, false);
    assert.equal(r.differenceCents, null);
  });
});
