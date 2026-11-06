import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createZip, crc32 } from "../src/lib/zip";
import { unzip } from "../src/lib/xlsx";

/**
 * A backup nobody can open is not a backup. These check the archives this writes are readable by
 * something other than the code that wrote them — the reader here was written separately, for
 * spreadsheets, and does not share a line with the writer.
 */
describe("createZip", () => {
  test("round-trips through an independently written reader", () => {
    const files = [
      { name: "a.txt", data: Buffer.from("hello") },
      { name: "nested/b.json", data: Buffer.from(JSON.stringify({ x: 1 })) },
    ];
    const out = unzip(createZip(files));
    assert.equal(out.get("a.txt")!.toString(), "hello");
    assert.equal(out.get("nested/b.json")!.toString(), '{"x":1}');
  });

  test("a large compressible file survives intact", () => {
    const data = Buffer.from("the same line over and over\n".repeat(20_000));
    const zipped = createZip([{ name: "big.txt", data }]);
    assert.ok(zipped.length < data.length / 5, "should actually compress");
    assert.ok(unzip(zipped).get("big.txt")!.equals(data));
  });

  test("binary content is byte-identical after a round trip", () => {
    const data = Buffer.alloc(5000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 13) % 256;
    assert.ok(unzip(createZip([{ name: "db.sqlite", data }])).get("db.sqlite")!.equals(data));
  });

  test("already-compressed data is stored rather than grown", () => {
    // Random bytes deflate to more than they started as; storing keeps the archive honest.
    const data = Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 2654435761) % 256));
    const zipped = createZip([{ name: "r.bin", data }]);
    assert.ok(unzip(zipped).get("r.bin")!.equals(data));
  });

  test("an empty file is a valid entry", () => {
    assert.equal(unzip(createZip([{ name: "empty", data: Buffer.alloc(0) }])).get("empty")!.length, 0);
  });

  test("unicode filenames survive", () => {
    const out = unzip(createZip([{ name: "café/naïve.txt", data: Buffer.from("x") }]));
    assert.ok(out.has("café/naïve.txt"), [...out.keys()].join(","));
  });

  test("many entries all come back", () => {
    const files = Array.from({ length: 250 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from(`row ${i}`) }));
    const out = unzip(createZip(files));
    assert.equal(out.size, 250);
    assert.equal(out.get("f249.txt")!.toString(), "row 249");
  });
});

describe("crc32", () => {
  test("matches the known value for a standard input", () => {
    // The canonical CRC-32 of "123456789".
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  });
  test("empty input is zero", () => {
    assert.equal(crc32(Buffer.alloc(0)), 0);
  });
});

import { pruneBackups } from "../src/lib/backup";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("pruneBackups", () => {
  const mk = async (names: string[]) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pa-prune-"));
    for (const n of names) await fs.writeFile(path.join(dir, n), "x");
    return dir;
  };
  const names = (n: number) =>
    Array.from({ length: n }, (_, i) => `pharmacy-admin-backup-2026-09-${String(i + 1).padStart(2, "0")}T00-00-00.zip`);

  test("keeps the newest and deletes the rest", async () => {
    const dir = await mk(names(5));
    assert.equal(await pruneBackups(dir, 2), 3);
    const left = (await fs.readdir(dir)).sort();
    assert.deepEqual(left, ["pharmacy-admin-backup-2026-09-04T00-00-00.zip", "pharmacy-admin-backup-2026-09-05T00-00-00.zip"]);
  });

  test("deletes nothing when there are fewer than the number to keep", async () => {
    const dir = await mk(names(2));
    assert.equal(await pruneBackups(dir, 14), 0);
  });

  test("never deletes the last one, whatever it is asked", async () => {
    // A keep count of zero must not leave the pharmacy with no backup at all.
    const dir = await mk(names(3));
    await pruneBackups(dir, 0);
    assert.equal((await fs.readdir(dir)).length, 1);
  });

  test("leaves files that are not backups alone", async () => {
    const dir = await mk([...names(3), "invoice.pdf", "notes.txt"]);
    await pruneBackups(dir, 1);
    const left = await fs.readdir(dir);
    assert.ok(left.includes("invoice.pdf") && left.includes("notes.txt"));
  });

  test("a folder that does not exist is not an error", async () => {
    assert.equal(await pruneBackups(path.join(os.tmpdir(), "pa-nope-" + Date.now()), 5), 0);
  });
});
