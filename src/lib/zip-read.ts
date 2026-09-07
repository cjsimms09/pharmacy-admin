import zlib from "node:zlib";

/**
 * Reads the files out of a zip archive, in memory.
 *
 * The two federal drug files arrive as zips, and the site has no zip library. What it needs is
 * small: walk the central directory at the end of the archive, and for each entry inflate the
 * bytes the local header points at. Only the two compression methods those archives use are
 * handled — stored, and deflate — and anything else is refused by name rather than silently
 * yielding garbage. Pure, no disk.
 */
export type ZipEntry = { name: string; data: Buffer };

export function readZip(buf: Buffer): ZipEntry[] {
  // End of central directory record: signature 0x06054b50, searched from the end (a comment may follow it).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip archive: no end-of-central-directory record.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Zip central directory is damaged.");
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`Zip entry "${name}" has a damaged local header.`);
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compressed);
    if (name.endsWith("/")) continue;
    if (method === 0) out.push({ name, data: Buffer.from(raw) });
    else if (method === 8) out.push({ name, data: zlib.inflateRawSync(raw) });
    else throw new Error(`Zip entry "${name}" uses compression method ${method}, which this reader does not handle.`);
  }
  return out;
}
