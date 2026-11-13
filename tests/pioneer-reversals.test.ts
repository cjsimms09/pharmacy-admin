import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planReversalsFromPioneer } from "../src/lib/pioneer-reversals";

/*
 * A paid row the site holds while PioneerRx's last valid claim for the same prescription, refill and BIN is a reversal.
 * Written on a presence only: a payer PioneerRx no longer lists is counted and left alone; a fill dated on or after the
 * copy's newest day is left alone because the copy may not have it yet. Identifiers invented.
 */
describe("PioneerRx's last word on a reversed claim", () => {
  const paid = (id: string, over: Partial<{ dateFilled: string; bin: string; remitCents: number }> = {}) => ({
    id, rxNumber: "900040", fillNumber: 0, bin: over.bin ?? "610011", dateFilled: over.dateFilled ?? "2026-09-04", remitCents: over.remitCents ?? 46_189,
  });
  const reversal = (reversedOn: string, bin = "610011") => ({ rxNumber: "900040", fillNumber: 0, bin, reversedOn });

  test("a paid row PioneerRx holds reversed, with no paid claim left, is planned with the reversal's date", () => {
    const r = planReversalsFromPioneer([paid("a")], new Set(), [reversal("2026-09-04")], "2026-10-01");
    assert.deepEqual(r.planned.map((p) => [p.id, p.reversedOn, p.cents]), [["a", "2026-09-04", 46_189]]);
    assert.equal(r.payerGone, 0);
  });
  test("a row PioneerRx still holds paid is left alone, whatever reversals it also holds", () => {
    const r = planReversalsFromPioneer([paid("a")], new Set(["900040|0|610011"]), [reversal("2026-09-04")], "2026-10-01");
    assert.equal(r.planned.length, 0);
    assert.equal(r.payerGone, 0);
  });
  test("a reversal dated before the fill is not this fill's; a payer PioneerRx no longer lists is counted, not written", () => {
    const before = planReversalsFromPioneer([paid("a", { dateFilled: "2026-09-10" })], new Set(), [reversal("2026-09-04")], "2026-10-01");
    assert.equal(before.planned.length, 0);
    assert.equal(before.payerGone, 1);
    assert.equal(before.payerGoneCents, 46_189);
    const gone = planReversalsFromPioneer([paid("a")], new Set(), [], "2026-10-01");
    assert.equal(gone.planned.length, 0);
    assert.equal(gone.payerGone, 1);
  });
  test("a fill dated on or after the copy's newest day is left alone: the copy may not have it yet", () => {
    const r = planReversalsFromPioneer([paid("a", { dateFilled: "2026-10-01" })], new Set(), [], "2026-10-01");
    assert.equal(r.planned.length, 0);
    assert.equal(r.payerGone, 0);
  });
  test("the latest reversal on or after the fill is the one taken", () => {
    const r = planReversalsFromPioneer([paid("a")], new Set(), [reversal("2026-09-04"), reversal("2026-09-18")], "2026-10-01");
    assert.deepEqual(r.planned.map((p) => p.reversedOn), ["2026-09-18"]);
  });
});
