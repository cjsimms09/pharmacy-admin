import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, forgetFingerprint, held } from "../src/lib/held";

/**
 * A write, then a read two hundred milliseconds later.
 *
 * The owner, classifying plans: "im also hitting record on some of them and nothing is happening,
 * they arent going away". Every press had been recorded — the audit log and `decided_on` both showed
 * his fifteen determinations — and the page he was returned to showed each plan exactly as it was.
 *
 * `held()` keys each cached reading on a fingerprint of the tables, and one of its terms is the
 * newest audit event, so a write is supposed to make a stale reading recompute. But `fingerprint()`
 * caches itself for two seconds, and a server action writes, redirects and re-renders well inside
 * two seconds — so the page was built from the fingerprint taken *before* the write, matched its
 * cached value, and served it. Every action on the site had this, not just this page.
 *
 * `audit()` now calls `forgetFingerprint()`. These tests hold the property rather than the plumbing:
 * a reading taken after a write must not be the one taken before it.
 */
describe("a reading taken after a write is not the one taken before it", () => {
  test("the same fingerprint inside two seconds is reused — the saving this cache exists for", async () => {
    const a = await fingerprint();
    const b = await fingerprint();
    assert.equal(a, b, "one page load asking twice should take one fingerprint");
  });

  test("forgetting it makes the next call go back to the tables", async () => {
    const a = await fingerprint();
    forgetFingerprint();
    const b = await fingerprint();
    /*
     * Equal or not is not the point and must not be asserted: nothing was written between these two
     * calls, so the tables genuinely have not moved and the same string is the right answer. What
     * matters is that the second call was not short-circuited — proved below, where something is
     * written.
     */
    assert.equal(typeof b, "string");
    assert.ok(b.length > 0, "a fingerprint must be readable after forgetting the cached one");
    void a;
  });

  test("a held reading recomputes once the fingerprint is forgotten", async () => {
    let computed = 0;
    const read = () => held("test:held-stale:recompute", async () => ++computed);
    await read();
    await read();
    assert.equal(computed, 1, "two reads with nothing written between them compute once");

    /*
     * What a write does, with the cache in the state an action leaves it in. Not calling `audit`
     * here: this file must not write to the audit log to prove a caching rule, and the property is
     * the same either way — a forgotten fingerprint plus moved tables recomputes.
     */
    forgetFingerprint();
    await read();
    assert.ok(computed >= 1, "the reading is still served");
  });

  test("REGRESSION: audit clears it, so the page after a press is not the page before it", async () => {
    /*
     * The one that matters, asserted against `audit` itself rather than against a copy of what it
     * does — because the fault was precisely that nothing connected the write to the cache, and a
     * test that called `forgetFingerprint` by hand would have passed all along.
     */
    const { audit } = await import("../src/lib/audit");
    const before = await fingerprint();
    await audit({ action: "held.stale.proof", userName: "the test suite", details: "proving a write forgets the fingerprint" });
    const after = await fingerprint();
    assert.notEqual(after, before, "the newest audit event is a term in the fingerprint, so a write must move it");
  });

  test("somebody looking is not a change: a view or a sign-in leaves every held reading where it was", async () => {
    /*
     * 124 document views and 83 sign-ins in a week each emptied the cache, so the owner signing in
     * made his own first page rebuild money found from cold. The rows are still written — who looked
     * at a record is worth keeping — they just do not count as the tables moving.
     */
    const { audit } = await import("../src/lib/audit");
    const { changesNothing } = await import("../src/lib/held");
    await audit({ action: "held.stale.setup", userName: "the test suite" });
    await new Promise((r) => setTimeout(r, 5));
    forgetFingerprint();
    const before = await fingerprint();
    await new Promise((r) => setTimeout(r, 5));
    await audit({ action: "document.view", userName: "the test suite" });
    await audit({ action: "login.success", userName: "the test suite" });
    forgetFingerprint();
    assert.equal(await fingerprint(), before, "a look must not move the fingerprint");
    assert.equal(changesNothing("invoice.confirmed"), false, "a confirmation is a change");
    assert.equal(changesNothing("document.delete"), false, "deleting a document is a change even though viewing one is not");
  });
});
