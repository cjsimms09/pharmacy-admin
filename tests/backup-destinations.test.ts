import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cloudFoldersFromEnv, backupFolderIn, isInside } from "../src/lib/cloud-folders";

/**
 * Three copies, on two kinds of media, one of them off the premises.
 *
 * The old rule, and the reason there is a third place at all. A USB drive in a drawer and a synced
 * cloud folder fail in completely different ways — one to a fire or a theft, the other to an
 * account being closed or a sync being paused — and neither of them is the pharmacy computer,
 * which is the failure the whole thing exists for.
 */
describe("where a copy may go", () => {
  test("each destination gets its own folder, so two clouds cannot collide", () => {
    assert.notEqual(backupFolderIn("/a/OneDrive"), backupFolderIn("/a/My Drive"));
  });

  test("a folder already in use is recognised however it was typed", () => {
    const drive = { label: "Google Drive", path: "/home/x/My Drive", kind: "other" as const, baaAvailable: false };
    assert.equal(isInside("/home/x/My Drive/PharmacyAdminBackups", drive), true);
    assert.equal(isInside("/home/x/My Drive", drive), true);
    // The near-miss that would otherwise let the same folder be set twice under two names.
    assert.equal(isInside("/home/x/My Drive Backup", drive), false);
  });
});

/**
 * Google Drive announces itself nowhere.
 *
 * OneDrive writes its path into an environment variable; Google Drive for desktop mounts a virtual
 * drive letter and says nothing. That means the only way to find it is to try the likely places —
 * and trying them must never turn into offering a path that is not there, which is what the
 * environment reader is forbidden from doing.
 */
describe("what the environment reader is allowed to offer", () => {
  test("nothing configured means nothing offered, even now Google Drive is looked for", () => {
    assert.deepEqual(cloudFoldersFromEnv({}), []);
  });

  test("a drive letter is never offered from the environment alone", () => {
    // The G: candidates exist, but only inside the disk check — a folder is offered when it is
    // really there, never because it usually is.
    const found = cloudFoldersFromEnv({ USERPROFILE: "C:\\Users\\wwfprx" });
    assert.ok(!found.some((f) => /^[A-Z]:\\\\?My Drive/.test(f.path)), found.map((f) => f.path).join(", "));
  });

  test("a Google or Dropbox folder under the profile is offered, because the profile is configured", () => {
    const found = cloudFoldersFromEnv({ HOME: "/home/wwfprx" });
    const paths = found.map((f) => f.path);
    assert.ok(paths.some((p) => p.endsWith("My Drive")), paths.join(", "));
    assert.ok(paths.some((p) => p.endsWith("Dropbox")), paths.join(", "));
  });

  test("only a OneDrive work account claims an agreement is available", () => {
    // Google will sign one for Workspace and not for a personal account; nothing about the folder
    // on disk says which the pharmacy has, so it must not be asserted either way.
    for (const f of cloudFoldersFromEnv({ HOME: "/home/x" })) {
      assert.equal(f.baaAvailable, false, `${f.label} must not claim an agreement`);
    }
    assert.equal(cloudFoldersFromEnv({ OneDriveCommercial: "C:\\x\\OneDrive - WWFP" })[0].baaAvailable, true);
  });
});
