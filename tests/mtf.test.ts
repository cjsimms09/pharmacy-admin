import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { countFiles } from "../src/lib/mtf";

/**
 * The CLI's output format is not contractual, so the count is parsed defensively. The failure
 * that matters is overstating it: a count that reads high would make an empty mailbox look like
 * a working pipeline, and we would stop chasing refunds that were never arriving.
 */
describe("countFiles", () => {
  test("uses a stated count when the tool gives one", () => {
    assert.equal(countFiles("Search complete. 7 files found."), 7);
    assert.equal(countFiles("1 file found"), 1);
  });

  test("an explicit no-files message is zero, not a guess", () => {
    assert.equal(countFiles("No files found matching the search criteria."), 0);
    assert.equal(countFiles("no file found"), 0);
  });

  test("falls back to counting distinct filenames", () => {
    const out = "Found:\n  MTF_835_20260901.835\n  MTF_835_20260908.835\n";
    assert.equal(countFiles(out), 2);
  });

  test("a filename repeated in the output is counted once", () => {
    assert.equal(countFiles("MTF_835_20260901.835 ... downloading MTF_835_20260901.835"), 1);
  });

  test("output with nothing file-shaped in it is zero", () => {
    assert.equal(countFiles("Configuration loaded. Contacting server..."), 0);
    assert.equal(countFiles(""), 0);
  });

  test("a stated count wins over filenames that also appear", () => {
    assert.equal(countFiles("2 files found: a.835, b.835, c.835"), 2);
  });
});
