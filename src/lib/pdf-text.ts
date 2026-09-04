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
  /\/([A-Za-z0-9_.+-]+)\s+[\d.]+\s+Tf|([\d.-]+)\s+([\d.-]+)\s+Td|(?:[\d.-]+\s+){4}([\d.-]+)\s+([\d.-]+)\s+Tm|(?:<([0-9A-Fa-f\s]+)>|\(((?:[^()\\]|\\.)*)\))\s*Tj/g;

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
type FontMaps = Map<string, Map<number, string>>;

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

/** bfchar and bfrange entries, turned into code to text. */
function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const hexToStr = (h: string) => {
    let s = "";
    for (let i = 0; i + 3 < h.length + 1; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return s.replace(/\u0000/g, "");
  };

  for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
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
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(base + (c - lo)));
    }
  }
  return map;
}

/** Resource name (F1, TT2) to that font's character map, for every font that has one. */
function fontMaps(buf: Buffer): FontMaps {
  const objs = objects(buf);
  const byObject = new Map<number, Map<number, string>>();

  for (const [, o] of objs) {
    if (!/\/Type\s*\/Font\b/.test(o.body)) continue;
    const ref = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(o.body);
    if (!ref) continue;
    const cmapObj = objs.get(Number(ref[1]));
    if (!cmapObj?.stream) continue;
    const text = inflate(cmapObj.stream) ?? cmapObj.stream.toString("latin1");
    const parsed = parseToUnicode(text);
    if (parsed.size > 0) byObject.set(Number(ref[1]), parsed);
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
    let font: Map<number, string> | undefined;
    let x = 0;
    let y = 0;
    TOKENS.lastIndex = 0;

    while ((m = TOKENS.exec(text))) {
      if (m[1] !== undefined) {
        font = fonts.get(m[1]);
        continue;
      }
      // Td offsets and a Tm text matrix are two ways of saying the same thing, and generators
      // pick one or the other with no pattern. A reader that knows only Td silently returns an
      // empty page for half the PDFs it is given — including the ones this system writes itself.
      if (m[2] !== undefined && m[3] !== undefined) {
        x = Number.parseFloat(m[2]);
        y = Number.parseFloat(m[3]);
        continue;
      }
      if (m[4] !== undefined && m[5] !== undefined) {
        x = Number.parseFloat(m[4]);
        y = Number.parseFloat(m[5]);
        continue;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const bytes = m[6]
        ? Buffer.from(m[6].replace(/\s+/g, ""), "hex")
        : Buffer.from(unescape(m[7] ?? ""), "latin1");
      if (bytes.length === 0) continue;

      // A subset font renumbers its glyphs, so the bytes are indexes rather than letters and the
      // font's own map is the only thing that can turn them back into words.
      const piece = font
        ? [...bytes].map((c) => font!.get(c) ?? "").join("")
        : bytes.toString("latin1");
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
