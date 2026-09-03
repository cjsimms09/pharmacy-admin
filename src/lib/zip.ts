import zlib from "node:zlib";

/**
 * Writing a ZIP, in about eighty lines.
 *
 * The reader in xlsx.ts made a dependency unnecessary for reading; this does the same for
 * writing, and keeps the backup format something any computer on earth can open without this
 * application. That last part is the point: a backup readable only by the software that made it
 * is not a backup, it is a hostage.
 */

type Entry = { name: string; data: Buffer; crc: number; compressed: Buffer; offset: number };

/** CRC-32, as ZIP requires. Table built once. */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date and time, which is what the ZIP header carries. */
function dosStamp(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function createZip(files: { name: string; data: Buffer }[], now = new Date()): Buffer {
  const { time, date } = dosStamp(now);
  const entries: Entry[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const compressed = zlib.deflateRawSync(f.data, { level: 6 });
    // Deflate can exceed the original on already-compressed data; store it plainly if so.
    const useStore = compressed.length >= f.data.length;
    const payload = useStore ? f.data : compressed;
    const method = useStore ? 0 : 8;
    const crc = crc32(f.data);
    const nameBuf = Buffer.from(f.name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(1 << 11, 6); // UTF-8 filenames
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, payload);
    entries.push({ name: f.name, data: f.data, crc, compressed: payload, offset });
    offset += local.length + nameBuf.length + payload.length;
  }

  const dirStart = offset;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const useStore = e.compressed === e.data;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(1 << 11, 8);
    central.writeUInt16LE(useStore ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.compressed.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 42); // local header offset, set below
    central.writeUInt32LE(e.offset, 42);
    chunks.push(central, nameBuf);
    offset += central.length + nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(offset - dirStart, 12);
  eocd.writeUInt32LE(dirStart, 16);
  chunks.push(eocd);

  return Buffer.concat(chunks);
}
