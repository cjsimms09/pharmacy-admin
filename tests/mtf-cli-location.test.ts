import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitCommand } from "../src/lib/mtf";

/**
 * What "where the tool is" is allowed to be.
 *
 * The MTF tool ships as a Node application with its own copy of Node beside it, so on some builds
 * there is no single executable to point at: the bin folder contains node.exe and nothing else, and
 * the way to run it is one program with a script as its first argument. Accepting only a bare path
 * would make that layout unusable — and somebody looking at a bin folder containing node.exe would
 * reasonably conclude node.exe was the answer, which runs nothing at all.
 */
describe("what can be pointed at", () => {
  test("a plain path is the ordinary case", () => {
    assert.deepEqual(splitCommand(String.raw`C:\Users\wwfprx\mtf-cli\bin\mtf-cli.exe`), {
      bin: String.raw`C:\Users\wwfprx\mtf-cli\bin\mtf-cli.exe`,
      prefix: [],
    });
  });

  test("a runtime and its script are a command line, and the script comes before our arguments", () => {
    const r = splitCommand(String.raw`"C:\Users\wwfprx\mtf-cli\bin\node.exe" "C:\Users\wwfprx\mtf-cli\lib\cli.js"`);
    assert.equal(r.bin, String.raw`C:\Users\wwfprx\mtf-cli\bin\node.exe`);
    assert.deepEqual(r.prefix, [String.raw`C:\Users\wwfprx\mtf-cli\lib\cli.js`]);
  });

  test("quotes hold a path with spaces together, which every path under Program Files has", () => {
    const r = splitCommand(String.raw`"C:\Program Files\MTF CLI\bin\node.exe" "C:\Program Files\MTF CLI\lib\cli.js"`);
    assert.equal(r.bin, String.raw`C:\Program Files\MTF CLI\bin\node.exe`);
    assert.equal(r.prefix.length, 1);
    assert.match(r.prefix[0], /MTF CLI/);
  });

  test("nothing configured falls back to the name, for a tool on the system PATH", () => {
    assert.deepEqual(splitCommand("   "), { bin: "mtf-cli", prefix: [] });
  });
});
