import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cloudFoldersFromEnv, backupFolderIn, isInside } from "../src/lib/cloud-folders";

/**
 * Finding the synced folder, so the off-site copy actually gets set up.
 *
 * A backup that exists only on the pharmacy computer covers nothing that takes the computer. The
 * second copy has to be somewhere else, and on a Windows machine the realistic somewhere else is
 * a OneDrive folder that is already signed in. Windows says where that is; asking a pharmacist to
 * find and retype it is how this ends up never configured.
 */
describe("finding synced folders", () => {
  test("a work account is offered first, because it is the one that can be covered by an agreement", () => {
    const found = cloudFoldersFromEnv({
      OneDriveConsumer: "C:\\Users\\wwfprx\\OneDrive",
      OneDriveCommercial: "C:\\Users\\wwfprx\\OneDrive - West Wichita Family Pharmacy",
    });
    assert.equal(found[0].kind, "business");
    assert.equal(found[0].baaAvailable, true);
    assert.equal(found[1].kind, "personal");
    assert.equal(found[1].baaAvailable, false);
  });

  test("the primary variable is not offered twice when it names a folder already found", () => {
    const found = cloudFoldersFromEnv({
      OneDriveCommercial: "C:\\Users\\wwfprx\\OneDrive - WWFP",
      OneDrive: "C:\\Users\\wwfprx\\OneDrive - WWFP",
    });
    assert.equal(found.length, 1);
  });

  test("a lone OneDrive variable is read for which kind of account it is", () => {
    // Windows names a work folder "OneDrive - Company" and a personal one plain "OneDrive".
    assert.equal(cloudFoldersFromEnv({ OneDrive: "C:\\Users\\a\\OneDrive - Acme" })[0].baaAvailable, true);
    assert.equal(cloudFoldersFromEnv({ OneDrive: "C:\\Users\\a\\OneDrive" })[0].baaAvailable, false);
  });

  test("nothing configured means nothing offered, rather than a guessed path", () => {
    assert.deepEqual(cloudFoldersFromEnv({}), []);
    assert.deepEqual(cloudFoldersFromEnv({ OneDrive: "   " }), []);
  });
});

describe("where in the synced folder the archives go", () => {
  test("their own folder, not the root of somebody's documents", () => {
    assert.equal(backupFolderIn("/home/x/OneDrive"), path.join("/home/x/OneDrive", "PharmacyAdminBackups"));
  });

  test("a destination already inside it is recognised, so the button does not offer to set it again", () => {
    const folder = { label: "OneDrive", path: "/home/x/OneDrive", kind: "personal" as const, baaAvailable: false };
    assert.equal(isInside("/home/x/OneDrive/PharmacyAdminBackups", folder), true);
    assert.equal(isInside("/home/x/OneDrive", folder), true);
    assert.equal(isInside("/home/x/OneDriveOther/Backups", folder), false);
    assert.equal(isInside("", folder), false);
  });
});
