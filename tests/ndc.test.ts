import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeNdc, candidatesFor10, resolveNdc10, readNdc, formatNdc11, isNdc11 } from "../src/lib/ndc";

/**
 * One converter for every feed. The tests pin the three FDA layouts, and — the reason the module
 * exists — that a ten-digit code with no hyphens is never padded on a guess.
 */
/** The eleven-digit code, or the reason there is none. */
const read = (v: string | number | null) => {
  const r = normalizeNdc(v);
  return r.ok ? r.ndc11 : r.reason;
};

describe("the forms an NDC arrives in", () => {
  test("eleven digits, with or without hyphens, is already canonical", () => {
    assert.deepEqual(normalizeNdc("50242004062"), { ok: true, ndc11: "50242004062", form: "11-digit" });
    assert.deepEqual(normalizeNdc("50242-0040-62"), { ok: true, ndc11: "50242004062", form: "11-digit-hyphenated" });
  });

  test("each hyphenated ten-digit layout pads the segment the hyphens say to pad", () => {
    assert.equal(read("0002-1433-80"), "00002143380");
    assert.equal(read("50242-040-62"), "50242004062");
    assert.equal(read("60505-2503-4"), "60505250304");
  });

  test("whitespace and the apostrophe Excel leaves in front of a number are ignored", () => {
    assert.equal(read("  '50242004062 "), "50242004062");
    assert.equal(read(" 0002-1433-80 "), "00002143380");
  });

  test("a numeric cell is fine while it still has eleven digits, and wrong once it has lost a zero", () => {
    assert.equal(normalizeNdc(50242004062).ok, true);
    const lost = normalizeNdc(2143380); // "00002143380" after a spreadsheet stripped the zeros
    assert.equal(lost.ok, false);
    assert.equal(!lost.ok && lost.reason, "wrong length");
  });

  test("ten digits with no hyphens is refused, with the three products it could be", () => {
    const r = normalizeNdc("5024204062");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "ten digits with no hyphens: ambiguous");
      assert.deepEqual(r.candidates, ["05024204062", "50242004062", "50242040602"]);
    }
  });

  test("everything else is refused with a specific reason", () => {
    assert.equal(read(""), "empty");
    assert.equal(read(null), "empty");
    assert.equal(read("ABC"), "not a number");
    assert.equal(read("123456789"), "wrong length");
    assert.equal(read("123456789012"), "wrong length");
    assert.equal(read("1234-5678"), "hyphens in no known layout");
    assert.equal(read("123-4567-890"), "hyphens in no known layout");
    assert.equal(read("12345-6789-012"), "hyphens in no known layout");
    assert.equal(read("1234A-5678-90"), "hyphens in no known layout");
  });
});

describe("settling a bare ten-digit code against what is held", () => {
  test("exactly one known candidate is the answer", () => {
    const held = new Set(["50242004062"]);
    const r = resolveNdc10("5024204062", (n) => held.has(n));
    assert.deepEqual(r, { ok: true, ndc11: "50242004062", form: "10-digit-resolved" });
  });

  test("none known is not an answer, and neither is two", () => {
    assert.equal(resolveNdc10("5024204062", () => false).ok, false);
    const two = new Set(["50242004062", "05024204062"]);
    assert.equal(resolveNdc10("5024204062", (n) => two.has(n)).ok, false);
  });

  test("candidatesFor10 refuses anything that is not ten digits", () => {
    assert.throws(() => candidatesFor10("123"));
    assert.throws(() => candidatesFor10("5024204062x"));
  });
});

describe("readNdc, the one call the readers make", () => {
  test("returns the code and no reason on success", () => {
    assert.deepEqual(readNdc("0002-1433-80"), { ndc11: "00002143380", reason: null, form: "10-digit-4-4-2" });
  });

  test("resolves a bare ten-digit code when a lookup is given and it settles the question", () => {
    const held = new Set(["50242004062"]);
    assert.deepEqual(readNdc("5024204062", (n) => held.has(n)), { ndc11: "50242004062", reason: null, form: "10-digit-resolved" });
  });

  test("leaves a bare ten-digit code unresolved, with the reason, when nothing settles it", () => {
    const r = readNdc("5024204062");
    assert.equal(r.ndc11, null);
    assert.match(r.reason ?? "", /10-digit NDC with no hyphens/);
    const r2 = readNdc("5024204062", () => false);
    assert.equal(r2.ndc11, null);
  });

  test("never pads a ten-digit code with a leading zero on its own", () => {
    // The exact behaviour the old readers had. "0" + digits is only one of three possibilities.
    const r = readNdc("5024204062");
    assert.notEqual(r.ndc11, "05024204062");
  });
});

describe("display", () => {
  test("hyphenates canonical codes and leaves anything else alone", () => {
    assert.equal(formatNdc11("50242004062"), "50242-0040-62");
    assert.equal(formatNdc11("not-an-ndc"), "not-an-ndc");
    assert.equal(isNdc11("50242004062"), true);
    assert.equal(isNdc11("5024200406"), false);
  });
});
