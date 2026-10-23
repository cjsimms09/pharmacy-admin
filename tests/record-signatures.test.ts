import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SIGNABLE, fingerprint, contentChanged, mayCertifyAgain } from "../src/lib/record-signatures";

/**
 * What makes a signature on screen the equal of one in ink.
 *
 * The ESIGN Act (15 U.S.C. 7001) and the Kansas UETA (K.S.A. 16-1601) ask for four things:
 * intent to sign, attribution to a person, association with the record signed, and retention in a
 * reproducible form. The parts that can be tested without a database are tested here, because the
 * ones that get quietly dropped are the wording and the binding.
 */
describe("what can be signed", () => {
  test("every signable record states what is being certified, in the first person", () => {
    for (const [kind, spec] of Object.entries(SIGNABLE)) {
      assert.equal(spec.kind, kind);
      assert.ok(spec.label.length > 0, kind);
      // A dynamic kind is signed against wording supplied per signature — a compliance
      // attestation names the duty and the period, which cannot be written in advance.
      if (spec.dynamic) continue;
      assert.ok(spec.statement.length > 80, `${kind} statement is too thin to mean anything`);
      assert.match(spec.statement, /\bI\b/, `${kind} does not say who is asserting it`);
    }
  });

  test("a dynamic kind carries no wording of its own, so nothing generic can be signed by mistake", () => {
    // The danger of allowing a per-signature statement is a kind that also has a fallback: a
    // signature would then silently record boilerplate when the real sentence went missing.
    for (const [kind, spec] of Object.entries(SIGNABLE)) {
      if (!spec.dynamic) continue;
      assert.equal(spec.statement, "", `${kind} must not have wording of its own`);
    }
  });

  test("an attestation may only be signed by the pharmacist-in-charge or a manager", () => {
    assert.ok(SIGNABLE.obligation_attestation.roles?.includes("owner"));
    assert.ok(!SIGNABLE.obligation_attestation.roles?.includes("staff"));
  });

  test("records the law is specific about may only be signed by somebody who can", () => {
    for (const kind of ["training_file", "technician_list", "cs_inventory"]) {
      assert.ok(SIGNABLE[kind].roles?.includes("owner"));
      assert.ok(!SIGNABLE[kind].roles?.includes("staff"), `${kind} must not be signable by staff`);
    }
  });

  test("the controlled substance inventory statement cites the rule it satisfies", () => {
    assert.match(SIGNABLE.cs_inventory.statement, /1304\.11/);
  });

  test("the technician list statement cites the Kansas requirement", () => {
    assert.match(SIGNABLE.technician_list.statement, /65-1663/);
  });
});

/**
 * The one thing a wet signature cannot do: notice that the page changed underneath it.
 */
describe("binding a signature to what was signed", () => {
  const content = "Nicole|hipaa:2026-01-04\nDavid|hipaa:2026-02-11";

  test("the same record fingerprints the same way every time", () => {
    assert.equal(fingerprint(content), fingerprint(content));
  });

  test("a changed record fingerprints differently", () => {
    assert.notEqual(fingerprint(content), fingerprint(content + "\nKim|hipaa:2026-03-01"));
  });

  test("a record edited after signing is detected", () => {
    const sig = { contentHash: fingerprint(content) } as never;
    assert.equal(contentChanged(sig, content), false);
    assert.equal(contentChanged(sig, content + "\nKim|hipaa:2026-03-01"), true);
  });

  test("no signature and no content is not a change", () => {
    assert.equal(contentChanged(null, content), false);
    assert.equal(contentChanged({ contentHash: null } as never, content), false);
    assert.equal(contentChanged({ contentHash: "abc" } as never, undefined), false);
  });
});

/**
 * Signing the same thing twice, and signing it again after it changed.
 *
 * These are different acts and the first version of this code treated them as one, which locked a
 * record under its first signature for ever. The only escape was to withdraw a certification that
 * was true of the version it covered — destroying real evidence to record more of it.
 */
describe("certifying a record more than once", () => {
  const v1 = "Nicole|bloodborne:2026-01-04";
  const v2 = "Nicole|bloodborne:2026-01-04\nDavid|bloodborne:2026-03-02";
  const sig = (content: string) =>
    ({ contentHash: fingerprint(content), signedName: "Cory Simms", signedAt: "2026-02-01T15:00:00.000Z" }) as never;

  test("an unsigned record may be signed", () => {
    assert.deepEqual(mayCertifyAgain(null, v1), { ok: true });
  });

  test("the same version may not be signed twice", () => {
    const r = mayCertifyAgain(sig(v1), v1);
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.why : "", /same version/);
  });

  test("a record that has moved on since it was signed may be signed again", () => {
    // The whole point: the February signature stays, and March gets its own.
    assert.deepEqual(mayCertifyAgain(sig(v1), v2), { ok: true });
  });

  test("a signature not bound to any content still has to be withdrawn first", () => {
    // Nothing can prove it changed, so accumulating signatures nobody can tell apart is worse
    // than making somebody say out loud that the old one no longer stands.
    const r = mayCertifyAgain({ contentHash: null, signedName: "Cory Simms", signedAt: "x" } as never, v2);
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.why : "", /Withdraw/);
  });

  test("signing a record whose content is not supplied is refused rather than guessed at", () => {
    const r = mayCertifyAgain(sig(v1), undefined);
    assert.equal(r.ok, false);
  });

  test("the refusal names who signed it, so nobody has to go looking", () => {
    const r = mayCertifyAgain(sig(v1), v1);
    assert.match(r.ok === false ? r.why : "", /Cory Simms/);
  });
});
