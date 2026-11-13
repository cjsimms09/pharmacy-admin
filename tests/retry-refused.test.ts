import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { triedMark, wantsAnotherRead } from "../src/lib/retry-refused";

const refused = {
  routeResult: "Held, nothing stored: EFT-90000001 does not hold together: the OutcomesMTM section holds 12 rows against its Paid claims of 13. Nothing was read from it.",
  imported: false,
  documentId: "doc-1",
  receivedAt: "2026-10-03T16:49:19.000Z",
};
const since = "2026-09-01T00:00:00.000Z";

describe("which refused reports get another read", () => {
  test("a refused report not yet tried on this build is read again", () => {
    assert.equal(wantsAnotherRead(refused, "B2", since), true);
  });
  test("is not read again on the build it was already tried on", () => {
    assert.equal(wantsAnotherRead({ ...refused, routeResult: `${refused.routeResult} ${triedMark("B2")}` }, "B2", since), false);
  });
  test("is read again on the next build", () => {
    assert.equal(wantsAnotherRead({ ...refused, routeResult: `${refused.routeResult} ${triedMark("B2")}` }, "B3", since), true);
  });
  test("leaves alone a loaded report, one with no stored document, an old one, and one nothing refused", () => {
    assert.equal(wantsAnotherRead({ ...refused, imported: true }, "B2", since), false);
    assert.equal(wantsAnotherRead({ ...refused, documentId: null }, "B2", since), false);
    assert.equal(wantsAnotherRead({ ...refused, receivedAt: "2026-08-01T00:00:00.000Z" }, "B2", since), false);
    assert.equal(wantsAnotherRead({ ...refused, routeResult: "Filed as a supplier invoice." }, "B2", since), false);
  });
  test("does nothing where the build is not known", () => {
    assert.equal(wantsAnotherRead(refused, "", since), false);
  });
});
