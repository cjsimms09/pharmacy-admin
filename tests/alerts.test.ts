import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SOON_DAYS, DELIVERY_GRACE_DAYS } from "../src/lib/alerts";
import { findAnything } from "../src/lib/find";

/**
 * The thresholds that decide what is allowed to interrupt somebody.
 *
 * The old screen showed everything due inside sixty days, which is not an alert list — it is an
 * inventory of the future. A licence expiring in eight weeks sat in red beside one that expired
 * last Tuesday, and the effect of that is not vigilance: it is that the screen stops being read,
 * which costs more than having no screen at all.
 *
 * These numbers are the whole policy, so they are pinned here rather than left to drift back.
 */
describe("what counts as urgent", () => {
  test("thirty days of warning for anything that takes weeks to put right", () => {
    assert.equal(SOON_DAYS, 30);
  });

  test("a delivery day may go one day unentered before it is anybody's problem", () => {
    // Entering yesterday's count this morning is the normal rhythm of the job. Complaining about
    // it every morning is how a list of complaints stops being read by Thursday.
    assert.equal(DELIVERY_GRACE_DAYS, 1);
  });

  test("the grace period is a day, not a week — two days means the count is being remembered", () => {
    assert.ok(DELIVERY_GRACE_DAYS >= 1 && DELIVERY_GRACE_DAYS < 3);
  });
});

/**
 * The one box that has to find things while an inspector waits.
 *
 * Searching needs no database for the parts that matter most here: the screens and the forms are
 * both static, and they are what somebody types when they do not know where something lives.
 */
describe("finding things by name", () => {
  test("a screen is found by what the menu calls it", async () => {
    const hits = await findAnything("technician list");
    assert.ok(hits.some((h) => h.kind === "page" && /technician/i.test(h.title)), JSON.stringify(hits.slice(0, 3)));
  });

  test("a form is found by the name an inspector would use, not only the Board's", async () => {
    const hits = await findAnything("medication incident");
    assert.ok(hits.some((h) => h.kind === "form"), "no form matched an alias");
  });

  test("a form is found by its Board number too", async () => {
    const hits = await findAnything("C-250");
    assert.ok(hits.some((h) => h.kind === "form" && /C-250/.test(h.title)));
  });

  test("every result carries somewhere to click", async () => {
    for (const h of await findAnything("inventory")) {
      assert.ok(h.href.startsWith("/"), `${h.title} has no link`);
      assert.ok(h.title.length > 0);
    }
  });

  test("two words narrow rather than widen", async () => {
    const one = await findAnything("power");
    const two = await findAnything("power attorney");
    assert.ok(two.length <= one.length);
  });

  test("an empty search returns nothing rather than everything", async () => {
    assert.deepEqual(await findAnything(""), []);
    assert.deepEqual(await findAnything("   "), []);
  });

  test("nonsense returns nothing rather than a guess", async () => {
    assert.deepEqual(await findAnything("qqzzxx"), []);
  });
});
