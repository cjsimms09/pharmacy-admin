import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fieldAfterImport } from "../src/lib/suppliers";

describe("a column the file being imported never mentioned", () => {
  test("keeps what the site already holds", () => {
    // The real loss: PioneerRx's older catalogue export carries no AWP column, and importing it
    // blanked AWP on twenty-six thousand McKesson rows that had one.
    assert.equal(fieldAfterImport(undefined, false, 31_626), 31_626);
    assert.equal(fieldAfterImport(null, false, "rebated"), "rebated");
  });

  test("but a file that does carry the column and leaves this row blank is making a statement", () => {
    // "This item has no AWP" is an answer, and it replaces an AWP held from an older file.
    assert.equal(fieldAfterImport(undefined, true, 31_626), null);
    assert.equal(fieldAfterImport(null, true, "rebated"), null);
  });

  test("what the file actually says always wins", () => {
    assert.equal(fieldAfterImport(28_400, true, 31_626), 28_400);
    assert.equal(fieldAfterImport(28_400, false, 31_626), 28_400);
    assert.equal(fieldAfterImport("not rebated", false, "rebated"), "not rebated");
  });

  test("nothing anywhere is null, not undefined, so the column stores cleanly", () => {
    assert.equal(fieldAfterImport(undefined, false, undefined), null);
    assert.equal(fieldAfterImport(undefined, true, undefined), null);
  });

  test("a zero from the file is a value, not an absence", () => {
    // A falsy check here would treat a genuine zero as "the file said nothing" and resurrect an
    // old figure over the top of it.
    assert.equal(fieldAfterImport(0, true, 31_626), 0);
    assert.equal(fieldAfterImport(0, false, 31_626), 0);
    assert.equal(fieldAfterImport("", false, "rebated"), "");
  });
});
