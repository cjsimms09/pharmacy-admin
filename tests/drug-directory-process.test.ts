import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { directoryProcessPlan, readDirectoryLines } from "../src/lib/drug-directory-store";

/*
 * The FDA load runs in a process of its own, and these are the two joints where that can go wrong:
 * deciding whether the process can be started at all, and reading what it says while it runs.
 *
 * The reason it must not run in the web server is measured, not tidy-minded: A's memory audit put
 * one load at a 430 MB peak inside the server's own process, and V8 keeps that peak resident long
 * after. The pharmacy's machine ran out of memory twice on 8 September with the owner at the
 * counter. So a fault at either joint here is a fault that puts the peak back where it was.
 */

test("the load is planned as a node process, never as a shell command", () => {
  const plan = directoryProcessPlan("/app", "user_9", () => true);
  assert.ok(plan);
  assert.equal(plan.command, process.execPath);
  assert.ok(plan.args[0].endsWith(path.join("tsx", "dist", "cli.mjs")));
  assert.ok(plan.args.includes(path.join("/app", "tsconfig.script.json")));
  assert.ok(plan.args.includes(path.join("/app", "scripts", "load-drug-directory.ts")));
  // The user id is the last argument, so a name with a space or a quote in it cannot be read as anything else.
  assert.equal(plan.args.at(-1), "user_9");
});

test("no plan where the tools are not beside the site, so the caller can fall back rather than fail", () => {
  const missing = (f: string) => !f.includes("tsx");
  assert.equal(directoryProcessPlan("/app", "user_9", missing), null);
  assert.equal(directoryProcessPlan("/app", "user_9", () => false), null);
  // Every one of the three has to be there: a script without its tsconfig starts and then dies on an import.
  assert.equal(directoryProcessPlan("/app", "user_9", (f) => !f.endsWith("tsconfig.script.json")), null);
  assert.equal(directoryProcessPlan("/app", "user_9", (f) => !f.endsWith("load-drug-directory.ts")), null);
});

test("progress lines are read as they arrive, and a line split across two chunks is not lost", () => {
  const first = readDirectoryLines("", '{"step":"Reading the NDC Directory"}\n{"step":"Writing 217,');
  assert.deepEqual(first.messages, [{ step: "Reading the NDC Directory" }]);
  const second = readDirectoryLines(first.carried, '773 packages"}\n');
  assert.deepEqual(second.messages, [{ step: "Writing 217,773 packages" }]);
  assert.equal(second.carried, "");
});

test("anything the child writes that is not one of its own messages is passed over, not guessed at", () => {
  const r = readDirectoryLines("", 'Debugger listening on ws://127.0.0.1:9229\n{"step":"Reading the Orange Book"}\n{}\n');
  // The warning and the empty object are both dropped; only the real step survives.
  assert.deepEqual(r.messages, [{ step: "Reading the Orange Book" }]);
});

test("the result comes back whole, both ways round", () => {
  const ok = readDirectoryLines("", JSON.stringify({ result: { ok: true, rows: 217_773, products: 60_000, packages: 217_773, orangeBook: 44_000, rated: 120_000 } }) + "\n");
  assert.deepEqual(ok.messages[0].result, { ok: true, rows: 217_773, products: 60_000, packages: 217_773, orangeBook: 44_000, rated: 120_000 });
  const bad = readDirectoryLines("", JSON.stringify({ result: { ok: false, why: "fda.gov answered 503." } }) + "\n");
  assert.deepEqual(bad.messages[0].result, { ok: false, why: "fda.gov answered 503." });
});

test("a result with no trailing newline is still carried, so nothing is resolved on a half-written line", () => {
  const r = readDirectoryLines("", '{"result":{"ok":true,"rows":10}');
  assert.deepEqual(r.messages, []);
  assert.equal(r.carried, '{"result":{"ok":true,"rows":10}');
});
