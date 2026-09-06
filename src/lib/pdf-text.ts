import zlib from "node:zlib";

/**
 * Pulling the words back out of a PDF, without a library.
 *
 * Wholesaler invoices arrive as generated PDFs — laid out by the supplier's own printing system,
 * with the text present as text rather than as a picture of text. That means the schedule column
 * the wholesaler already prints can simply be read, and a supplier invoice does not have to be
 * looked at by a model to work out what it carries.
 *
 * That matters more than saving a call. A rule that reads the column the supplier printed gives
 * the same answer every time, costs nothing, works with no API key, and can be tested. Judgement
 * is kept for the documents that actually need it: a scan, an unfamiliar layout, a supplier who
 * prints no schedule at all.
 *
 * Deliberately small. It reconstructs lines well enough to read a table, and does not attempt to
 * be a PDF renderer — a page it cannot read comes back empty, which the caller treats as "ask
 * somebody" rather than as "no controlled substances".
 */

/**
 * Text placement and text showing, in the order they appear.
 *
 * Both are needed together: the font in force decides how the bytes are read, and the position
 * decides which row of the table they belong to. Matching them separately would put a Schedule II
 * marking next to the wrong item, which is the one mistake that matters here.
 */
const TOKENS =
  /(BT)\b|\/([A-Za-z0-9_.+-]+)\s+[\d.]+\s+Tf|([\d.-]+)\s+([\d.-]+)\s+T[dD]\b|(?:[\d.-]+\s+){4}([\d.-]+)\s+([\d.-]+)\s+Tm|(?:<([0-9A-Fa-f\s]+)>|\(((?:[^()\\]|\\.)*)\))\s*Tj/g;

function inflate(chunk: Buffer): string | null {
  try {
    return zlib.inflateSync(chunk).toString("latin1");
  } catch {
    try {
      return zlib.inflateRawSync(chunk).toString("latin1");
    } catch {
      return null;
    }
  }
}

/**
 * The character map a subset font carries, when it carries one.
 *
 * A PDF that embeds only the glyphs it uses renumbers them, so the bytes in the content stream
 * are not letters — they are indexes into that font. One wholesaler's invoices came out as
 * "3\"L#M#\"L#\"J\'$N%OP%HQ\'" for exactly this reason, which is not a corrupt file: it is a
 * perfectly ordinary Crystal Reports document whose fonts were subset.
 *
 * The PDF has to supply a ToUnicode map for such a font, and it does. Reading it is the
 * difference between this working for one supplier and working for the ones the pharmacy has
 * not signed up with yet, so it is worth the fifty lines.
 */
/**
 * A font's character map, and how many bytes one character code takes.
 *
 * The width is not a detail. A Type0 font with Identity encoding — which is what every modern
 * generator produces for anything but plain Latin — writes each character as **two** bytes, and a
 * reader that takes them one at a time looks up the wrong glyph for every letter on the page. It
 * does not fail: it returns confident nonsense. "Th", ".Tss:", "Fs;." was a McKesson returns policy
 * read that way, and a purchase report came back as scrambled column headings with the figures
 * shuffled between them.
 */
type FontMap = { map: Map<number, string>; width: 1 | 2 };
type FontMaps = Map<string, FontMap>;

/** Every "N 0 obj ... endobj" in the file, by object number. */
function objects(buf: Buffer): Map<number, { body: string; stream: Buffer | null }> {
  const text = buf.toString("latin1");
  const out = new Map<number, { body: string; stream: Buffer | null }>();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = text.indexOf("endobj", start);
    if (end < 0) continue;
    const body = text.slice(start, end);
    let stream: Buffer | null = null;
    const sIdx = body.indexOf("stream");
    if (sIdx >= 0) {
      let from = start + sIdx + 6;
      if (buf[from] === 13) from++;
      if (buf[from] === 10) from++;
      const to = text.indexOf("endstream", from);
      if (to > from) stream = buf.subarray(from, to);
    }
    out.set(num, { body, stream });
  }
  return out;
}

/**
 * bfchar and bfrange entries, turned into code to text, with the width of a code.
 *
 * The width comes from the codespace range the CMap declares — "<0000> <FFFF>" is two bytes,
 * "<00> <FF>" is one. Where a map declares none, the length of the codes it actually uses settles
 * it, because a two-byte font's entries are written as four hex digits.
 */
function parseToUnicode(cmap: string): FontMap {
  const map = new Map<number, string>();
  let width: 1 | 2 = 1;
  const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(cmap);
  const firstCode = space ? /<([0-9A-Fa-f]+)>/.exec(space[1]) : null;
  if (firstCode && firstCode[1].length >= 4) width = 2;
  const hexToStr = (h: string) => {
    let s = "";
    for (let i = 0; i + 3 < h.length + 1; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return s.replace(/\u0000/g, "");
  };

  for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      if (m[1].length >= 4) width = 2;
      map.set(parseInt(m[1], 16), hexToStr(m[2]));
    }
  }
  for (const block of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const base = parseInt(m[3], 16);
      // A range longer than a page of glyphs is a malformed map, not a font.
      if (hi < lo || hi - lo > 65535) continue;
      if (m[1].length >= 4) width = 2;
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(base + (c - lo)));
    }
  }
  return { map, width };
}

/** Resource name (F1, TT2) to that font's character map, for every font that has one. */
function fontMaps(buf: Buffer): FontMaps {
  const objs = objects(buf);
  const byObject = new Map<number, FontMap>();

  for (const [, o] of objs) {
    if (!/\/Type\s*\/Font\b/.test(o.body)) continue;
    const ref = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(o.body);
    if (!ref) continue;
    const cmapObj = objs.get(Number(ref[1]));
    if (!cmapObj?.stream) continue;
    const text = inflate(cmapObj.stream) ?? cmapObj.stream.toString("latin1");
    const parsed = parseToUnicode(text);
    if (parsed.map.size > 0) byObject.set(Number(ref[1]), parsed);
  }
  if (byObject.size === 0) return new Map();

  // Tie each map back to the /Fx name the content stream will use for it.
  const out: FontMaps = new Map();
  for (const [, o] of objs) {
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(o.body);
    if (!fontDict) continue;
    for (const m of fontDict[1].matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+\d+\s+R/g)) {
      const fontObj = objs.get(Number(m[2]));
      const ref = fontObj ? /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fontObj.body) : null;
      const map = ref ? byObject.get(Number(ref[1])) : undefined;
      if (map) out.set(m[1], map);
    }
  }
  return out;
}

/** Undoes the escapes a literal PDF string can carry. */
function unescape(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c: string) => {
    if (c === "n") return "\n";
    if (c === "r") return "\r";
    if (c === "t") return "\t";
    if (c === "b" || c === "f") return " ";
    if (c === "(" || c === ")" || c === "\\") return c;
    return String.fromCharCode(parseInt(c, 8));
  });
}

/**
 * The text of a PDF, as lines, in the order somebody reading it would see them.
 *
 * Fragments are grouped by their vertical position and sorted by their horizontal one, because a
 * generated invoice places each cell separately and the schedule code is only meaningful next to
 * the item it belongs to. Reading the operators in file order would scatter the columns.
 */
/**
 * One run of text, and where on the page it was drawn.
 *
 * A report laid out in tiles puts several unrelated figures on the same baseline, so joining a
 * page by line alone interleaves them beyond recovery — which is what made McKesson's drill-down
 * look unreadable even after the positions were being computed correctly. A parser that has the
 * x as well can read a column.
 */
export type PdfItem = { page: number; x: number; y: number; text: string };

/** Every run of text on every page, with its position. `pdfText` is this, joined by line. */
export function pdfItems(buf: Buffer): PdfItem[] {
  const items: PdfItem[] = [];
  const fonts = (() => {
    try {
      return fontMaps(buf);
    } catch {
      return new Map() as FontMaps;
    }
  })();
  let i = 0;
  let page = 0;

  while (true) {
    const s = buf.indexOf("stream", i);
    if (s < 0) break;
    let start = s + 6;
    if (buf[start] === 13) start++;
    if (buf[start] === 10) start++;
    const end = buf.indexOf("endstream", start);
    if (end < 0) break;

    const raw = buf.subarray(start, end);
    const text = inflate(raw) ?? raw.toString("latin1");
    i = end + 9;
    if (!text.includes("Td") && !text.includes("Tm")) continue;
    page++;

    let m: RegExpExecArray | null;
    let font: FontMap | undefined;
    let x = 0;
    let y = 0;
    TOKENS.lastIndex = 0;

    while ((m = TOKENS.exec(text))) {
      if (m[1] !== undefined) {
        x = 0;
        y = 0;
        continue;
      }
      if (m[2] !== undefined) {
        font = fonts.get(m[2]);
        continue;
      }
      if (m[3] !== undefined && m[4] !== undefined) {
        x += Number.parseFloat(m[3]);
        y += Number.parseFloat(m[4]);
        continue;
      }
      if (m[5] !== undefined && m[6] !== undefined) {
        x = Number.parseFloat(m[5]);
        y = Number.parseFloat(m[6]);
        continue;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const bytes = m[7]
        ? Buffer.from(m[7].replace(/\s+/g, ""), "hex")
        : Buffer.from(unescape(m[8] ?? ""), "latin1");
      if (bytes.length === 0) continue;
      const piece = font ? decode(bytes, font) : plain(bytes);
      if (!piece.trim()) continue;
      items.push({ page, x, y, text: piece });
    }
  }
  return items;
}

export function pdfText(buf: Buffer): string {
  const out: string[] = [];
  const fonts = (() => {
    try {
      return fontMaps(buf);
    } catch {
      // A font table this cannot read is not a reason to give up on the text.
      return new Map() as FontMaps;
    }
  })();
  let i = 0;

  while (true) {
    const s = buf.indexOf("stream", i);
    if (s < 0) break;
    let start = s + 6;
    if (buf[start] === 13) start++;
    if (buf[start] === 10) start++;
    const end = buf.indexOf("endstream", start);
    if (end < 0) break;

    const raw = buf.subarray(start, end);
    const text = inflate(raw) ?? raw.toString("latin1");
    i = end + 9;
    if (!text.includes("Td") && !text.includes("Tm")) continue;

    // Fragments keyed by their line, to a tenth of a point. Anything printed on the same baseline
    // is the same row of the table.
    const lines = new Map<string, [number, string][]>();
    let m: RegExpExecArray | null;
    let font: FontMap | undefined;
    let x = 0;
    let y = 0;
    TOKENS.lastIndex = 0;

    while ((m = TOKENS.exec(text))) {
      if (m[1] !== undefined) {
        // BT starts a text object and resets the line to the origin.
        x = 0;
        y = 0;
        continue;
      }
      if (m[2] !== undefined) {
        font = fonts.get(m[2]);
        continue;
      }
      /*
       * Td moves the line RELATIVE to the one before it. Tm sets it absolutely.
       *
       * They are not two spellings of the same thing, and reading Td as absolute is why a report
       * laid out in tiles came back with its headings shuffled and its figures interleaved — every
       * run after the first was placed at an offset as though it were a coordinate. McKesson's
       * Purchase Drill Down uses 626 Td against 254 Tm, so almost the whole page was landing in
       * the wrong place, and the damage was invisible: the words were all there, in an order
       * nobody could read, which looks like a bad PDF rather than a bad reader.
       */
      if (m[3] !== undefined && m[4] !== undefined) {
        x += Number.parseFloat(m[3]);
        y += Number.parseFloat(m[4]);
        continue;
      }
      if (m[5] !== undefined && m[6] !== undefined) {
        x = Number.parseFloat(m[5]);
        y = Number.parseFloat(m[6]);
        continue;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const bytes = m[7]
        ? Buffer.from(m[7].replace(/\s+/g, ""), "hex")
        : Buffer.from(unescape(m[8] ?? ""), "latin1");
      if (bytes.length === 0) continue;

      /*
       * A subset font renumbers its glyphs, so the bytes are indexes rather than letters and the
       * font's own map is the only thing that can turn them back into words — read at the width
       * that font uses, one byte or two.
       */
      const piece = font ? decode(bytes, font) : plain(bytes);
      if (!piece.trim()) continue;

      const key = y.toFixed(1);
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key)!.push([x, piece]);
    }
    if (lines.size === 0) continue;

    for (const key of [...lines.keys()].sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a))) {
      out.push(
        lines
          .get(key)!
          .sort((a, b) => a[0] - b[0])
          .map(([, t]) => t)
          .join(""),
      );
    }
  }

  return out.join("\n");
}

/** Character codes to text, stepping through the bytes at the width the font declares. */
function decode(bytes: Buffer, font: FontMap): string {
  let out = "";
  for (let i = 0; i + font.width <= bytes.length; i += font.width) {
    const code = font.width === 2 ? bytes.readUInt16BE(i) : bytes[i];
    out += font.map.get(code) ?? "";
  }
  return out;
}

/**
 * A run in a font with no character map of its own.
 *
 * Usually plain bytes. But a two-byte font whose ToUnicode this could not find still writes two
 * bytes per character, and read as single bytes that is every letter with a null between it —
 * which survives a trim, joins into the line, and quietly corrupts the row. Where the run looks
 * like that, it is read two bytes at a time instead.
 */
function plain(bytes: Buffer): string {
  const evenNulls = bytes.length >= 4 && bytes.length % 2 === 0 && bytes.every((b, i) => (i % 2 === 0 ? b === 0 : true));
  if (evenNulls) {
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
    return out;
  }
  return bytes.toString("latin1");
}

