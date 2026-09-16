import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { linksToLearn, type ClaimKey, type PayerLinkRow } from "../src/lib/payer-links";

/**
 * What a remittance teaches the site about who a BIN belongs to.
 *
 * The owner, 16 September 2026: "does our system get smarter and learn to attach bin/pcn or scripts
 * to payors once we start getting more 835s?? the system needs to learn." Until this, every one of
 * the 141 links on file had been taught by a person; an 835 naming its payer and settling a claim
 * whose BIN nobody had identified taught the site nothing.
 */

const key = (over: Partial<ClaimKey> = {}): ClaimKey => ({ bin: "610014", pcn: null, groupNumber: null, contractId: null, ...over });
const link = (over: Partial<PayerLinkRow>): Pick<PayerLinkRow, "bin" | "pcn" | "groupNumber" | "contractId"> =>
  ({ bin: null, pcn: null, groupNumber: null, contractId: null, ...over }) as PayerLinkRow;

describe("learning a payer from the remittances that paid it", () => {
  test("a payer that paid claims on an unidentified BIN is learned", () => {
    const { learn } = linksToLearn([{ key: key(), payer: "MedImpact" }, { key: key(), payer: "MedImpact" }], []);
    assert.equal(learn.length, 1, "one key, one link, however many payments taught it");
    assert.equal(learn[0].payer, "MedImpact");
    assert.equal(learn[0].key.bin, "610014");
  });

  test("a key somebody has already linked is left alone", () => {
    /* A person's decision outranks a machine's inference, and getting that backwards fails silently. */
    const { learn } = linksToLearn([{ key: key(), payer: "MedImpact" }], [link({ bin: "610014" })]);
    assert.deepEqual(learn, []);
  });

  test("a more specific key is still learned where only the general one is known", () => {
    const { learn } = linksToLearn([{ key: key({ pcn: "ASPROD1", groupNumber: "RX8899" }), payer: "Caremark" }], [link({ bin: "999999" })]);
    assert.equal(learn.length, 1);
    assert.equal(learn[0].key.groupNumber, "RX8899");
  });

  test("two payers on one key teaches nothing, and says it taught nothing", () => {
    /*
     * The shape of a processor fronting several plans, which is exactly where one name would be
     * wrong. Refused, counted, and left for a person.
     */
    const r = linksToLearn([{ key: key(), payer: "MedImpact" }, { key: key(), payer: "Prime Therapeutics" }], []);
    assert.deepEqual(r.learn, []);
    assert.equal(r.conflicting, 1);
  });

  test("a payment naming no payer teaches nothing", () => {
    assert.deepEqual(linksToLearn([{ key: key(), payer: null }, { key: key(), payer: "  " }], []).learn, []);
  });

  test("a claim carrying no identifier at all is refused, because that link would match everything", () => {
    const { learn } = linksToLearn([{ key: { bin: null, pcn: "ASPROD1", groupNumber: null, contractId: null }, payer: "Caremark" }], []);
    assert.deepEqual(learn, [], "a PCN alone is not an identity");
  });

  test("the same key spelled differently is one key", () => {
    const { learn } = linksToLearn([{ key: key({ bin: " 610014 " }), payer: "MedImpact" }, { key: key({ bin: "610014" }), payer: "MedImpact" }], []);
    assert.equal(learn.length, 1);
  });
});
