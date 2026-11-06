import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

describe("the strip of what the site does for him, with a key on file and the manual last read two months ago", () => {
  let cleanup: () => void;
  let automationStatus: typeof import("../src/lib/automation-status").automationStatus;

  before(async () => {
    const { useScratchDb } = await import("./support/scratch-db");
    cleanup = await useScratchDb();
    const { setSetting } = await import("../src/lib/settings");
    await setSetting("anthropic_api_key_enc", "not-a-real-key");
    await setSetting("manual_audit_last", new Date(Date.now() - 60 * 24 * 3_600_000).toISOString());
    ({ automationStatus } = await import("../src/lib/automation-status"));
  });
  after(() => cleanup?.());

  test("no job on it is about the manual, because nothing reads the manual unless a button is pressed", async () => {
    const jobs = await automationStatus();
    const aboutTheManual = jobs.filter((j) => /manual/i.test(`${j.key} ${j.label} ${j.href}`));
    assert.deepEqual(aboutTheManual.map((j) => `${j.key}: ${j.state}`), []);
  });

  test("the jobs that remain are all still there", async () => {
    const keys = (await automationStatus()).map((j) => j.key);
    for (const k of ["temps", "backup", "mail", "cqi", "digest", "reminders", "nadac"]) assert.ok(keys.includes(k), `${k} is a job`);
  });
});
