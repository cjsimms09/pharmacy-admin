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

/**
 * The same walk, bounded, for an archive nobody vouches for.
 *
 * `readZip` above inflates every entry with no ceiling, which is right for the two federal files:
 * the site fetched them itself from a known address. An attachment is different. A zip is a
 * compressed format, so a small one can describe an enormous one — a few hundred kilobytes that
 * inflate to gigabytes is a well known shape of attack, and the pharmacy's mailbox accepts files
 * from anyone a sender rule allows. Reading such an archive with `readZip` would take the site down
 * with the counter open.
 *
 * So this one refuses rather than finishes: at most `maxEntries` files, each inflated under a hard
 * `maxBytesPerEntry` ceiling that `zlib` itself enforces, and an entry that breaches it is skipped
 * rather than thrown over — one hostile member should not hide the honest one beside it. A damaged
 * archive comes back empty rather than raising, because the caller is asking "is there one of these
 * in here", and the answer for something unreadable is no.
 *
 * Deliberately not a replacement for `readZip`. That one must keep throwing: a truncated FDA
 * download has to be an error, not a quietly shorter directory.
 */
export function readZipBounded(
  buf: Buffer,
  opts: { maxEntries?: number; maxBytesPerEntry?: number } = {},
): ZipEntry[] {
  const maxEntries = opts.maxEntries ?? 20;
  const maxBytesPerEntry = opts.maxBytesPerEntry ?? 8 * 1024 * 1024;
  const out: ZipEntry[] = [];
  try {
    if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return out;
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return out;
    const count = Math.min(buf.readUInt16LE(eocd + 10), maxEntries);
    let p = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
      const method = buf.readUInt16LE(p + 10);
      const compressed = buf.readUInt32LE(p + 20);
      /* The size the archive itself claims. A lie here is caught by the ceiling below; a truthful
       * one saves inflating something there is no point inflating. */
      const declared = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const local = buf.readUInt32LE(p + 42);
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith("/")) continue;
      if (declared > maxBytesPerEntry) continue;
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) continue;
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + compressed);
      try {
        if (method === 0) out.push({ name, data: Buffer.from(raw.subarray(0, maxBytesPerEntry)) });
        else if (method === 8) out.push({ name, data: zlib.inflateRawSync(raw, { maxOutputLength: maxBytesPerEntry }) });
      } catch {
        // A bomb, or a member this reader does not handle. Skip it; the next one may be the file.
      }
    }
  } catch {
    // A damaged archive is not an archive holding what we asked about.
    return out;
  }
  return out;
}
