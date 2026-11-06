import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseGs1, parseGs1Elements, gs1Date, ndc11Candidates, ndcFromGtin, validGtin, gtinCheckDigit, GS } from "../src/lib/gs1";

/**
 * Reading a drug package's barcode, and refusing to read one wrongly.
 *
 * The failure that matters here is silent. A lot number with the serial glued onto the end is a
 * plausible string in a field that accepts plausible strings, and it would be recorded, backed up
 * and produced during a recall as though it were true. So most of what follows is about the ways
 * this must refuse.
 */

/** A GTIN built from a ten-digit NDC the way a US drug package is: indicator, "03", NDC, check. */
function gtinFor(ndc10: string, indicator = "0"): string {
  const first13 = `${indicator}03${ndc10}`;
  return first13 + String(gtinCheckDigit(first13));
}

const NDC10 = "0378395293";
const GTIN = gtinFor(NDC10);

describe("the check digit", () => {
  test("a GTIN we built is one that checks out", () => {
    assert.ok(validGtin(GTIN));
  });

  test("a single mistyped digit is caught", () => {
    const wrong = GTIN.slice(0, 5) + String((Number(GTIN[5]) + 1) % 10) + GTIN.slice(6);
    assert.ok(!validGtin(wrong), "a transposed digit passed the check");
  });

  test("anything not fourteen digits is not a GTIN", () => {
    assert.ok(!validGtin("003037839529"));
    assert.ok(!validGtin("00303783952931X"));
  });
});

describe("the NDC inside the GTIN", () => {
  test("comes out of a drug package identifier", () => {
    assert.deepEqual(ndcFromGtin(GTIN), { ndc10: NDC10, packagingLevel: "0" });
  });

  test("a case carries the same NDC at a different packaging level", () => {
    const caseGtin = gtinFor(NDC10, "5");
    assert.deepEqual(ndcFromGtin(caseGtin), { ndc10: NDC10, packagingLevel: "5" });
  });

  test("a GTIN that is not a US drug identifier yields nothing rather than ten digits from the middle", () => {
    // A grocery item: valid GTIN, no "03" in the right place.
    const first13 = "0012345678905";
    const notADrug = first13 + String(gtinCheckDigit(first13));
    assert.equal(ndcFromGtin(notADrug), null);
  });
});

describe("ten digits cannot say where the hyphens went", () => {
  test("every configuration is offered and none is chosen", () => {
    const c = ndc11Candidates("0378395293");
    assert.ok(c.includes("00378395293"), "4-4-2 missing");
    assert.ok(c.includes("03783095293"), "5-3-2 missing");
    assert.ok(c.includes("03783952903"), "5-4-1 missing");
    assert.equal(c.length, 3);
  });

  test("identical candidates are not offered twice", () => {
    const c = ndc11Candidates("0000000000");
    assert.equal(new Set(c).size, c.length);
  });

  test("nothing is produced from something that is not ten digits", () => {
    assert.deepEqual(ndc11Candidates("12345"), []);
    assert.deepEqual(ndc11Candidates("abcdefghij"), []);
  });
});

describe("the expiry date", () => {
  test("an ordinary date reads as itself", () => {
    assert.equal(gs1Date("270331"), "2027-03-31");
  });

  test("day zero means the last day of that month, which is what GS1 says", () => {
    assert.equal(gs1Date("270200"), "2027-02-28");
    assert.equal(gs1Date("280200"), "2028-02-29", "a leap year was not handled");
    assert.equal(gs1Date("271100"), "2027-11-30");
  });

  test("an impossible date is refused rather than rolled over", () => {
    // Date() would happily turn 31 February into 3 March. That would be a wrong expiry recorded
    // as a real one, which is the whole class of failure this file exists to avoid.
    assert.equal(gs1Date("270231"), null);
    assert.equal(gs1Date("271301"), null);
    assert.equal(gs1Date("27033"), null);
  });
});

describe("reading a whole barcode", () => {
  const raw = `01${GTIN}17270331${GS}10ABC123${GS}21SN00099`;

  test("the four things DSCSA puts on a package all come out", () => {
    const p = parseGs1(raw);
    assert.equal(p.gtin, GTIN);
    assert.equal(p.ndc10, NDC10);
    assert.equal(p.expiry, "2027-03-31");
    assert.equal(p.lot, "ABC123");
    assert.equal(p.serial, "SN00099");
    assert.deepEqual(p.problems, []);
    assert.equal(p.complete, true);
  });

  test("the symbology identifier a scanner prefixes is ignored", () => {
    assert.deepEqual(parseGs1(`]d2${raw}`), parseGs1(raw));
  });

  test("fields in a different order still read", () => {
    const other = `01${GTIN}21SN00099${GS}17270331${GS}10ABC123`;
    const p = parseGs1(other);
    assert.equal(p.serial, "SN00099");
    assert.equal(p.lot, "ABC123");
    assert.equal(p.expiry, "2027-03-31");
  });

  test("a variable field at the very end needs no separator", () => {
    const p = parseGs1(`01${GTIN}17270331${GS}21SN1${GS}10LOT9`);
    assert.equal(p.lot, "LOT9");
    assert.deepEqual(p.problems, []);
  });
});

describe("what it refuses to read", () => {
  test("a scanner that strips the separator does not produce a lot with the serial glued on", () => {
    // This is the failure this file exists for. Without the separator "10ABC12321SN00099" reads
    // as a lot of "ABC12321SN00099" — plausible, wrong, and recorded for ever.
    const p = parseGs1(`01${GTIN}1727033110ABC12321SN00099`);
    // It cannot be unscrambled — a lot number may contain digits, so there is no way to know
    // where it ended. So nothing is kept, and the raw text goes in the message for a human.
    assert.equal(p.lot, null, "a run-together lot number was kept");
    assert.equal(p.serial, null);
    assert.equal(p.complete, false);
    assert.match(p.problems.join(" "), /separator/i);
    assert.match(p.problems.join(" "), /ABC12321SN00099/, "the message should show what was read");
    // The fixed-length fields either side of it are unaffected and still usable.
    assert.equal(p.gtin, GTIN);
    assert.equal(p.expiry, "2027-03-31");
  });

  test("an application identifier it does not know stops the parse rather than mis-slicing", () => {
    const p = parseGs1(`01${GTIN}9917270331`);
    assert.ok(p.problems.some((x) => /not an application identifier/i.test(x)));
    assert.equal(p.expiry, null, "a value was taken from the wrong place");
  });

  test("a truncated fixed-length field is reported", () => {
    const p = parseGs1(`01${GTIN}172703`);
    assert.ok(p.problems.some((x) => /cut short/i.test(x)));
  });

  test("a misread product identifier is refused, not carried", () => {
    const bad = GTIN.slice(0, 13) + String((Number(GTIN[13]) + 1) % 10);
    const p = parseGs1(`01${bad}17270331${GS}10L1${GS}21S1`);
    assert.equal(p.gtin, null);
    assert.equal(p.ndc10, null);
    assert.ok(p.problems.some((x) => /does not check out/i.test(x)));
  });

  test("a case is flagged as a case, because its serial is not the bottle's", () => {
    const p = parseGs1(`01${gtinFor(NDC10, "5")}17270331${GS}10L1${GS}21S1`);
    assert.equal(p.packagingLevel, "5");
    assert.ok(p.problems.some((x) => /case or outer carton/i.test(x)));
  });

  test("an over-long variable field is caught even where a separator follows", () => {
    const p = parseGs1(`01${GTIN}10${"X".repeat(25)}${GS}21S1`);
    assert.ok(p.problems.some((x) => /longer than/i.test(x)));
  });

  test("a lot with no serial and no separator is flagged rather than trusted", () => {
    // Legitimately separator-free, and legitimately not a complete DSCSA identifier. Saying so
    // costs nothing and is the same message that catches the misconfigured scanner.
    const p = parseGs1(`01${GTIN}1727033110ABC123`);
    assert.equal(p.lot, null);
    assert.match(p.problems.join(" "), /separator/i);
  });

  test("nothing at all is not a crash", () => {
    const p = parseGs1("");
    assert.equal(p.gtin, null);
    assert.equal(p.complete, false);
  });

  test("a package missing any of the four is not complete", () => {
    const p = parseGs1(`01${GTIN}17270331${GS}10ABC123`);
    assert.equal(p.serial, null);
    assert.equal(p.complete, false, "a package with no serial number read as complete");
  });
});

describe("anything else on the symbol is kept rather than dropped", () => {
  test("a production date is carried through as an extra", () => {
    const p = parseGs1(`01${GTIN}11250101${GS}10L1${GS}21S1${GS}17270331`);
    assert.ok(p.extras.some((e) => e.ai === "11" && e.value === "250101"));
  });

  test("elements come back in the order they were printed", () => {
    const { elements } = parseGs1Elements(`01${GTIN}17270331${GS}10L1${GS}21S1`);
    assert.deepEqual(elements.map((e) => e.ai), ["01", "17", "10", "21"]);
  });
});
