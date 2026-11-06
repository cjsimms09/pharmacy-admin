import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseClaimsImportJob, claimsImportRunning, importProcessPlan, APART_ABOVE_BYTES } from "../src/lib/claims-import-job";

/**
 * The twelve-month claims history imports in a process of its own, because inside the web server
 * an import of that size is minutes during which no page is served. These are the pure parts: the
 * job record, whether it is still alive, and the process that runs it.
 */
describe("the claims import job", () => {
  test("the daily file is well under the threshold and the history well over it", () => {
    // The daily Rx Transaction Details file is ~20 KB; the first archive load was 362 KB; a year is megabytes.
    assert.ok(20 * 1024 < APART_ABOVE_BYTES);
    assert.ok(362_641 > APART_ABOVE_BYTES);
  });

  test("a job record that is not JSON, or not a job, is nothing rather than a crash", () => {
    assert.equal(parseClaimsImportJob(undefined), null);
    assert.equal(parseClaimsImportJob("not json"), null);
    assert.equal(parseClaimsImportJob("{}"), null);
    assert.equal(parseClaimsImportJob(JSON.stringify({ runId: "r1", state: "running" }))?.runId, "r1");
  });

  test("running means running and heard from recently; a child that died with the server is not running", () => {
    const now = Date.parse("2026-09-08T10:00:00Z");
    const fresh = { state: "running" as const, runId: "r", fileName: "f", startedAt: "2026-09-08T09:55:00Z", by: "x", step: "s" };
    assert.equal(claimsImportRunning(fresh, now), true);
    const stale = { ...fresh, startedAt: "2026-09-08T09:00:00Z" };
    assert.equal(claimsImportRunning(stale, now), false, "not heard from in ten minutes");
    const heard = { ...stale, updatedAt: "2026-09-08T09:58:00Z" };
    assert.equal(claimsImportRunning(heard, now), true, "a step written recently keeps it alive");
    assert.equal(claimsImportRunning({ ...fresh, state: "done" }, now), false);
    assert.equal(claimsImportRunning(null, now), false);
  });

  test("the process is the same tsx, tsconfig and script every other separate process uses", () => {
    const plan = importProcessPlan("/root", "/root/data/imports/r.txt", "History.txt", "u1", () => true)!;
    assert.ok(plan.args.some((a) => a.endsWith("import-claims.ts")));
    assert.ok(plan.args.some((a) => a.endsWith("tsconfig.script.json")));
    assert.deepEqual(plan.args.slice(-3), ["/root/data/imports/r.txt", "History.txt", "u1"]);
  });

  test("with no tsx on the machine there is no plan, and the caller imports in-process instead", () => {
    assert.equal(importProcessPlan("/root", "/f", "n", "u", () => false), null);
  });
});
