import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SIGNABLE, fingerprint, contentChanged } from "../src/lib/record-signatures";

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
      assert.ok(spec.statement.length > 80, `${kind} statement is too thin to mean anything`);
      assert.match(spec.statement, /\bI\b/, `${kind} does not say who is asserting it`);
      assert.ok(spec.label.length > 0, kind);
    }
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
