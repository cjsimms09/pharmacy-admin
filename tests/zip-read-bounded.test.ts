import { test, describe } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { readZip, readZipBounded } from "../src/lib/zip-read";

/**
 * The bounded zip reader, and the claim it exists to make good.
 *
 * `readZipBounded` was added so an archive arriving by email or SFTP could be asked whether it holds
 * a remittance. That means walking a file nobody vouches for, and a zip is the format in which
 * something small describes something enormous: a few kilobytes of deflated zeros expands to
 * gigabytes, and the site runs in one process on the pharmacy's own computer with the counter open.
 *
 * So the docstring on that function makes a promise — bounded entries, a hard ceiling zlib itself
 * enforces, a breaching member skipped rather than the archive discarded — and a promise about
 * safety that nobody has tried to break is not evidence of anything. These are the attempts.
 */

/** An archive built to order, so every byte under test is one this reader will actually walk. */
function zipOf(entries: { name: string; data: Buffer; deflate?: boolean; declaredSize?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const body = e.deflate ? zlib.deflateRawSync(e.data, { level: 9 }) : e.data;
    const method = e.deflate ? 8 : 0;
    const declared = e.declaredSize ?? e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(declared, 22);
    lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, body]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(declared, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

/** 64 MB of zeros, which deflates to a few tens of kilobytes. The classic shape of the attack. */
const BOMB = Buffer.alloc(64 * 1024 * 1024, 0);

describe("readZipBounded refuses what readZip would swallow", () => {
  test("a bomb that declares its true size is skipped before anything is inflated", () => {
    const zip = zipOf([{ name: "big.txt", data: BOMB, deflate: true }]);
    assert.ok(zip.length < 200_000, `the archive is small — ${zip.length} bytes describing 64 MB`);
    assert.deepEqual(readZipBounded(zip), []);
  });

  test("and a bomb that lies about its size is stopped by the ceiling, not by trust", () => {
    // The central directory says 1 KB; the deflate stream is 64 MB. Only zlib's own
    // maxOutputLength can catch this, which is the reason it is passed rather than assumed.
    const zip = zipOf([{ name: "liar.txt", data: BOMB, deflate: true, declaredSize: 1024 }]);
    assert.deepEqual(readZipBounded(zip), []);
  });

  test("the honest file beside a hostile one still comes back", () => {
    // A member that breaches the ceiling is skipped, not thrown over: one bad entry must not hide
    // the remittance sitting next to it, which is the whole point of asking the archive at all.
    const zip = zipOf([
      { name: "big.txt", data: BOMB, deflate: true, declaredSize: 1024 },
      { name: "REMIT.835", data: Buffer.from("ISA*00*...~ST*835*0001~"), deflate: true },
    ]);
    const out = readZipBounded(zip);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "REMIT.835");
  });

  test("an archive of ordinary files is read as usual", () => {
    const zip = zipOf([
      { name: "a.txt", data: Buffer.from("hello"), deflate: true },
      { name: "b/c.csv", data: Buffer.from("ndc,price\n00093721410,1.23\n") },
    ]);
    const out = readZipBounded(zip);
    assert.deepEqual(out.map((e) => e.name), ["a.txt", "b/c.csv"]);
    assert.equal(out[1].data.toString(), "ndc,price\n00093721410,1.23\n");
  });

  test("more entries than the cap allows are not walked", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from(`${i}`) }));
    assert.equal(readZipBounded(zipOf(many)).length, 20);
    assert.equal(readZipBounded(zipOf(many), { maxEntries: 3 }).length, 3);
  });

  test("rubbish, a truncated archive and an empty buffer are all simply not archives", () => {
    for (const buf of [Buffer.alloc(0), Buffer.from("not a zip at all"), zipOf([{ name: "a.txt", data: Buffer.from("hello") }]).subarray(0, 30)]) {
      assert.deepEqual(readZipBounded(buf), []);
    }
  });

  /*
   * And the reason both functions exist.
   *
   * `readZip` must keep throwing on a damaged archive: it reads the two federal downloads, and a
   * truncated one has to be an error rather than a quietly shorter drug directory. If this ever
   * starts returning instead of throwing, the FDA loader has lost a guard it depends on.
   */
  test("readZip still throws where readZipBounded shrugs", () => {
    assert.throws(() => readZip(Buffer.from("not a zip at all")), /no end-of-central-directory/i);
    assert.deepEqual(readZipBounded(Buffer.from("not a zip at all")), []);
  });
});
