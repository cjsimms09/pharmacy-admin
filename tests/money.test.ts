import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extendedCents, formatCents, parseCents, parseQuantityThousandths, parseUnitMicros } from "../src/lib/money";

/**
 * These numbers go to the Kansas Insurance Department. Everything here is pinned, including the
 * cases that look pedantic — a rounding difference of one cent across 200 claims on a filing is
 * the sort of thing that gets the whole schedule questioned.
 */

describe("parseCents", () => {
  test("plain and formatted dollars", () => {
    assert.equal(parseCents("12.34"), 1234);
    assert.equal(parseCents("$1,234.56"), 123456);
    assert.equal(parseCents("0"), 0);
    assert.equal(parseCents(42), 4200);
  });
  test("negatives, including accounting parentheses", () => {
    assert.equal(parseCents("-4.10"), -410);
    assert.equal(parseCents("(4.10)"), -410);
  });
  test("a third decimal rounds, it does not truncate", () => {
    assert.equal(parseCents("1.005"), 101);
    assert.equal(parseCents("1.004"), 100);
  });
  test("junk is null, never zero — a claim that cannot be priced must be excluded, not priced at nothing", () => {
    for (const v of ["", "  ", "n/a", "-", ".", "abc", null, undefined]) {
      assert.equal(parseCents(v as string), null, `${JSON.stringify(v)} should be null`);
    }
  });
});

describe("parseUnitMicros", () => {
  test("NADAC publishes five decimals and all of them matter", () => {
    assert.equal(parseUnitMicros("0.03428"), 34280);
    assert.equal(parseUnitMicros("1.00000"), 1000000);
    assert.equal(parseUnitMicros("12.34567"), 12345670);
  });
  test("a sub-cent price survives", () => {
    // Rounded to the cent this would be $0.00, and 90 units would price at zero.
    assert.equal(parseUnitMicros("0.00241"), 2410);
  });
});

describe("parseQuantityThousandths", () => {
  test("whole and fractional quantities", () => {
    assert.equal(parseQuantityThousandths("30"), 30000);
    assert.equal(parseQuantityThousandths("473.176"), 473176);
    assert.equal(parseQuantityThousandths("2.5"), 2500);
  });
});

describe("extendedCents", () => {
  test("the ordinary case", () => {
    // $0.03428 per unit × 90 units = $3.0852 → $3.09
    assert.equal(extendedCents(34280, 90000), 309);
  });

  test("a fractional-mL quantity against a sub-cent unit price", () => {
    // $0.00241 × 473.176 mL = $1.14035... → $1.14
    assert.equal(extendedCents(2410, 473176), 114);
  });

  test("does not overflow on a high price and a large quantity", () => {
    // $9,999.99999 per unit × 10,000 units = $99,999,999.90.
    // The intermediate product is ~10^17, past the 9×10^15 a JS number holds exactly.
    const unitMicros = parseUnitMicros("9999.99999")!;
    const qty = parseQuantityThousandths("10000")!;
    assert.equal(unitMicros, 9_999_999_990);
    assert.equal(extendedCents(unitMicros, qty), 9_999_999_990);
    assert.equal(formatCents(extendedCents(unitMicros, qty)), "$99,999,999.90");
  });

  test("rounds half away from zero, the way a hand-check does", () => {
    // $0.005 × 1 unit = half a cent
    assert.equal(extendedCents(5000, 1000), 1);
    assert.equal(extendedCents(-5000, 1000), -1);
    // $0.004 × 1 unit
    assert.equal(extendedCents(4000, 1000), 0);
  });

  test("rounds once at the end, not per unit", () => {
    // $0.004 rounded per-unit would be $0.00 × 1000 = $0.00. Correct is $4.00.
    assert.equal(extendedCents(4000, 1_000_000), 400);
  });

  test("zero quantity is zero, not an error", () => {
    assert.equal(extendedCents(34280, 0), 0);
  });
});

describe("formatCents", () => {
  test("always two decimals, with thousands separators", () => {
    assert.equal(formatCents(1234), "$12.34");
    assert.equal(formatCents(5), "$0.05");
    assert.equal(formatCents(0), "$0.00");
    assert.equal(formatCents(123456789), "$1,234,567.89");
    assert.equal(formatCents(-410), "-$4.10");
  });
});
