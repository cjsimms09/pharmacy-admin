import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createZip } from "../src/lib/zip";
import { unzip } from "../src/lib/xlsx";
import { sha256 } from "../src/lib/crypto";

/**
 * What a restore rehearsal has to catch.
 *
 * The rehearsal itself needs a database and a filesystem, so it is exercised by hand on the real
 * archives. What is worth pinning here is the check it leans on: an archive whose database has
 * been altered since it was written must not pass, because the failure this exists to catch —
 * a sync client replacing a file, a bad USB stick, silent corruption — looks exactly like a
 * perfectly good ZIP until the bytes are hashed.
 */
describe("archive integrity", () => {
  const db = Buffer.from("SQLite format 3\0the rest of a database");

  test("an untouched archive hashes to what its manifest says", () => {
    const manifest = { databaseSha256: sha256(db) };
    const zip = createZip([
      { name: "pharmacy-admin.db", data: db },
      { name: "MANIFEST.json", data: Buffer.from(JSON.stringify(manifest)) },
    ]);
    const back = unzip(zip);
    assert.equal(sha256(back.get("pharmacy-admin.db")!), manifest.databaseSha256);
  });

  test("a single changed byte is caught", () => {
    const manifest = { databaseSha256: sha256(db) };
    const damaged = Buffer.from(db);
    damaged[20] ^= 0x01;
    const zip = createZip([
      { name: "pharmacy-admin.db", data: damaged },
      { name: "MANIFEST.json", data: Buffer.from(JSON.stringify(manifest)) },
    ]);
    assert.notEqual(sha256(unzip(zip).get("pharmacy-admin.db")!), manifest.databaseSha256);
  });

  test("a truncated database is caught", () => {
    const manifest = { databaseSha256: sha256(db) };
    const zip = createZip([
      { name: "pharmacy-admin.db", data: db.subarray(0, 10) },
      { name: "MANIFEST.json", data: Buffer.from(JSON.stringify(manifest)) },
    ]);
    assert.notEqual(sha256(unzip(zip).get("pharmacy-admin.db")!), manifest.databaseSha256);
  });

  test("an archive with no database in it is not a backup", () => {
    const zip = createZip([{ name: "HOW-TO-RESTORE.txt", data: Buffer.from("oops") }]);
    assert.equal(unzip(zip).get("pharmacy-admin.db"), undefined);
  });

  test("uploaded documents travel under files/ so they can be counted", () => {
    const zip = createZip([
      { name: "pharmacy-admin.db", data: db },
      { name: "files/a.pdf", data: Buffer.from("a") },
      { name: "files/sub/b.pdf", data: Buffer.from("b") },
      { name: "MANIFEST.json", data: Buffer.from("{}") },
    ]);
    assert.equal(Array.from(unzip(zip).keys()).filter((k) => k.startsWith("files/")).length, 2);
  });
});
