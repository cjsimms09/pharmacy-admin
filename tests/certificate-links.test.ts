import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";

/**
 * A grid that shows a training as done and cannot show you the certificate is a grid you have to
 * leave in order to trust — and being asked "show me" is the only reason it exists.
 *
 * The link is built from a string in one file and served by a route in another, so the two can
 * drift apart without anything failing to compile: the badge would simply lead to a 404, which
 * nobody notices until an inspector is watching.
 */
describe("a completed training links to its certificate", () => {
  const matrix = readFileSync(new URL("../src/lib/staff-matrix.ts", import.meta.url), "utf8");
  const dash = readFileSync(new URL("../src/app/(app)/page.tsx", import.meta.url), "utf8");
  const training = readFileSync(new URL("../src/app/(app)/compliance/training/page.tsx", import.meta.url), "utf8");

  test("the route the links point at actually exists", () => {
    assert.ok(
      existsSync(new URL("../src/app/(app)/certificates/[trainingId]/page.tsx", import.meta.url)),
      "the certificate route has moved or gone",
    );
  });

  test("the matrix builds the link from the training's own id", () => {
    assert.match(matrix, /\/certificates\/\$\{last\.id\}/);
  });

  test("a credential cell points at the record it was read from", () => {
    assert.match(matrix, /\/staff\/\$\{p\.id\}#credential-form/);
  });

  test("the dashboard renders the cell as a link when there is one", () => {
    assert.match(dash, /cell\.href \? \(/);
  });

  test("the training page does the same, so both screens behave alike", () => {
    assert.match(training, /st\.certificate \? \(/);
    assert.match(training, /\/certificates\/\$\{last\.id\}/);
  });
});
