import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * Tracing a BIN to the contract that covers it.
 *
 * The search runs from the claims to the contracts, never the other way round. Pulling six-digit
 * numbers out of a PDF and calling them BINs would map amounts, dates and section numbers onto
 * payers, and a BIN wrongly attributed is worse than an unnamed one: an appeal sent to the wrong
 * PBM is a rate the pharmacy then believes it has challenged.
 *
 * The matching itself is what is worth testing by hand — in particular that a BIN printed with
 * punctuation in a contract still matches the plain digits on a claim.
 */
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function countAndSnip(hay: string, needle: string, terse = false): { matches: number; snippets: string[] } {
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  const snippets: string[] = [];
  let matches = 0;
  let at = h.indexOf(n);
  while (at !== -1) {
    matches++;
    if (snippets.length < 3) {
      const from = Math.max(0, at - (terse ? 40 : 120));
      const to = Math.min(hay.length, at + needle.length + (terse ? 40 : 120));
      snippets.push(clean(hay.slice(from, to)));
    }
    at = h.indexOf(n, at + n.length);
    if (matches > 500) break;
  }
  return { matches, snippets };
}

/** The same two-pass match the search does, without a database behind it. */
function hits(body: string, needle: string) {
  const direct = countAndSnip(body, needle);
  const flatNeedle = needle.replace(/[^0-9A-Za-z]/g, "");
  const loose =
    direct.matches === 0 && flatNeedle.length >= 5
      ? countAndSnip(body.replace(/[^0-9A-Za-z]/g, ""), flatNeedle, true)
      : { matches: 0, snippets: [] as string[] };
  return { matches: direct.matches + loose.matches, snippets: [...direct.snippets, ...loose.snippets] };
}

describe("finding a BIN in a contract", () => {
  const contract =
    "SCHEDULE A — PARTICIPATING NETWORKS\n" +
    "The Provider shall submit claims for Commercial members using BIN 610011 and PCN IRX.\n" +
    "Medicare Part D claims shall be submitted using BIN 610-014, PCN MEDDPRIME.\n" +
    "Reimbursement for generic drugs shall be the lesser of MAC, U&C, or AWP less 82%.";

  test("a plain BIN is found, with the sentence around it", () => {
    const r = hits(contract, "610011");
    assert.equal(r.matches, 1);
    assert.match(r.snippets[0], /Commercial members using BIN 610011 and PCN IRX/);
  });

  test("a BIN printed with punctuation still matches the digits on a claim", () => {
    // The contract writes 610-014; the claim carries 610014. They are the same payer.
    const r = hits(contract, "610014");
    assert.equal(r.matches, 1);
    assert.match(r.snippets[0], /610014/);
  });

  test("a PCN is found the same way", () => {
    assert.equal(hits(contract, "MEDDPRIME").matches, 1);
    assert.equal(hits(contract, "meddprime").matches, 1, "case does not matter");
  });

  test("a BIN that is not in the contract is not reported as being in it", () => {
    assert.equal(hits(contract, "003858").matches, 0);
  });

  test("a scan with no text layer yields nothing rather than a false negative elsewhere", () => {
    assert.equal(hits("", "610011").matches, 0);
  });
});
