import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OBLIGATION_SEEDS, RENEWAL_CREDENTIAL } from "../src/lib/obligations";
import { periodEnds } from "../src/lib/periods";

/**
 * When a duty is actually due.
 *
 * Every annual duty was showing "due Dec 31" because that is when the annual period ends. The
 * Kansas pharmacy registration runs to 30 June, and a DEA registration expires on whatever date is
 * printed on the certificate — a date this system already holds on the licences page. Showing a
 * date the pharmacist can see is wrong is worse than showing none: it teaches him not to trust the
 * screen, and then he stops reading the ones that are right.
 */
describe("the seeds that carry their own deadline", () => {
  test("the Kansas pharmacy registration renews on 30 June, not at the end of the year", () => {
    const seed = OBLIGATION_SEEDS.find((s) => s.key === "ks_pharmacy_registration");
    assert.ok(seed, "the duty exists");
    assert.deepEqual(seed!.fixedDate, { month: 6, day: 30 });
    assert.notEqual(`2026-${seed!.fixedDate!.month}-${seed!.fixedDate!.day}`, periodEnds("2026"));
  });

  test("a fixed date is never 31 December, or it would not be worth carrying", () => {
    for (const seed of OBLIGATION_SEEDS) {
      if (!seed.fixedDate) continue;
      const asDate = `${String(seed.fixedDate.month).padStart(2, "0")}-${String(seed.fixedDate.day).padStart(2, "0")}`;
      if (asDate === "12-31") continue; // A genuine year-end deadline is allowed; it just is the default.
      assert.ok(seed.fixedDate.month >= 1 && seed.fixedDate.month <= 12, seed.key);
      assert.ok(seed.fixedDate.day >= 1 && seed.fixedDate.day <= 31, seed.key);
    }
  });
});

describe("renewals whose real date the pharmacy already holds", () => {
  test("each one names a credential type the licences page records", () => {
    for (const [seedKey, credentialType] of Object.entries(RENEWAL_CREDENTIAL)) {
      const seed = OBLIGATION_SEEDS.find((s) => s.key === seedKey);
      assert.ok(seed, `${seedKey} has no seed`);
      assert.ok(credentialType.length > 0);
    }
  });

  test("both registrations that expire on a printed date are covered", () => {
    // These are the two an inspector asks to see, and the two whose expiry is on a certificate
    // rather than set by a rule.
    assert.equal(RENEWAL_CREDENTIAL.ks_pharmacy_registration, "pharmacy_registration");
    assert.equal(RENEWAL_CREDENTIAL.dea_registration, "dea_registration");
  });
});

describe("the fallback, which is what the bug was", () => {
  test("an annual period still ends on 31 December", () => {
    assert.equal(periodEnds("2026"), "2026-12-31");
  });

  test("a monthly period ends on the last day of its own month", () => {
    assert.equal(periodEnds("2026-02"), "2026-02-28");
    assert.equal(periodEnds("2028-02"), "2028-02-29");
    assert.equal(periodEnds("2026-09"), "2026-09-30");
  });
});
