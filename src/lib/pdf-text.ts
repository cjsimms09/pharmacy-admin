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

/** Text-showing operators, hex or literal, positioned by a text-matrix or Td offset. */
const SHOW = /(?:BT\s+)?([\d.]+)\s+([\d.]+)\s+Td\s+(?:<([0-9A-Fa-f\s]+)>|\(((?:[^()\\]|\\.)*)\))\s*Tj/g;

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
    if (!text.includes("Td")) continue;

    // Fragments keyed by their line, to a tenth of a point. Anything printed on the same baseline
    // is the same row of the table.
    const lines = new Map<string, [number, string][]>();
    let m: RegExpExecArray | null;
    SHOW.lastIndex = 0;
    while ((m = SHOW.exec(text))) {
      const x = Number.parseFloat(m[1]);
      const y = Number.parseFloat(m[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const piece = m[3]
        ? Buffer.from(m[3].replace(/\s+/g, ""), "hex").toString("latin1")
        : unescape(m[4] ?? "");
      if (!piece) continue;
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
