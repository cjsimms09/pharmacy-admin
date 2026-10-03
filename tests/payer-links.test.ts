import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchScore, linkFor } from "../src/lib/payer-links";

/**
 * Which confirmed link applies to a claim.
 *
 * A BIN identifies a processor, not a plan. One BIN can front a dozen employers on a dozen
 * different contracts, and that is exactly the case where being wrong matters: an appeal filed
 * against the wrong agreement is worse than no appeal at all. So the most specific link wins, and a
 * link that pins nothing down matches nothing rather than everything.
 */
const link = (over: Partial<Parameters<typeof matchScore>[0]> = {}) => ({
  bin: null,
  pcn: null,
  groupNumber: null,
  contractId: null,
  ...over,
});

describe("matching a claim to a confirmed link", () => {
  const key = { bin: "610011", pcn: "IRX", groupNumber: "RX1699", contractId: "CNTRCT1010" };

  test("a field the link leaves blank matches anything", () => {
    assert.equal(matchScore(link({ bin: "610011" }), key), 1);
  });

  test("a field the link sets must agree", () => {
    assert.equal(matchScore(link({ bin: "610011", groupNumber: "OTHER" }), key), null);
  });

  test("the more it pins down, the higher it scores", () => {
    assert.equal(matchScore(link({ bin: "610011", groupNumber: "RX1699", contractId: "CNTRCT1010" }), key), 3);
  });

  test("a link that pins nothing down matches nothing, not everything", () => {
    assert.equal(matchScore(link(), key), null);
  });

  test("case and spacing do not decide who a payer is", () => {
    assert.equal(matchScore(link({ pcn: " irx " }), key), 1);
  });

  test("the most specific link wins, which is the whole reason to keep both", () => {
    // One BIN, two employers on two contracts. The general row would send an appeal to the wrong
    // agreement for the plan the specific row names.
    const links = [
      { id: "general", bin: "610011", pcn: null, groupNumber: null, contractId: null, pbmName: "Optum Rx" },
      { id: "specific", bin: "610011", pcn: null, groupNumber: "RX1699", contractId: null, pbmName: "Optum Rx — City of Wichita" },
    ] as unknown as Parameters<typeof linkFor>[0];
    assert.equal(linkFor(links, key)?.pbmName, "Optum Rx — City of Wichita");
    assert.equal(linkFor(links, { ...key, groupNumber: "SOMETHINGELSE" })?.pbmName, "Optum Rx");
  });

  test("nothing matches where nothing was confirmed", () => {
    assert.equal(linkFor([], key), null);
  });
});
