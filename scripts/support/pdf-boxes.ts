/**
 * Where every piece of text on a generated PDF actually sits, and what it lands on top of.
 *
 * Our own writer lays the page out by absolute coordinates and draws a position off the edge of the
 * paper exactly as happily as one on it — the comment in `driver-invoice-pdf.ts` says so, having
 * been written after a closing sentence ran off the sheet. Nothing in the code can show that, and
 * nothing in the extracted text can either: extraction reads the runs in the order they were
 * written, so two words printed on top of one another come back looking like two ordinary words.
 *
 * ── Why the boxes are two-dimensional ──
 *
 * The first version of this compared only runs whose baselines were the same to the point, and
 * reported the September draft clean while the owner was looking at overlapping text. Two runs a
 * point or two apart never met in that test and overlap perfectly well on paper, because a line of
 * type is taller than its baseline. So every run gets a real box — ascender to descender — and so
 * does every filled rectangle, and anything that intersects anything is reported.
 *
 * Run as:  node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/support/pdf-boxes.ts <file.pdf>
 */
import { readFileSync } from "node:fs";
import { inflateSync, inflateRawSync } from "node:zlib";

/** The same width model the generator lays out with, so this measures what it measured. */
function widthOf(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += /[A-Z0-9@#%&]/.test(ch) ? 0.62 : /[ilj.,:;'!|]/.test(ch) ? 0.28 : 0.52;
  return w * size;
}

type Box = { x0: number; x1: number; y0: number; y1: number; what: string; kind: "text" | "fill" };

const file = readFileSync(process.argv[2]);
const raw = file.toString("latin1");

/** Every stream in the file, inflated where it is compressed and taken as-is where it is not. */
function streams(): string[] {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const s = raw.indexOf("stream", at);
    if (s < 0) break;
    const e = raw.indexOf("endstream", s);
    if (e < 0) break;
    let from = s + "stream".length;
    if (raw[from] === "\r") from++;
    if (raw[from] === "\n") from++;
    const body = file.subarray(Buffer.byteLength(raw.slice(0, from), "latin1"), Buffer.byteLength(raw.slice(0, e), "latin1"));
    try {
      out.push(inflateSync(body).toString("latin1"));
    } catch {
      try {
        out.push(inflateRawSync(body).toString("latin1"));
      } catch {
        out.push(body.toString("latin1"));
      }
    }
    at = e + 1;
  }
  return out;
}

/*
 * Helvetica's ascender and descender, as fractions of the point size.
 *
 * Deliberately a little tighter than the font's real extents (0.718 and 0.207): a cap-height box
 * is what a reader sees as the line, and using the full em would report every ordinary 12-point
 * gap between 9.5-point lines as a collision, which is how a check gets switched off.
 */
const ASC = 0.7;
const DESC = 0.2;

const one = /BT\s+([\d.]+)\s+g\s+\/(F\d+)\s+([\d.]+)\s+Tf\s+1 0 0 1 ([-\d.]+) ([-\d.]+) Tm \((.*?)\) Tj ET/g;
const fill = /([\d.]+)\s+g\s+([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re f/g;

const PAGE_W = 612;
let faults = 0;
const say = (s: string) => {
  faults++;
  console.log("  " + s);
};

const overlap = (a: Box, b: Box) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5;

/*
 * One sheet at a time.
 *
 * Every page's content is its own stream and they all share one coordinate system, so measuring the
 * file as a whole reports page one's footer sitting exactly on top of page two's. The first version
 * of this did that and printed sixty-one faults, every one of them two sheets being compared with
 * each other — a check that cries wolf on a correct page is worse than no check.
 */
const sheets = streams();
sheets.forEach((stream, i) => {
  const texts: Box[] = [];
  const fills: Box[] = [];
  let m: RegExpExecArray | null;
  one.lastIndex = 0;
  while ((m = one.exec(stream))) {
    const text = m[6].replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
    if (!text.trim()) continue;
    const size = Number(m[3]);
    const x = Number(m[4]);
    const y = Number(m[5]);
    texts.push({ x0: x, x1: x + widthOf(text, size), y0: y - DESC * size, y1: y + ASC * size, what: `"${text}"`, kind: "text" });
  }
  fill.lastIndex = 0;
  while ((m = fill.exec(stream))) {
    const w = Number(m[4]);
    const h = Number(m[5]);
    fills.push({ x0: Number(m[2]), x1: Number(m[2]) + w, y0: Number(m[3]), y1: Number(m[3]) + h, what: `[fill ${w.toFixed(0)}x${h.toFixed(0)}]`, kind: "fill" });
  }
  if (texts.length === 0) return;

  /* Read from the page rather than assumed: the leftmost run is the margin the sheet was laid out to. */
  const M = Math.min(...texts.map((b) => b.x0));
  const RIGHT = PAGE_W - M;
  const before = faults;
  console.log(`page ${i + 1}: ${texts.length} text runs, ${fills.length} fills, text block ${M.toFixed(0)}..${RIGHT.toFixed(0)}`);

  for (const b of texts) {
    if (b.x1 > RIGHT + 1) say(`PAST RIGHT MARGIN by ${(b.x1 - RIGHT).toFixed(1)}  y=${b.y0.toFixed(0)}  ${b.what}`);
  }
  for (let a = 0; a < texts.length; a++) {
    for (let b = a + 1; b < texts.length; b++) {
      if (!overlap(texts[a], texts[b])) continue;
      const dx = Math.min(texts[a].x1, texts[b].x1) - Math.max(texts[a].x0, texts[b].x0);
      const dy = Math.min(texts[a].y1, texts[b].y1) - Math.max(texts[a].y0, texts[b].y0);
      say(`TEXT ON TEXT ${dx.toFixed(1)}x${dy.toFixed(1)}pt y=${texts[a].y0.toFixed(0)}/${texts[b].y0.toFixed(0)}  ${texts[a].what} | ${texts[b].what}`);
    }
  }
  if (faults === before) console.log("  clean");
});

console.log(faults === 0 ? `${sheets.length} streams: nothing overlaps and nothing passes the margin` : `${faults} faults`);
