import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tillLine, type TillFigures } from "../src/lib/till-line";

/**
 * The sentence this replaces printed, in bold, on the owner's home page:
 *
 *   "$0.00 taken in 2026-09 — the whole till, retail and prescriptions together, from the System
 *    Sales Summary. Of that, $0.00 came from the plans, $0.00 from patients at the counter and
 *    $2,115.07 over the counter."
 *
 * Three nulls rendered as noughts, a total that contradicted its own breakdown, and a document that
 * has never been filed given as the source. The live row is the last test here.
 */
const base: TillFigures = {
  month: "2026-09",
  retailCents: 211_507,
  rxPatientCents: null,
  rxRemitCents: null,
  totalCents: null,
  isCurrentMonth: true,
  fileName: "PioneerRx till, front of shop, 2026-09",
};

describe("a till the site knows in full", () => {
  const whole: TillFigures = { ...base, rxRemitCents: 57_077_894, rxPatientCents: 9_325_956, totalCents: 66_949_738, fileName: "System Sales Summary Aug 2026.pdf" };

  test("the whole till leads, and every half is stated", () => {
    const l = tillLine(whole);
    assert.equal(l.headlineCents, 66_949_738);
    assert.match(l.headline, /\$669,497\.38 taken in 2026-09/);
    assert.match(l.detail, /the whole till, retail and prescriptions together/);
    assert.match(l.detail, /\$570,778\.94 came from the plans/);
    assert.match(l.detail, /\$211,507\.00 over the counter|\$2,115\.07 over the counter/);
    assert.equal(l.partial, false);
  });

  test("a closed month says so", () => {
    assert.match(tillLine({ ...whole, isCurrentMonth: false }).headline, /the last month closed/);
  });
});

describe("the live row: retail known, the prescription side not", () => {
  test("the headline is the front of shop, not a total that omits half the till", () => {
    const l = tillLine(base);
    assert.equal(l.headlineCents, 211_507);
    assert.match(l.headline, /\$2,115\.07 over the counter in 2026-09/);
    assert.equal(l.partial, true);
  });

  test("no figure the site does not hold appears anywhere in it", () => {
    const l = tillLine(base);
    assert.equal(`${l.headline} ${l.detail}`.includes("$0.00"), false, "a null is not a nought");
  });

  /*
   * The source matters because it decides the reader's next question. A Summary would have carried
   * the prescription half; the till pull never could, so pointing at the Summary sends somebody
   * looking for a fault in a document that was never filed.
   */
  test("a reconstruction is named as one, and does not claim to be the Summary", () => {
    const l = tillLine(base);
    assert.match(l.detail, /rebuilt from PioneerRx's till/);
    assert.equal(l.detail.includes("from the System Sales Summary."), false);
    assert.match(l.detail, /a System Sales Summary would carry both halves/);
  });

  test("a real Summary that simply lacks the prescription lines is described differently", () => {
    const l = tillLine({ ...base, fileName: "System Sales Summary Sep 2026.pdf" });
    assert.match(l.detail, /does not state what the prescription side of the till took/);
    assert.equal(l.detail.includes("rebuilt"), false);
  });
});

describe("what must never be defaulted", () => {
  test("a genuine nought is stated as a nought, not as missing", () => {
    const l = tillLine({ ...base, retailCents: 0, rxRemitCents: 0, rxPatientCents: 0, totalCents: 0 });
    assert.equal(l.headlineCents, 0);
    assert.match(l.detail, /\$0\.00 came from the plans/);
    assert.equal(l.partial, false, "measured zero is complete knowledge");
  });

  test("a total on file with a half missing keeps the total and names the gap", () => {
    const l = tillLine({ ...base, totalCents: 500_000, rxRemitCents: 300_000 });
    assert.equal(l.headlineCents, 500_000);
    assert.match(l.detail, /It does not say what patients paid at the counter/);
    assert.equal(l.partial, true);
  });

  test("nothing on file at all says so rather than printing noughts", () => {
    const l = tillLine({ ...base, retailCents: null });
    assert.equal(l.headlineCents, null);
    assert.match(l.headline, /is not fully on file/);
    assert.match(l.detail, /None of its figures have been read/);
    assert.equal(l.detail.includes("$0.00"), false);
  });
});
