/**
 * How much of the C-650's second side the root cause analysis and corrective action plan may take, and at what size.
 *
 * The Board's form is two sides of one sheet, and side two is a page of two large boxes. Each box is a fixed height, so what
 * goes in it has to be worked out beforehand: the type steps down through three sizes until BOTH texts fit their boxes, and
 * if they do not fit at the smallest, the boxes point to an attached sheet (the form itself says "Attach additional pages, if
 * necessary") and the full text prints there. Nothing is cut.
 *
 * It counts printed lines, not characters: a blank line between paragraphs costs a whole line, and a long paragraph costs as
 * many lines as its width needs. The figures below are the layout's (components/c650-form.tsx) and are an estimate for letter
 * paper at a 0.4 in margin, kept a little cautious; scripts/check-c650-pages.ts prints real PDFs to prove the pages.
 */
export const RCA_CAP_BOX_INCHES = 3.1;
const TEXT_WIDTH_INCHES = 7.3;
const LINE_HEIGHT = 1.3;
const CHAR_WIDTH = 0.52;
const CAUTION = 0.92;

export const RCA_CAP_SIZES = [
  { px: 11, cls: "text-[11px] leading-[1.3]" },
  { px: 9.5, cls: "text-[9.5px] leading-[1.3]" },
  { px: 8.5, cls: "text-[8.5px] leading-[1.3]" },
] as const;

/** How many printed lines this text takes in a box at this size. */
export function linesNeeded(text: string | null, px: number): number {
  if (!text) return 0;
  const perLine = Math.floor(((TEXT_WIDTH_INCHES * 96) / (px * CHAR_WIDTH)) * CAUTION);
  return text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
}

/** How many lines a box holds at this size. */
export function boxCapacity(px: number): number {
  return Math.floor((RCA_CAP_BOX_INCHES * 96) / (px * LINE_HEIGHT)) - 1;
}

export function fitRcaCap(rca: string | null, cap: string | null): { cls: string; attach: boolean } {
  for (const s of RCA_CAP_SIZES) {
    const room = boxCapacity(s.px);
    if (linesNeeded(rca, s.px) <= room && linesNeeded(cap, s.px) <= room) return { cls: s.cls, attach: false };
  }
  return { cls: RCA_CAP_SIZES[0].cls, attach: true };
}
