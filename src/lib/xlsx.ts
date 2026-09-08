import zlib from "node:zlib";

/**
 * A minimal reader for the .xlsx files PioneerRx produces.
 *
 * Written rather than pulled in as a dependency because the need is narrow — read the first
 * sheet of a well-formed file into rows of strings — and because everything that touches claim
 * data is going to be read by someone eventually. A hundred lines that can be checked beats a
 * library whose failure modes are somebody else's.
 *
 * An .xlsx is a ZIP of XML. Two parts matter: xl/sharedStrings.xml holds every distinct string
 * in the workbook, and xl/worksheets/sheet1.xml holds cells that reference them by index.
 *
 * The rule throughout: a cell that cannot be read becomes an empty string, never a guess. A
 * misread number in a claims file is worse than a missing one, because a missing one is visible.
 */

type ZipEntry = { name: string; data: Buffer };

/**
 * Reads a ZIP by walking its central directory.
 *
 * The central directory is authoritative — scanning for local file headers instead would trip
 * over the signature bytes appearing inside compressed data.
 */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();

  // End of central directory: signature 0x06054b50, within the last 64KB (comment field).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a readable .xlsx file — no ZIP directory found.");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    // The local header repeats the name and extra fields, at its own lengths.
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    try {
      out.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
    } catch {
      // A part we cannot inflate is skipped rather than failing the whole file: the sheet may
      // still be readable when some unrelated part is not.
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Concatenates every <t> in a shared-string item, so rich text with runs reads as one string. */
function textOf(xml: string): string {
  const parts = xml.match(/<t[^>]*>([\s\S]*?)<\/t>/g);
  if (!parts) return "";
  return decodeXml(parts.map((p) => p.replace(/^<t[^>]*>|<\/t>$/g, "")).join(""));
}

function sharedStrings(zip: Map<string, Buffer>): string[] {
  const raw = zip.get("xl/sharedStrings.xml");
  if (!raw) return [];
  const xml = raw.toString("utf8");
  return (xml.match(/<si>[\s\S]*?<\/si>/g) ?? []).map(textOf);
}

/** "BC12" -> 54. Column letters are base-26 with no zero. */
export function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Excel stores dates as a day count from 1899-12-30.
 *
 * PioneerRx sends Date Filled this way — 46262 rather than a date — so this converts it. The
 * range check refuses anything outside 1970 to 2100: a quantity or a dollar amount that landed
 * in a date column must not come back as a plausible-looking date.
 */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 25_569 || serial > 73_050) return null;
  const ms = Math.round((serial - 25_569) * 86_400_000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Reads the first worksheet into rows of strings, with the header row first.
 *
 * Cells are placed by their own column reference rather than by order, so a row that omits empty
 * trailing cells — which Excel does — still lines up with its header.
 */
/**
 * Every worksheet in the workbook, by its tab name, in the workbook's own order.
 *
 * The PSAO's network guide is fourteen tabs — rates by line of business, a BIN list, and a
 * crosswalk per PBM from network reimbursement id to network — and the first tab is a change log.
 * A reader that takes only the first sheet reads the change log and calls it the guide.
 */
export function readSheets(file: Buffer): { name: string; rows: string[][] }[] {
  const zip = unzip(file);
  const strings = sharedStrings(zip);
  const wb = zip.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = zip.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const target = new Map<string, string>();
  const inXl = (p: string) => "xl/" + p.replace(/^\/?(xl\/)?/, "");
  for (const m of rels.matchAll(/<Relationship\s[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g)) target.set(m[1], inXl(m[2]));
  for (const m of rels.matchAll(/<Relationship\s[^>]*?Target="([^"]+)"[^>]*?Id="([^"]+)"/g)) if (!target.has(m[2])) target.set(m[2], inXl(m[1]));
  const out: { name: string; rows: string[][] }[] = [];
  for (const m of wb.matchAll(/<sheet\s[^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g)) {
    const path = target.get(m[2]);
    const xml = path ? zip.get(path)?.toString("utf8") : undefined;
    if (!xml) continue;
    out.push({ name: decodeXml(m[1]).trim(), rows: rowsOf(xml, strings) });
  }
  return out;
}

function rowsOf(xml: string, strings: string[]): string[][] {
  const rows: string[][] = [];
  for (const rowXml of xml.match(/<row[^>]*>[\s\S]*?<\/row>|<row[^>]*\/>/g) ?? []) {
    const cells: string[] = [];
    for (const m of rowXml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1] ?? "";
      const body = m[2] ?? "";
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      const at = ref ? columnIndex(ref) : cells.length;
      let value = "";
      if (type === "inlineStr") value = textOf(body);
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined) {
          if (type === "s") {
            const i = Number(v);
            value = Number.isInteger(i) && i >= 0 && i < strings.length ? strings[i] : "";
          } else value = decodeXml(v);
        }
      }
      while (cells.length < at) cells.push("");
      cells[at] = value;
    }
    rows.push(cells);
  }
  return rows;
}
export function readSheet(file: Buffer): string[][] {
  const zip = unzip(file);
  const strings = sharedStrings(zip);

  const sheetName =
    [...zip.keys()].find((k) => /^xl\/worksheets\/sheet1\.xml$/i.test(k)) ??
    [...zip.keys()].find((k) => /^xl\/worksheets\/.*\.xml$/i.test(k));
  if (!sheetName) throw new Error("No worksheet found in that file.");

  const xml = zip.get(sheetName)!.toString("utf8");
  const rows: string[][] = [];

  for (const rowXml of xml.match(/<row[^>]*>[\s\S]*?<\/row>|<row[^>]*\/>/g) ?? []) {
    const cells: string[] = [];
    for (const m of rowXml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1] ?? "";
      const body = m[2] ?? "";
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      const at = ref ? columnIndex(ref) : cells.length;

      let value = "";
      if (type === "inlineStr") {
        value = textOf(body);
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined) {
          if (type === "s") {
            const i = Number(v);
            value = Number.isInteger(i) && i >= 0 && i < strings.length ? strings[i] : "";
          } else {
            value = decodeXml(v);
          }
        }
      }
      while (cells.length < at) cells.push("");
      cells[at] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/** Rows keyed by their header, the shape the rest of the import works in. */
export function readSheetAsObjects(file: Buffer): Record<string, string>[] {
  const rows = readSheet(file).filter((r) => r.some((c) => c.trim() !== ""));
  const [head, ...body] = rows;
  if (!head) return [];
  const headers = head.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
}
