import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { credentialEnd, inForce, splitSuperseded, UNKNOWN_END } from "../src/lib/superseded";

/**
 * The distinction this exists for: replaced is not the same as lapsed.
 *
 * Getting it wrong in one direction buries this year's problem under five years of history. Getting
 * it wrong in the other hides the licence that ran out last week and was never renewed, which is
 * the whole reason anybody opens the page.
 */
type Row = { id: string; type: string; ends: string | null };
const on = { key: (r: Row) => r.type, endsOn: (r: Row) => r.ends };
const TODAY = "2026-09-05";

describe("superseded, not merely expired", () => {
  test("an expired credential that was renewed is history", () => {
    const rows: Row[] = [
      { id: "old", type: "licence", ends: "2025-06-30" },
      { id: "new", type: "licence", ends: "2027-06-30" },
    ];
    const s = splitSuperseded(rows, TODAY, on);
    assert.deepEqual(s.current.map((r) => r.id), ["new"]);
    assert.deepEqual(s.history.map((r) => r.id), ["old"]);
  });

  test("an expired credential that was NOT renewed stays on the page", () => {
    // The one that must never be hidden. This is a live gap, not history.
    const rows: Row[] = [{ id: "lapsed", type: "cpr", ends: "2025-01-01" }];
    const s = splitSuperseded(rows, TODAY, on);
    assert.deepEqual(s.current.map((r) => r.id), ["lapsed"]);
    assert.equal(s.history.length, 0);
  });

  test("a renewal that has also expired keeps the newest one visible", () => {
    // Two dead licences: the older is history, the newest is the live gap.
    const rows: Row[] = [
      { id: "older", type: "licence", ends: "2023-06-30" },
      { id: "newer", type: "licence", ends: "2025-06-30" },
    ];
    const s = splitSuperseded(rows, TODAY, on);
    assert.deepEqual(s.current.map((r) => r.id), ["newer"]);
    assert.deepEqual(s.history.map((r) => r.id), ["older"]);
  });

  test("a credential with no expiry outranks a dated one", () => {
    const rows: Row[] = [
      { id: "dated", type: "cert", ends: "2025-01-01" },
      { id: "forever", type: "cert", ends: null },
    ];
    const s = splitSuperseded(rows, TODAY, on);
    assert.deepEqual(s.current.map((r) => r.id), ["forever"]);
    assert.deepEqual(s.history.map((r) => r.id), ["dated"]);
  });

  test("different kinds never supersede each other", () => {
    const rows: Row[] = [
      { id: "licence", type: "licence", ends: "2024-06-30" },
      { id: "cpr", type: "cpr", ends: "2027-06-30" },
    ];
    const s = splitSuperseded(rows, TODAY, on);
    assert.equal(s.history.length, 0, "a current CPR card does not replace a lapsed licence");
    assert.equal(s.current.length, 2);
  });

  test("a future renewal already supersedes the one still running", () => {
    // Renewed early, both in force today. The old one is still the one that will lapse, so it is
    // not hidden until it actually has.
    const rows: Row[] = [
      { id: "current", type: "licence", ends: "2026-12-31" },
      { id: "renewal", type: "licence", ends: "2028-12-31" },
    ];
    const s = splitSuperseded(rows, TODAY, on);
    assert.equal(s.history.length, 0);
    assert.equal(s.current.length, 2);
  });

  test("nothing is ever dropped", () => {
    const rows: Row[] = [
      { id: "a", type: "x", ends: "2020-01-01" },
      { id: "b", type: "x", ends: "2021-01-01" },
      { id: "c", type: "x", ends: "2030-01-01" },
      { id: "d", type: "y", ends: null },
    ];
    const s = splitSuperseded(rows, TODAY, on);
    assert.equal(s.current.length + s.history.length, rows.length);
  });
});


/**
 * The row a reader should look at when it wants one certificate and not the whole split. The first row the database hands back is the
 * oldest, and once a registration has been renewed on a new row that is the one it replaced.
 */
describe("inForce, the one a reader should look at", () => {
  const old: Row = { id: "old", type: "licence", ends: "2026-06-30" };
  const renewed: Row = { id: "new", type: "licence", ends: "2027-06-30" };

  test("a renewed certificate is the one in force, whichever order the rows come in", () => {
    assert.equal(inForce([old, renewed], on.endsOn)?.id, "new");
    assert.equal(inForce([renewed, old], on.endsOn)?.id, "new");
  });

  test("a row with no end date outranks every dated one, as it does in the split", () => {
    const rows: Row[] = [
      { id: "dated", type: "licence", ends: "2030-01-01" },
      { id: "never", type: "licence", ends: null },
    ];
    assert.equal(inForce(rows, on.endsOn)?.id, "never");
    assert.equal(inForce([...rows].reverse(), on.endsOn)?.id, "never");
  });

  // Which of two equal rows is taken decides nothing about the date. The rule is only that it is the same one every time, so a page does not
  // show one number on one load and another on the next.
  test("of two that end together the first one given is the one in force", () => {
    const rows: Row[] = [
      { id: "a", type: "licence", ends: "2027-06-30" },
      { id: "b", type: "licence", ends: "2027-06-30" },
    ];
    assert.equal(inForce(rows, on.endsOn)?.id, "a");
  });

  test("with nothing to choose from it says so rather than throwing", () => {
    assert.equal(inForce<Row>([], on.endsOn), undefined);
  });

  test("it is the row the split keeps as current for a renewed certificate", () => {
    const rows = [old, renewed];
    assert.deepEqual(splitSuperseded(rows, "2027-01-02", on).current, [inForce(rows, on.endsOn)]);
  });
});

/**
 * A blank date is not "never expires". A certificate row carries a date, or is ticked as never expiring, or is blank because nobody typed
 * one. The third must lose to a date somebody did type, and stay in view until somebody types one: hiding it would hide that the date is
 * missing, and letting it win would let an empty box stand in for a certificate that runs out.
 */
describe("a date nobody recorded is neither a date nor 'never expires'", () => {
  type Cert = { id: string; type: string; noExpiry: boolean; expiresOn: string | null };
  const cert = (id: string, expiresOn: string | null, noExpiry = false): Cert => ({ id, type: "registration", noExpiry, expiresOn });
  const cred = { key: (c: Cert) => c.type, endsOn: credentialEnd };

  test("what a credential row says about when it stops", () => {
    assert.equal(credentialEnd({ noExpiry: true, expiresOn: null }), null);
    assert.equal(credentialEnd({ noExpiry: true, expiresOn: "2027-06-30" }), null, "said permanent, whatever date is left on it");
    assert.equal(credentialEnd({ noExpiry: false, expiresOn: "2027-06-30" }), "2027-06-30");
    assert.equal(credentialEnd({ noExpiry: false, expiresOn: null }), UNKNOWN_END);
    assert.equal(credentialEnd({ noExpiry: false, expiresOn: "" }), UNKNOWN_END, "an empty string is as blank as null");
    assert.equal(credentialEnd({}), UNKNOWN_END);
  });

  test("a blank row never outranks a dated one, in either order", () => {
    const rows = [cert("dated", "2026-06-30"), cert("blank", null)];
    assert.equal(inForce(rows, credentialEnd)?.id, "dated");
    assert.equal(inForce([...rows].reverse(), credentialEnd)?.id, "dated");
  });

  test("a row ticked 'does not expire' still outranks every date", () => {
    const rows = [cert("dated", "2099-01-01"), cert("blank", null), cert("permanent", null, true)];
    assert.equal(inForce(rows, credentialEnd)?.id, "permanent");
  });

  test("with only blank rows the first is in force and every one stays in view", () => {
    const rows = [cert("a", null), cert("b", null)];
    assert.equal(inForce(rows, credentialEnd)?.id, "a");
    const split = splitSuperseded(rows, "2030-01-01", cred);
    assert.deepEqual(split.history, []);
    assert.deepEqual(split.current.map((c) => c.id).sort(), ["a", "b"]);
  });

  test("a blank row beside a lapsed dated row is not put behind it", () => {
    const rows = [cert("lapsed", "2020-06-30"), cert("blank", null)];
    const split = splitSuperseded(rows, "2026-10-07", cred);
    assert.deepEqual(split.history, [], "nothing is replaced by a row that has no date");
    assert.deepEqual(split.current.map((c) => c.id).sort(), ["blank", "lapsed"]);
  });

  test("a blank row beside a current dated row stays in view, and the dated one is in force", () => {
    const rows = [cert("blank", null), cert("current", "2099-06-30"), cert("old", "2020-06-30")];
    assert.equal(inForce(rows, credentialEnd)?.id, "current");
    const split = splitSuperseded(rows, "2026-10-07", cred);
    assert.deepEqual(split.history.map((c) => c.id), ["old"]);
    assert.deepEqual(split.current.map((c) => c.id).sort(), ["blank", "current"]);
  });
});
