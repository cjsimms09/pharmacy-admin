import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OBLIGATION_SEEDS, CLOSURES } from "../src/lib/obligations";

/**
 * A duty that cannot be closed is worse than one that is missing: it sits on the screen looking
 * like work while offering no way to do it, and nothing on the page explains why. That is exactly
 * what happened when attestation wording was added — pharmacies that had already seeded their
 * obligations kept rows with no statement, and the confirm button silently did not render.
 */
describe("every duty can actually be closed", () => {
  for (const seed of OBLIGATION_SEEDS) {
    if (seed.cadence === "as_needed") continue;
    const c = CLOSURES[seed.key];

    test(`${seed.key} says how it is closed`, () => {
      assert.ok(c, `${seed.key} has no closure defined, so it defaults to attest with no wording and cannot be closed`);
    });

    test(`${seed.key} has what its kind requires`, () => {
      if (!c) return;
      if (c.kind === "attest") {
        assert.ok(c.statement, `${seed.key} is an attestation with no wording — the button will not render`);
        assert.match(c.statement!, /\{date\}/, `${seed.key} does not record when it was done`);
        assert.match(c.statement!, /\{period\}/, `${seed.key} does not say which period it covers`);
        assert.ok(c.statement!.startsWith("On {date} I"), `${seed.key} does not read as a first-person statement`);
      }
      if (c.kind === "witnessed") {
        assert.ok(c.witness, `${seed.key} closes itself but does not say what satisfies it`);
      }
    });
  }
});

describe("attestations are specific enough to be worth signing", () => {
  for (const [key, c] of Object.entries(CLOSURES)) {
    if (c.kind !== "attest") continue;
    test(`${key} states what was actually checked`, () => {
      // "I confirm this was done" is not evidence. The statement has to name the thing.
      assert.ok(c.statement!.length > 120, `${key} is too thin to stand behind`);
      assert.ok(!/^On \{date\} I (did|completed|checked) (this|it)/.test(c.statement!), `${key} is generic`);
    });
  }
});

describe("closure kinds are used consistently", () => {
  test("nothing is marked witnessed without something in the site to witness it", () => {
    const witnessed = Object.entries(CLOSURES).filter(([, c]) => c.kind === "witnessed");
    assert.ok(witnessed.length >= 8, "the witnessed set has shrunk — those become manual work again");
    for (const [key, c] of witnessed) assert.ok(c.witness, `${key} claims to close itself but names no source`);
  });

  test("the two monthly duties a PIC does by hand are quick", () => {
    // If K-TRACS or exclusion screening ever look like an hour's work they will be put off.
    for (const key of ["ktracs_submission_check", "exclusion_screening"]) {
      assert.ok((CLOSURES[key].minutes ?? 99) <= 10, `${key} is not being presented as a quick job`);
    }
  });
});
