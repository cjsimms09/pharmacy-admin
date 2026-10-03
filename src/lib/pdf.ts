/**
 * A very small PDF writer, for text documents only.
 *
 * The training material went out as a .txt attachment, which on a phone opens as a wall of
 * monospace or does not open at all — so people did not read it, which is the whole point of
 * sending it. A PDF opens on every phone, prints properly, and is what anybody expects a training
 * handout to be.
 *
 * Written by hand rather than pulled in as a dependency because the requirement is genuinely
 * small: left-aligned text, two weights, page breaks. The base-14 fonts are guaranteed present in
 * every reader, so nothing has to be embedded and the file stays a few kilobytes.
 */

const PAGE_W = 612; // US Letter, in points
const PAGE_H = 792;
const MARGIN = 56;
const LEADING = 13.5;
const SIZE = 10;
const TITLE_SIZE = 15;

export type PdfLine = { text: string; bold?: boolean; size?: number; gapBefore?: number };

/** Characters that would otherwise end a PDF string or escape the next one. */
function escapeText(s: string): string {
  return s
    // Anything outside WinAnsi renders as a wrong glyph; the smart punctuation in the courses is
    // the common case, so it is folded to its plain equivalent rather than mangled.
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/·/g, "-")
    .replace(/•/g, "-")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** Rough width of a Helvetica string at a given size — enough to wrap on, not to typeset with. */
function widthOf(s: string, size: number): number {
  // Helvetica averages about 0.5em; capitals and digits run wider, so weight them.
  let w = 0;
  for (const ch of s) w += /[A-Z0-9@#%&]/.test(ch) ? 0.62 : /[ilj.,:;'!|]/.test(ch) ? 0.28 : 0.52;
  return w * size;
}

export function wrapForPdf(text: string, size = SIZE, width = PAGE_W - MARGIN * 2): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of raw.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next, size) > width && line) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Builds the file.
 *
 * Objects are written in order and their byte offsets recorded, because a PDF's cross-reference
 * table is a list of exactly where each object starts — get one offset wrong and readers refuse
 * the whole file.
 */
export function textPdf(title: string, lines: PdfLine[]): Buffer {
  const pages: string[][] = [];
  let current: string[] = [];
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    if (current.length) pages.push(current);
    current = [];
    y = PAGE_H - MARGIN;
  };

  for (const line of lines) {
    const size = line.size ?? SIZE;
    const leading = size > SIZE ? size * 1.35 : LEADING;
    if (line.gapBefore) y -= line.gapBefore;
    if (y < MARGIN + leading) newPage();
    const font = line.bold ? "/F2" : "/F1";
    // Fill colour set explicitly. A PDF with no colour operator inherits whatever the graphics
    // state happens to hold, and readers disagree about what that is — black is not guaranteed.
    current.push(
      `BT 0 g ${font} ${size} Tf 1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm (${escapeText(line.text)}) Tj ET`,
    );
    y -= leading;
  }
  if (current.length) pages.push(current);
  if (pages.length === 0) pages.push([]);

  return assemble(title, pages.map((ops) => ops.join("\n")));
}

/**
 * Turns finished page content streams into a file.
 *
 * Objects are written in order and their byte offsets recorded, because a PDF's cross-reference
 * table is a list of exactly where each object starts — get one offset wrong and readers refuse
 * the whole file. Shared by the plain text documents and the laid-out ones, so there is only one
 * place that can get the offsets wrong.
 */
function assemble(title: string, streams: string[]): Buffer {
  const pages = streams.length > 0 ? streams : [""];
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  objects[3] = `<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >> >> >>`;

  pages.forEach((stream, i) => {
    const pageId = pageIds[i];
    const contentId = pageId + 1;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources 3 0 R /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });

  const infoId = objects.length;
  objects[infoId] = `<< /Title (${escapeText(title)}) /Producer (Pharmacy Admin) >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(out, "latin1");
}

/**
 * A laid-out page, for the few documents that are not a wall of prose.
 *
 * An invoice is a table with money right-aligned under a rule. Left-aligned lines cannot express
 * that, and something a pharmacy sends to somebody else's accounts department should look like a
 * document rather than like a printout — it is read by a person who has never seen this system
 * and whose only impression of it is the page in front of them.
 *
 * Still deliberately small: text at a point, a rule, a filled box. Enough to set an invoice, and
 * not the beginning of a layout engine.
 */
export type Draw =
  | {
      kind: "text";
      x: number;
      y: number;
      text: string;
      size?: number;
      bold?: boolean;
      /** Right and centre are measured from x, which is then the right edge or the centre. */
      align?: "left" | "right" | "center";
      /** 0 is black, 1 is white. */
      grey?: number;
    }
  | { kind: "rule"; x1: number; x2: number; y: number; weight?: number; grey?: number }
  | { kind: "rect"; x: number; y: number; w: number; h: number; grey?: number };

export const PAGE = { width: PAGE_W, height: PAGE_H, margin: MARGIN } as const;

/** How wide a string will be, for right-aligning money and truncating a long description. */
export const textWidth = widthOf;

function op(d: Draw): string {
  if (d.kind === "rule") {
    const g = (d.grey ?? 0).toFixed(2);
    return `q ${g} G ${(d.weight ?? 0.75).toFixed(2)} w ${d.x1.toFixed(2)} ${d.y.toFixed(2)} m ${d.x2.toFixed(2)} ${d.y.toFixed(2)} l S Q`;
  }
  if (d.kind === "rect") {
    const g = (d.grey ?? 0.92).toFixed(2);
    return `q ${g} g ${d.x.toFixed(2)} ${d.y.toFixed(2)} ${d.w.toFixed(2)} ${d.h.toFixed(2)} re f Q`;
  }
  const size = d.size ?? SIZE;
  const w = widthOf(d.text, size);
  const x = d.align === "right" ? d.x - w : d.align === "center" ? d.x - w / 2 : d.x;
  const g = (d.grey ?? 0).toFixed(2);
  return `BT ${g} g ${d.bold ? "/F2" : "/F1"} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${d.y.toFixed(2)} Tm (${escapeText(d.text)}) Tj ET`;
}

export function drawnPdf(title: string, pages: Draw[][]): Buffer {
  return assemble(title, pages.map((page) => page.map(op).join("\n")));
}
