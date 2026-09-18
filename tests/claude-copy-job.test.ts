import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { copyProcessPlan, readCopyLines, copyJobRunning, parseCopyJob } from "../src/lib/claude-copy-job";

/*
 * The copy runs in a process of its own, and these are the two joints where that can go wrong:
 * deciding whether the separate process can be started at all, and reading what it says while it
 * runs. Both failed silently in the fault this replaced — the pharmacist saw a button that did
 * nothing — so both are held here.
 */

test("the copy is planned as a node process, never as a shell command", () => {
  const plan = copyProcessPlan("/app", "C:\\Users\\wwfprx\\OneDrive\\Backups", () => true);
  assert.ok(plan);
  assert.equal(plan.command, process.execPath);
  // The destination is an argument, so a folder name with a space or a quote in it cannot be read as anything else.
  assert.equal(plan.args.at(-1), "C:\\Users\\wwfprx\\OneDrive\\Backups");
  assert.ok(plan.args[0].endsWith(path.join("tsx", "dist", "cli.mjs")));
  assert.ok(plan.args.includes(path.join("/app", "tsconfig.script.json")));
});

test("without the tools beside it, there is no plan and the caller does the work itself", () => {
  const missing = (f: string) => !f.includes("tsx");
  assert.equal(copyProcessPlan("/app", "/backups", missing), null);
  assert.equal(copyProcessPlan("/app", "/backups", (f) => !f.endsWith("make-claude-copy.ts")), null);
  assert.equal(copyProcessPlan("/app", "/backups", (f) => !f.endsWith("tsconfig.script.json")), null);
});

test("a message split across two reads is still read", () => {
  let carried = "";
  const seen: unknown[] = [];
  for (const chunk of ['{"step":"Taking a co', 'py of the database"}\n{"step":"Compres', 'sing"}\n']) {
    const r = readCopyLines(carried, chunk);
    carried = r.carried;
    seen.push(...r.messages);
  }
  assert.deepEqual(seen, [{ step: "Taking a copy of the database" }, { step: "Compressing" }]);
  assert.equal(carried, "");
});

test("three messages arriving in one read are all read, in order", () => {
  const r = readCopyLines("", '{"step":"one"}\n{"step":"two"}\n{"result":{"ok":true,"path":"/b/c.zip","bytes":10,"checked":2,"prescriptions":1}}\n');
  assert.deepEqual(r.messages.map((m) => m.step), ["one", "two", undefined]);
  assert.equal(r.messages[2].result?.ok, true);
});

test("output that is not one of the child's messages is ignored, not thrown on", () => {
  const r = readCopyLines("", 'Debugger listening on ws://127.0.0.1:9229\n{"step":"Compressing"}\n');
  assert.deepEqual(r.messages, [{ step: "Compressing" }]);
});

test("a half-line at the end is carried, not lost", () => {
  const r = readCopyLines("", '{"step":"one"}\n{"step":"tw');
  assert.deepEqual(r.messages, [{ step: "one" }]);
  assert.equal(r.carried, '{"step":"tw');
});

test("a job is judged live by its last step, not by when it began", () => {
  const long = { state: "running" as const, runId: "r", startedAt: "2026-09-07T10:00:00.000Z", updatedAt: "2026-09-07T10:20:00.000Z", by: "Cory", step: "Compressing" };
  const at = Date.parse("2026-09-07T10:21:00.000Z");
  // Twenty-one minutes in, and still running, because it said something a minute ago.
  assert.equal(copyJobRunning(long, at), true);
  // Six minutes of silence and it is presumed gone, however recently it started.
  assert.equal(copyJobRunning({ ...long, updatedAt: "2026-09-07T10:14:00.000Z" }, at), false);
});

test("a job record the site cannot read leaves the button pressable", () => {
  assert.equal(parseCopyJob("not json"), null);
  assert.equal(parseCopyJob(undefined), null);
  assert.equal(copyJobRunning(null), false);
});
