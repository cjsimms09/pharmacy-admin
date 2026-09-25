import test from "node:test";
import assert from "node:assert/strict";
import { resolveContract, type ClaimForMatch, type ContractForMatch } from "../src/lib/claim-contract";

/*
 * Nought of 1,081 insured claims matched a contract, and the cause was structural: claims speak in
 * codes (network id on 95.3% of rows across 82 values), rate exhibits identify themselves by
 * network name and chain code with BIN, PCN and group empty, and governs() reads only the triple.
 * Both sides were complete and neither could see the other.
 */

const claim = (o: Partial<ClaimForMatch> = {}): ClaimForMatch => ({
  bin: "610455", pcn: "KSPDP", groupNumber: "GRP1", dateFilled: "2026-06-15",
  daysSupply: 30, remitCents: 1000, awpCents: null, acquisitionCents: null, isBrand: false, ...o,
});

const contract = (o: Partial<ContractForMatch> = {}): ContractForMatch => ({
  documentId: "doc1", documentName: "Prime AccessOne 2026", counterparty: "Prime",
  bins: [], pcns: [], groupIds: [], networkReimbursementIds: [],
  effectiveDate: "2026-01-01", endDate: null, rates: [], ...o,
});

test("the owner's link outranks everything, and says whose answer it is", () => {
  const r = resolveContract({
    claim: claim({ networkId: "PRIMEACCESS1" }),
    contracts: [contract(), contract({ documentId: "doc2", documentName: "Other", bins: ["610455"], pcns: ["KSPDP"], groupIds: ["GRP1"] })],
    links: [{ networkId: "PRIMEACCESS1", contractDocId: "doc1", setBy: "Cory Simms" }],
  });
  assert.equal(r.matched, true);
  if (!r.matched) return;
  assert.equal(r.rung, "owner_link");
  assert.equal(r.contract.documentId, "doc1", "a person who knows outranks a triple that matches");
  assert.match(r.says, /Cory Simms/);
});

test("a document that states the network id matches, where no link is set", () => {
  const r = resolveContract({
    claim: claim({ networkId: "PRIMEACCESS1" }),
    contracts: [contract({ networkReimbursementIds: ["PRIMEACCESS1"] })],
  });
  assert.equal(r.matched, true);
  if (!r.matched) return;
  assert.equal(r.rung, "network_id");
  assert.equal(r.confident, true);
});

test("the routing still answers when there is no network id at all — nothing regressed", () => {
  const r = resolveContract({
    claim: claim({ networkId: null }),
    contracts: [contract({ bins: ["610455"], pcns: ["KSPDP"], groupIds: ["GRP1"] })],
  });
  assert.equal(r.matched, true);
  if (!r.matched) return;
  assert.equal(r.rung, "routing");
  assert.equal(r.why?.specificity, 3);
});

test("a rate exhibit with no routing and no id matches nothing, and names the id to fix it", () => {
  // This is the shape that produced 0 of 1,081: name and chain code only.
  const r = resolveContract({ claim: claim({ networkId: "PRIMEACCESS1" }), contracts: [contract()] });
  assert.equal(r.matched, false);
  if (r.matched) return;
  assert.equal(r.networkId, "PRIMEACCESS1");
  assert.equal(r.settleable, true, "one choice on the payers page settles every claim on this id");
  assert.match(r.says, /payers page/);
});

test("a name is never matched, however alike the two look", () => {
  // "Prime AccessOne 2026" against a Prime claim: no id, no routing, no match. On purpose.
  const r = resolveContract({
    claim: claim({ bin: null, pcn: null, groupNumber: null, networkId: "PRIMEACCESS1" }),
    contracts: [contract({ counterparty: "PRIME THERAPEUTICS" })],
  });
  assert.equal(r.matched, false);
});

test("a link to a contract not in force on the fill date does not match, and says which way it is wrong", () => {
  const r = resolveContract({
    claim: claim({ dateFilled: "2025-03-01", networkId: "PRIMEACCESS1" }),
    contracts: [contract({ effectiveDate: "2026-01-01" })],
    links: [{ networkId: "PRIMEACCESS1", contractDocId: "doc1" }],
  });
  assert.equal(r.matched, false);
  if (r.matched) return;
  assert.match(r.says, /in force|predates/i);
});

test("two links disagreeing is surfaced, never silently resolved", () => {
  const r = resolveContract({
    claim: claim({ networkId: "PRIMEACCESS1" }),
    contracts: [contract(), contract({ documentId: "doc2", documentName: "Second" })],
    links: [
      { networkId: "PRIMEACCESS1", contractDocId: "doc1" },
      { networkId: "PRIMEACCESS1", contractDocId: "doc2" },
    ],
  });
  assert.equal(r.matched, false);
  if (r.matched) return;
  assert.match(r.says, /2 different contracts/);
  assert.match(r.says, /One of those links is wrong/);
});

test("two documents claiming one network id is contradictory paperwork, not a tie to break", () => {
  const r = resolveContract({
    claim: claim({ networkId: "SHARED" }),
    contracts: [
      contract({ networkReimbursementIds: ["SHARED"] }),
      contract({ documentId: "doc2", documentName: "Second", networkReimbursementIds: ["SHARED"] }),
    ],
  });
  assert.equal(r.matched, false);
  if (r.matched) return;
  assert.match(r.says, /2 contracts state network SHARED/);
});

test("a link pointing at a document no longer on file says so rather than falling through silently", () => {
  const r = resolveContract({
    claim: claim({ networkId: "PRIMEACCESS1" }),
    contracts: [contract()],
    links: [{ networkId: "PRIMEACCESS1", contractDocId: "deleted-doc" }],
  });
  assert.equal(r.matched, false);
  if (r.matched) return;
  assert.match(r.says, /no longer on file/);
});

test("a claim with no network id and no routing match cannot be settled by linking, and says so", () => {
  const r = resolveContract({ claim: claim({ bin: null, pcn: null, groupNumber: null, networkId: null }), contracts: [contract()] });
  assert.equal(r.matched, false);
  if (r.matched) return;
  assert.equal(r.settleable, false, "there is nothing for the owner to choose here");
  assert.match(r.says, /has to be filed first/);
});

test("the network id is compared as a code, not as typed — case and spacing do not decide money", () => {
  const r = resolveContract({
    claim: claim({ networkId: " primeaccess1 " }),
    contracts: [contract({ networkReimbursementIds: ["PRIMEACCESS1"] })],
  });
  assert.equal(r.matched, true);
});

/*
 * The candidate list is the one place a name is allowed near this problem, because nothing here
 * decides anything — it orders a short list for a person who knows the answer. Contracts identify
 * themselves by network name and chain code (63 and 39 of the first 86 documents read); 5 carry a
 * BIN and none a network reimbursement id. So the owner's choice is the mechanism, and this is what
 * makes it one click rather than a search.
 */

test("the payer the BIN resolves to comes first, and the reason is said", () => {
  const { candidatesFor } = require("../src/lib/claim-contract");
  const out = candidatesFor({
    networkId: "BIDBRODCBR",
    payerName: "Prime Therapeutics",
    contracts: [
      contract({ documentId: "a", documentName: "Caremark 2026", counterparty: "CVS Caremark" }),
      contract({ documentId: "b", documentName: "Prime AccessOne 2026", counterparty: "Prime Therapeutics" }),
    ],
  });
  assert.equal(out[0].documentId, "b");
  assert.match(out[0].why, /resolves to/);
});

test("a document is never offered for a day it cannot govern", () => {
  const { candidatesFor } = require("../src/lib/claim-contract");
  const out = candidatesFor({
    networkId: "EN45", payerName: null, on: "2025-03-01",
    contracts: [contract({ documentId: "a", effectiveDate: "2026-01-01" })],
  });
  assert.equal(out.length, 0, "offering a contract that cannot govern the claim is a wrong answer with a tick box beside it");
});

test("every candidate carries its network names, which is what the owner recognises", () => {
  const { candidatesFor } = require("../src/lib/claim-contract");
  const out = candidatesFor({
    networkId: "MRRETM", payerName: null,
    contracts: [contract({ documentId: "a", networkNames: ["MedImpact Retail Mail"] } as never)],
  });
  assert.deepEqual(out[0].networkNames, ["MedImpact Retail Mail"]);
});
