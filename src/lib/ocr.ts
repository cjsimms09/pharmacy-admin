/**
 * Reading a scan: the page images inside a PDF, recognised on this machine, as positioned words.
 *
 * The owner, 1 October 2026: "so there is no way to read this?" September's bank statement arrived as
 * thirteen pages of JPEG with no text layer at all — 1274 by 1649 pixels, about 150 dots per inch — and
 * everything this site had for reading a statement starts from text with positions. August's statement
 * had that layer because the bank's own download carries one; a scan forwarded through email does not.
 *
 * So this supplies the layer. Three things about how, and why each.
 *
 * ── The images come straight out of the PDF ──
 *
 * A scanner writes each page as one JPEG object (`/Subtype /Image`, `/Filter /DCTDecode`), and a JPEG is
 * a complete file on its own. Reading the bytes between `stream` and `endstream` is the whole of the
 * extraction; nothing has to render the page. The length is taken from `/Length` where the object gives
 * it directly, from the object it points at where it does not, and failing both from the JPEG's own end
 * marker. Pages are taken in object order, which is the order a scanner writes them; the page footer the
 * bank prints is read back afterwards to check that assumption rather than rely on it.
 *
 * ── The recognition runs here ──
 *
 * `tesseract.js` is the open-source engine compiled to run inside Node. It needs no account, no key and
 * no network for the recognition itself; the one thing it fetches is its English model, once, which is
 * cached under `data/ocr` so that is the last time. Nothing from the page leaves this machine. The
 * owner's rule — nothing uses an API unless he presses a button — is kept in the strongest sense: there is
 * no API.
 *
 * ── The result is the same shape the text layer would have given ──
 *
 * `scanned-bank-statement.ts` takes words with a page number and a position in PDF points, origin bottom
 * left, as `pdfItems` produces from a text layer. The engine gives words with pixel boxes, origin top
 * left. Each word is converted to the same frame — scaled to the page's points and flipped — so the
 * reader downstream cannot tell which route the words came by, and its column boundaries, measured on
 * August's statement, apply unchanged.
 *
 * ── What this does not promise ──
 *
 * The engine will misread characters, and on a 150-dpi scan it will misread some digits. That is why the
 * statement reader proves every figure against the others rather than trusting any one, and lists what
 * it cannot prove for a person. This file makes the scan readable; it does not make it right.
 */

import { createWorker } from "tesseract.js";
import type { ScanItem } from "./scanned-bank-statement";

/** US letter in PDF points, which is what every statement here is. */
const PAGE_W_PT = 612;
const PAGE_H_PT = 792;

export type PageImage = { index: number; bytes: Buffer; width: number | null; height: number | null };

/**
 * Every JPEG page image in a PDF, in the order the file holds them.
 *
 * Only `/DCTDecode` images are returned: a JPEG stream is usable as it stands, and anything else would
 * need decoding this file does not do. A PDF whose pages are drawn another way yields none, and the
 * caller says so rather than guessing.
 */
export function pageImagesOf(pdf: Buffer): PageImage[] {
  const text = pdf.toString("latin1");
  const out: PageImage[] = [];
  const objRe = /(\d+)\s+0\s+obj\s*<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text))) {
    const dict = m[2];
    if (!/\/Subtype\s*\/Image\b/.test(dict) || !/\/DCTDecode\b/.test(dict)) continue;
    const start = m.index + m[0].length;
    const length = lengthOf(dict, text);
    let end: number;
    if (length !== null && length > 0 && start + length <= pdf.length) {
      end = start + length;
    } else {
      /* No usable length: the JPEG's own end-of-image marker, which a scanner always writes. */
      const eoi = pdf.indexOf(Buffer.from([0xff, 0xd9]), start);
      if (eoi < 0) continue;
      end = eoi + 2;
    }
    const bytes = pdf.subarray(start, end);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) continue;
    out.push({
      index: out.length,
      bytes,
      width: Number(/\/Width\s+(\d+)/.exec(dict)?.[1] ?? "") || null,
      height: Number(/\/Height\s+(\d+)/.exec(dict)?.[1] ?? "") || null,
    });
  }
  return out;
}

/** `/Length 1234` as written, or the number in the object `/Length 12 0 R` points at, or null. */
function lengthOf(dict: string, text: string): number | null {
  const direct = /\/Length\s+(\d+)(?!\s+0\s+R)/.exec(dict);
  if (direct) return Number(direct[1]);
  const ref = /\/Length\s+(\d+)\s+0\s+R/.exec(dict);
  if (!ref) return null;
  const target = new RegExp(`(?:^|\\s)${ref[1]}\\s+0\\s+obj\\s*(\\d+)\\s*endobj`).exec(text);
  return target ? Number(target[1]) : null;
}

export type OcrWord = { page: number; text: string; x0: number; y0: number; x1: number; y1: number; confidence: number };

/**
 * Every word the engine found on every page, with its pixel box.
 *
 * One worker, pages in order, terminated at the end: the engine holds a few hundred megabytes while it
 * runs and this is the pharmacy's 7.3 GB machine. `onPage` lets a caller say which page it is on, because
 * thirteen pages take minutes and silence looks like a hang.
 */
export async function recogniseWords(pages: PageImage[], onPage?: (index: number, total: number) => void): Promise<OcrWord[]> {
  const worker = await createWorker("eng", 1, { cachePath: "./data/ocr" });
  const words: OcrWord[] = [];
  try {
    for (const p of pages) {
      onPage?.(p.index + 1, pages.length);
      const result = await worker.recognize(p.bytes, {}, { blocks: true });
      const blocks = result.data.blocks ?? [];
      for (const b of blocks) {
        for (const para of b.paragraphs) {
          for (const line of para.lines) {
            for (const w of line.words) {
              if (!w.text.trim()) continue;
              words.push({ page: p.index + 1, text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, confidence: w.confidence });
            }
          }
        }
      }
    }
  } finally {
    await worker.terminate();
  }
  return words;
}

/**
 * The words as the statement reader expects them: PDF points, origin bottom left, one item per word.
 *
 * Scaled by the page's own pixel size, so a scan at any resolution lands on the same letter-sized grid the
 * text-layer route produces. `y` is the word's baseline — the bottom of its box — which is what the text
 * layer reports and what `rowsOf` groups lines on within four points.
 */
export function toScanItems(words: OcrWord[], pages: PageImage[]): ScanItem[] {
  const size = new Map(pages.map((p) => [p.index + 1, { w: p.width ?? 1274, h: p.height ?? 1649 }]));
  return words.map((w) => {
    const s = size.get(w.page) ?? { w: 1274, h: 1649 };
    const sx = PAGE_W_PT / s.w;
    const sy = PAGE_H_PT / s.h;
    return { page: w.page, x: w.x0 * sx, y: PAGE_H_PT - w.y1 * sy, text: w.text };
  });
}

/**
 * The words for a stored document, recognised once and kept.
 *
 * Thirteen pages take half a minute and a few hundred megabytes, and the Money page reads a statement on
 * every view. So the words are written beside the engine's model under `data/ocr`, keyed by the document,
 * and read from there on every call after the first. A document whose bytes change gets a new id and so a
 * fresh recognition; nothing here can serve stale words for new paper.
 */
export async function scanItemsForDocument(documentId: string, pdf: Buffer, onPage?: (index: number, total: number) => void): Promise<ScanItem[]> {
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  mkdirSync("./data/ocr", { recursive: true });
  const cache = `./data/ocr/${documentId}.items.json`;
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as ScanItem[];
  const { items } = await scanItemsFromScannedPdf(pdf, onPage);
  writeFileSync(cache, JSON.stringify(items));
  return items;
}

/** The whole route: a PDF of scanned pages to the positioned words the statement reader takes. */
export async function scanItemsFromScannedPdf(pdf: Buffer, onPage?: (index: number, total: number) => void): Promise<{ items: ScanItem[]; pages: number; words: number }> {
  const pages = pageImagesOf(pdf);
  if (pages.length === 0) return { items: [], pages: 0, words: 0 };
  const words = await recogniseWords(pages, onPage);
  return { items: toScanItems(words, pages), pages: pages.length, words: words.length };
}
