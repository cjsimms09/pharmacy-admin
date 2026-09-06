import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitCommand, spawnPlan, cliDownloadArg } from "../src/lib/mtf";

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

describe("starting it on Windows", () => {
  test("a batch launcher goes through the command interpreter", () => {
    /*
     * Node refuses to launch a .cmd or .bat directly, and has since the April 2024 fix for
     * CVE-2024-27980 — the way Windows parses a batch file's arguments allowed command injection.
     * The refusal surfaces as "spawn EINVAL", which says nothing about batch files and reads
     * exactly like a wrong path. This tool's Windows package is a batch launcher, so every run of
     * it hit that.
     */
    const p = spawnPlan(String.raw`C:\Users\wwfprx\mtf-cli\bin\mtf-cli.cmd`, ["config", "get"]);
    assert.match(p.command, /cmd\.exe$/i);
    assert.deepEqual(p.args, ["/c", String.raw`C:\Users\wwfprx\mtf-cli\bin\mtf-cli.cmd`, "config", "get"]);
  });

  test("the arguments stay an array, so Node quotes them rather than a command line being pasted together", () => {
    const p = spawnPlan(String.raw`C:\a b\mtf-cli.bat`, ["download835", "--date=2026-09-06"]);
    assert.ok(p.args.includes("--date=2026-09-06"), "passed as one argument, not split on its spaces");
  });

  test("an ordinary executable is started directly, as before", () => {
    const p = spawnPlan(String.raw`C:\mtf\bin\mtf-cli.exe`, ["--version"]);
    assert.equal(p.command, String.raw`C:\mtf\bin\mtf-cli.exe`);
    assert.deepEqual(p.args, ["--version"]);
  });
});

describe("telling the tool where to put its downloads", () => {
  test("a folder inside the site's own is given relatively, because the tool joins rather than resolves", () => {
    /*
     * Version 2.2.0 joins --downloadDir onto its working directory instead of resolving it, so an
     * absolute path comes back doubled and it fails trying to create
     * "C:\Users\wwfprx\pharmacy-admin\C:\Users\wwfprx\pharmacy-admin\data\remits\mtf".
     */
    const arg = cliDownloadArg("/home/user/pharmacy-admin/data/remits/mtf", "/home/user/pharmacy-admin");
    assert.equal(arg, "data/remits/mtf");
  });

  test("a folder outside it still gets a relative form, because joining handles the way back up", () => {
    const arg = cliDownloadArg("/home/user/remits", "/home/user/pharmacy-admin");
    assert.equal(arg, "../remits");
  });

  test("the folder it is already in needs no path at all", () => {
    assert.equal(cliDownloadArg("/home/user/pharmacy-admin", "/home/user/pharmacy-admin"), "/home/user/pharmacy-admin");
  });
});
