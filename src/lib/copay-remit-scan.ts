/**
 * A RedSail copay-voucher remittance that arrives as a scanned PDF, turned into the text `parseCopayRemit` reads.
 *
 * The statement is offered as text or as a PDF. The PDF the owner uploaded (1 September 2026, $177.25) is a scan with
 * an optical text layer, and that layer comes out of `pdfText` one field per line, which no row pattern can read:
 * the classifier called it unrecognised. Its words carry their positions, though, so the printed lines can be put back
 * together the way the scanned bank statement's are (`rowsOf`).
 *
 * The scan's characters are then the only other problem, and they are repaired only where a figure itself proves the
 * repair. On the real statement, three kinds turn up:
 *
 *   a letter inside a run of digits  "2026082 I 0…" (a 1 read as I), "1s5.00" (a 5 or an 8 read as s)
 *   the payment date's slash         "09/01 12026" (the / before the year read as a 1)
 *   the check/ACH number             "ChecUACH Number: 1 0261 385" (a margin streak through the label and the number)
 *
 * A row is repaired by trying each reading of its doubtful characters and keeping the one that passes the row's own
 * arithmetic in `parseCopayRemitLine` (submitted less the patient's share is what the voucher pays). Where no reading
 * passes, or more than one does, the row is left as printed and the statement refuses itself, since its rows then do
 * not add to its total. Nothing here decides money. It only offers the parser text the parser can check.
 *
 * Pure.
 */

import { rowsOf, type ScanItem } from "./scanned-bank-statement";
import { looksLikeCopayRemit, parseCopayRemit, parseCopayRemitLine } from "./copay-remit";

/** What each doubtful character can be, where it sits among digits. */
const READS: Record<string, string[]> = {
  I: ["1"], l: ["1"], "|": ["1"], i: ["1"], "!": ["1"],
  O: ["0"], o: ["0"], D: ["0"], Q: ["0"],
  S: ["5", "8"], s: ["5", "8"], B: ["8"], Z: ["2"], z: ["2"], G: ["6"],
};
const CAP = 64;
/** Marks a lone doubtful character read as a digit, so only those join the digit runs either side (readingsOf). Written as an escape: a raw NUL makes git treat the file as binary. */
const LONE = "\u0000";

/** The printed lines of a scanned page, rebuilt from the positions of its words. */
export function linesFromItems(items: ScanItem[]): string[] {
  return rowsOf(items).map((r) => r.cells.slice().sort((a, b) => a.x - b.x).map((c) => c.text).join(" "));
}

/**
 * Every reading of a line with its digit-bound doubtful characters replaced, up to a cap. A character is doubtful where
 * a digit or a decimal point touches it, or where it stands alone between two runs of digits.
 */
export function readingsOf(line: string): string[] {
  const chars = [...line];
  const spots: { at: number; options: string[] }[] = [];
  for (let i = 0; i < chars.length; i++) {
    const options = READS[chars[i]];
    if (!options) continue;
    const touches = /[\d.]/.test(chars[i - 1] ?? "") || /[\d.]/.test(chars[i + 1] ?? "");
    const alone = chars[i - 1] === " " && chars[i + 1] === " " && /\d/.test(chars[i - 2] ?? "") && /\d/.test(chars[i + 2] ?? "");
    if (touches || alone) spots.push({ at: i, options: alone ? options.map((o) => `${LONE}${o}`) : options });
  }
  if (spots.length === 0) return [];
  let out: string[][] = [chars];
  for (const s of spots) {
    const next: string[][] = [];
    for (const base of out) for (const o of s.options) {
      const copy = base.slice();
      copy[s.at] = o;
      next.push(copy);
      if (next.length > CAP) return [];
    }
    out = next;
  }
  /* A lone character between two digit runs joins them: "2026082 I 0" is "202608210". */
  return out.map((c) => c.join("").replace(/ \u0000(\d) /g, "$1"));
}

export type ScannedCopayText = { text: string; repaired: string[]; from: "text layer" | "rebuilt lines" | null };

/**
 * The text to hand `parseCopayRemit`, from a PDF's own text layer where that reads, else from its rebuilt lines with
 * provable repairs. `from` is null where neither is a copay remittance at all.
 */
export function copayRemitTextFromPdf(layerText: string, items: ScanItem[]): ScannedCopayText {
  if (looksLikeCopayRemit(layerText) && parseCopayRemit(layerText).unreadable.length === 0) return { text: layerText, repaired: [], from: "text layer" };
  const lines = linesFromItems(items);
  if (!looksLikeCopayRemit(lines.join("\n"))) return { text: layerText, repaired: [], from: null };

  const repaired: string[] = [];
  const out = lines.map((line, n) => {
    /* The payment date, where the scan read the slash before the year as a 1: "09/01 12026". */
    const date = /^(.*Payment\s*Date\s*:?\s*)(\d{2}\/\d{2})\s+1(\d{4})(\b.*)$/i.exec(line);
    if (date) {
      repaired.push(`line ${n + 1}: the payment date's year separator`);
      return `${date[1]}${date[2]}/${date[3]}${date[4]}`;
    }
    /*
     * The check/ACH number, where a streak down the scan's margin broke the label ("ChecUACH") and cut the number into
     * groups ("1 0261 385"). The page prints it as one run, and it is what makes a second read of this voucher
     * recognisable as the same payment, so without it every re-read would record the payments again. Nothing proves
     * its digits the way a row's arithmetic does: the groups are only joined, never read differently.
     */
    const check = /^(\s*)Chec\S{0,2}ACH\s*Number\s*:?\s*((?:\d+ )*\d+)(?=\s|$)(.*)$/i.exec(line);
    if (check && /\s/.test(check[2]) && /^\d{6,12}$/.test(check[2].replace(/ /g, ""))) {
      repaired.push(`line ${n + 1}: the check/ACH number's label and digit groups`);
      return `${check[1]}Check/ACH Number: ${check[2].replace(/ /g, "")}${check[3]}`;
    }
    if (check && !/^Check\/ACH/i.test(line.trim())) {
      repaired.push(`line ${n + 1}: the check/ACH number's label`);
      return `${check[1]}Check/ACH Number: ${check[2]}${check[3]}`;
    }
    if (!/^\d{6,}/.test(line) || !("why" in parseCopayRemitLine(line))) return line;
    const passing = [...new Set(readingsOf(line).filter((r) => "line" in parseCopayRemitLine(r)))];
    if (passing.length === 1) {
      repaired.push(`line ${n + 1}: a scanned character inside its figures, proved by the row's own arithmetic`);
      return passing[0];
    }
    return line;
  });
  return { text: out.join("\n"), repaired, from: "rebuilt lines" };
}
