import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { linesShortfall } from "../src/lib/invoices";

/*
 * What an invoice with a total and no lines kept can say about the lines it did not keep.
 *
 * McKesson 7657944598, 15 September: reported as "usually a scan". It was not. Fifty-six lines were
 * recognised and came to $9,880.92 against a total of $10,044.80, so the reader rightly refused
 * them all. The $163.88 between the two was two FreeStyle Libre sensors at $81.94 on a line whose
 * fourteen-digit code no pattern knew. That one figure locates the line without opening the PDF.
 */

describe("the invoice that earned it", () => {
  test("McKesson 7657944598: the shortfall is the two sensors", () => {
    const s = linesShortfall(1_004_480, 988_092);
    assert.equal(s.state, "short");
    assert.equal(s.state === "short" && s.shortCents, 16_388);
    assert.equal(s.state === "short" && s.readCents, 988_092);
    assert.equal(16_388, 8_194 * 2, "two sensors at $81.94");
  });
});

describe("three states that must stay apart", () => {
  test("read before the column existed is never measured, not nothing recognised", () => {
    // Null is an invoice nobody measured. Reporting it as zero would say its lines were worth nothing.
    assert.equal(linesShortfall(1_004_480, null).state, "neverMeasured");
  });

  test("measured with nothing recognised is its own answer", () => {
    // A scan, or a layout the reader has never seen. Zero is a real measurement here.
    assert.equal(linesShortfall(1_004_480, 0).state, "nothingRecognised");
  });

  test("a short invoice carries both figures, so the screen can say what was read as well as what was not", () => {
    const s = linesShortfall(50_000, 45_000);
    assert.deepEqual(s, { state: "short", readCents: 45_000, shortCents: 5_000 });
  });
});

describe("what the shortfall is not", () => {
  test("it is the total less the recognised lines, and it is never called goods", () => {
    /*
     * An invoice total can carry freight that no line does. The prices alert described a total's
     * difference as "goods that were not booked in" and it was two freight charges; the same
     * sentence here would regrow the same fault. The figure is what the lines could not account
     * for — the missed line and any charge on the total together.
     */
    const withFreight = linesShortfall(12_493, 12_336);
    assert.equal(withFreight.state === "short" && withFreight.shortCents, 157, "all of it may be freight, and that is allowed");
  });

  test("a total nobody read has no shortfall at all, rather than a negative one", () => {
    /*
     * The first version returned a shortfall of minus everything read, and the alert only avoided
     * showing it because it filters to invoices with a total. A pure function must not lean on a
     * filter somewhere else, so it answers the missing total itself.
     */
    assert.deepEqual(linesShortfall(null, 1_000), { state: "noTotal", readCents: 1_000 });
  });
});
