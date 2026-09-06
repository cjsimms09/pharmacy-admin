import { pdfItems, pdfText, type PdfItem } from "./pdf-text";

/**
 * Reading McKesson's Purchase Drill Down without asking anybody's judgement.
 *
 * It arrives every morning and it is the report that prices an order: the compliance ratio picks
 * the band, and the band sets the discount on every contract generic for the whole period. It was
 * being read by a model, which meant it cost money, needed a key, and — the morning this was
 * written — stopped being read at all because the month's spending ceiling had been reached. A
 * report that decides purchasing should not be able to stop arriving because of a budget.
 *
 * ── Why it looked unreadable ──
 *
 * It is a dashboard, not a table: every cell on the page shares one baseline and the columns are
 * drawn top to bottom, one after another, so joining the page by line interleaves nine columns
 * into an unreadable ribbon. With each run's x as well as its text, the columns come apart again.
 *
 * ── How a column is identified, and how that is checked ──
 *
 * By its position from the left, matched against the order the report prints its own headings in —
 * GCR, then OS/Rx, then OS/Gx, at 8, 128 and 248, with their data at 72, 192 and 312. Same order,
 * same spacing. Nothing here trusts a hard-coded coordinate.
 *
 * And then it is checked, against two identities the report satisfies on every row:
 *
 *     Net Purchases = Total Brand + Total Generic
 *     Net Purchases = Total Rx + Total OTC
 *
 * A layout that satisfies both on six months is the right layout. One that does not is refused and
 * says so, rather than filing figures that look perfectly reasonable and are in the wrong columns —
 * which is the failure this whole file exists to avoid, because nothing downstream could detect it.
 *
 * ── The scrub, which is the point ──
 *
 * The report prints the exclusions it was run with. "Flu or Dropship" alone is a position: it is
 * measured on a narrower denominator than McKesson settles on, and on one real month the two read
 * 10.13% and 20.64%. The full list — Flu, Dropship, Specialty and GLP1 — *is* McKesson's own scrub,
 * and a GCR measured on it is the figure that picks the band.
 *
 * So the document decides, not this code. Whether the ratio may select a band is read off the line
 * the report prints about itself, and a report re-scheduled with different exclusions changes the
 * answer the next morning without anybody editing anything.
 */

/** The exclusions McKesson applies when it settles, and therefore what a scrubbed GCR must carry. */
export const FULL_SCRUB = ["flu", "dropship", "specialty", "glp1"];

export type DrillMonth = {
  /** "2026-09". */
  month: string;
  /** As the report prints it, e.g. "September-2026". */
  label: string;
  gcrPercent: number | null;
  osRxPercent: number | null;
  osGxPercent: number | null;
  netPurchasesCents: number | null;
  totalRxCents: number | null;
  totalBrandCents: number | null;
  totalGenericCents: number | null;
  totalOtcCents: number | null;
  brandOverRxPercent: number | null;
};

export type DrillRead = {
  generatedOn: string | null;
  /** The exclusions line, as printed. Null where the report does not say. */
  exclusions: string | null;
  /**
   * Whether the GCR on this report is McKesson's scrubbed one, and may pick a band.
   *
   * Null where the report does not print its exclusions at all — which is not the same as "no",
   * and must not be treated as either answer.
   */
  scrubbed: boolean | null;
  months: DrillMonth[];
  checks: { what: string; ok: boolean; detail: string }[];
  problems: string[];
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "$1,234.56" to cents. Null for anything that is not a plain amount. */
export function cents(s: string): number | null {
  const t = s.trim().replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** "24.43%" to 24.43. */
export function percent(s: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(s.trim());
  return m ? Number(m[1]) : null;
}

/** "September-2026" to "2026-09". */
export function monthKey(label: string): string | null {
  const m = /^([A-Za-z]+)-(\d{4})$/.exec(label.trim());
  if (!m) return null;
  const i = MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
  return i < 0 ? null : `${m[2]}-${String(i + 1).padStart(2, "0")}`;
}

/** The date on the report's own "Generated on" line. */
export function generatedOn(text: string): string | null {
  const m = /Generated on\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i.exec(text);
  if (!m) return null;
  const i = MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
  if (i < 0) return null;
  return `${m[3]}-${String(i + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/**
 * The exclusions the report was run with, and whether they amount to McKesson's own scrub.
 *
 * Read from the filter line rather than the explanatory paragraph, because the paragraph names the
 * filters in general and the filter line names what this run actually used.
 */
export function exclusionsFrom(text: string): { printed: string | null; scrubbed: boolean | null } {
  const m = /GCR\s*Denominator\s*Exclusions\s*is\s*([A-Za-z0-9 ,]*?)(?:OS\/Rx|$)/im.exec(text.replace(/\n/g, " "));
  if (!m) return { printed: null, scrubbed: null };
  const printed = m[1].trim().replace(/\s+/g, " ");
  const words = printed.toLowerCase().replace(/\bor\b/g, " ").split(/[^a-z0-9]+/).filter(Boolean);
  const scrubbed = FULL_SCRUB.every((w) => words.includes(w));
  return { printed, scrubbed };
}

/** Distinct x positions in a set of runs, left to right, clustered to a tenth of a point. */
function columns(items: PdfItem[]): number[] {
  return [...new Set(items.map((i) => Number(i.x.toFixed(1))))].sort((a, b) => a - b);
}

/**
 * The by-month table, taken apart.
 *
 * The report draws the table in two passes over the same six rows — the labels and dollar columns
 * first, the ratio columns second — so the two are read separately and zipped by position. Row
 * order is document order within a column, which is the only ordering this page offers.
 */
/**
 * Whether some text is a Purchase Drill Down.
 *
 * It lives here rather than in the mailbox router because two other places need it: the router,
 * to file an incoming one, and the invoice backlog, which had been offering the pharmacy its own
 * daily purchase report as an invoice waiting to be filed — with a Delete button beside it that
 * would have taken the month's GCR readings with it.
 */
export function isDrillDownText(text: string, fileName = ""): boolean {
  if (/purchase[_\s-]*drill[_\s-]*down/i.test(fileName)) return true;
  return /GCR/.test(text) && /OS\/Rx/.test(text);
}

export function readDrillDown(buf: Buffer): DrillRead {
  return parseDrillDown(pdfItems(buf), pdfText(buf));
}

/**
 * The parse itself, on runs and text rather than on a PDF.
 *
 * Split out so the whole reading can be exercised against a table written by hand, rather than
 * only against one real report that cannot be committed. The layout rules here are the part worth
 * pinning: they were each arrived at by a wrong answer on the real file.
 */
export function parseDrillDown(items: PdfItem[], text: string): DrillRead {
  const problems: string[] = [];
  const { printed, scrubbed } = exclusionsFrom(text);

  /*
   * The month labels anchor everything, and they arrive in pieces: a subset font breaks
   * "August-2026" into "A" and "ugust-2026". Joining every run between one row number and the
   * first amount of that row puts them back together, using the report's own row numbering.
   */
  const rowNumberX = columns(items.filter((i) => /^\d{1,2}$/.test(i.text.trim())))[0] ?? null;
  const groups: PdfItem[][] = [];
  let current: PdfItem[] | null = null;
  for (const it of items) {
    const isRowNumber = rowNumberX !== null && Math.abs(it.x - rowNumberX) < 1 && /^\d{1,2}$/.test(it.text.trim());
    if (isRowNumber) {
      if (current) groups.push(current);
      current = [];
      continue;
    }
    if (current) current.push(it);
  }
  if (current) groups.push(current);

  const labelled = groups
    .map((g) => {
      const upTo = g.findIndex((i) => i.text.trim().startsWith("$"));
      const head = (upTo < 0 ? g : g.slice(0, upTo)).map((i) => i.text).join("").replace(/\s+/g, "");
      const m = /([A-Za-z]+-\d{4})/.exec(head);
      return m ? { label: m[1], row: g } : null;
    })
    .filter((x): x is { label: string; row: PdfItem[] } => x !== null) as { label: string; row: PdfItem[] }[];

  if (labelled.length === 0) {
    return { generatedOn: generatedOn(text), exclusions: printed, scrubbed, months: [], checks: [], problems: ["No month rows could be found in the by-month table."] };
  }

  /*
   * The dollar columns, agreed across the rows rather than taken row by row.
   *
   * The last month's group runs on into the totals row beneath it, because a totals row carries no
   * row number to end the group on. Taking whatever amounts happen to be in a group therefore gave
   * April the whole period's figures — right-looking numbers, wrong row. A column is instead an x
   * that most of the rows put an amount at, and each row supplies only the amount sitting at one
   * of those; anything else on the page is not in this table.
   */

  /*
   * Where a row ends, when nothing marks the end of it.
   *
   * A totals row carries no row number, so it falls into the last month's group and would hand
   * that month the whole period's figures — numbers that look entirely reasonable in the wrong
   * row. The cells of a row are drawn left to right, so the row is the longest run of amounts
   * whose x keeps increasing; the first one that steps back to a left-hand column is the next row
   * beginning. Cutting on a row length instead cost the first month two cells, because its group
   * also carries the table's headings.
   */
  const rowAmounts = (row: PdfItem[]) => {
    const out: { x: number; v: number }[] = [];
    for (const i of row) {
      const v = cents(i.text);
      if (v === null) continue;
      const x = Number(i.x.toFixed(1));
      if (out.length > 0 && x <= out[out.length - 1].x) break;
      out.push({ x, v });
    }
    return out;
  };

  const tally = new Map<number, number>();
  for (const l of labelled) for (const a of rowAmounts(l.row)) tally.set(a.x, (tally.get(a.x) ?? 0) + 1);
  const amountCols = [...tally.entries()]
    .filter(([, count]) => count >= Math.ceil(labelled.length / 2))
    .map(([x]) => x)
    .sort((a, b) => a - b);

  const atColumn = (row: PdfItem[], x: number): number | null =>
    rowAmounts(row).find((a) => Math.abs(a.x - x) < 0.2)?.v ?? null;

  /*
   * The ratio pass: every run in the three percentage columns, in document order.
   *
   * Identified by rank from the left, which is the order the report prints GCR, OS/Rx and OS/Gx in
   * its own headings. Only the runs belonging to the by-month table are wanted, and those are the
   * ones that come in as many consecutive groups as there are month rows.
   */
  const pcts = items.filter((i) => percent(i.text) !== null);
  const pctCols = columns(pcts);
  const ratioCols = pctCols.slice(0, 3);
  const byCol = (x: number) => pcts.filter((i) => Math.abs(Number(i.x.toFixed(1)) - x) < 0.2).map((i) => percent(i.text)!);

  const n = labelled.length;
  const series = ratioCols.map((x) => {
    const all = byCol(x);
    /*
     * A ratio column carries the month rows and the summary tiles that repeat the whole-period
     * figure. The months are the run of values bracketed by those repeats, so the repeated value
     * is dropped from each end rather than a position being assumed.
     */
    if (all.length === n) return all;
    const first = all[0];
    let start = 0;
    while (start < all.length && all[start] === first) start++;
    return all.slice(start, start + n);
  });

  const months: DrillMonth[] = labelled.map((l, idx) => ({
    month: monthKey(l.label) ?? l.label,
    label: l.label,
    gcrPercent: series[0]?.[idx] ?? null,
    osRxPercent: series[1]?.[idx] ?? null,
    osGxPercent: series[2]?.[idx] ?? null,
    netPurchasesCents: amountCols[0] === undefined ? null : atColumn(l.row, amountCols[0]),
    totalRxCents: amountCols[1] === undefined ? null : atColumn(l.row, amountCols[1]),
    totalBrandCents: null,
    totalGenericCents: null,
    totalOtcCents: null,
    brandOverRxPercent: null,
  }));

  /*
   * Brand and generic are paired to their month by arithmetic, not by position.
   *
   * Those two columns are not drawn in row order: the current month's cells come last, after the
   * five closed months, presumably because a part-month is rendered separately. Zipping them by
   * position therefore puts September's brand against August's row — right-looking figures in the
   * wrong month, which nothing downstream could catch.
   *
   * Brand + generic is net purchases on every row, and the amounts are distinct, so there is
   * exactly one pairing that works. Finding it *is* the check: on a misread layout no unique
   * pairing exists, and the row is left empty rather than filled with a plausible guess.
   */
  /*
   * A column is a band, not an x, because the figures are right-aligned: a shorter amount starts
   * further right, so September's $96,700.76 sits some points to the right of August's
   * $465,625.72 in the same column. The bands are 125 points apart, so a generous window keeps
   * them apart while catching the variation.
   *
   * Widening all the way to every amount on the page was tried and is worse than useless: with
   * that many candidates several pairs add up to each month's net purchases, the uniqueness guard
   * rejects all of them, and nothing is read at all.
   */
  const COLUMN_BAND = 45;
  const columnValues = (x: number | undefined): number[] =>
    x === undefined
      ? []
      : items.filter((i) => Math.abs(i.x - x) <= COLUMN_BAND && cents(i.text) !== null).map((i) => cents(i.text)!);

  const brands = [...new Set(columnValues(amountCols[2]))];
  const generics = [...new Set(columnValues(amountCols[3]))];
  let paired = 0;
  for (const m of months) {
    if (m.netPurchasesCents === null) continue;
    const hits: { b: number; g: number }[] = [];
    for (const b of new Set(brands)) {
      for (const g of new Set(generics)) {
        if (Math.abs(b + g - m.netPurchasesCents) <= 2) hits.push({ b, g });
      }
    }
    // Ambiguity is refused: two pairings that both add up is not an answer.
    if (hits.length === 1) {
      m.totalBrandCents = hits[0].b;
      m.totalGenericCents = hits[0].g;
      paired++;
    }
  }

  /*
   * Total OTC is what the Rx figure is short of net purchases, and the report is asked to confirm
   * it rather than asked where it is. The column is drawn out of row order like brand and generic,
   * so looking it up by position would put the wrong month's OTC on a row; the difference is
   * definitionally right, and finding that exact amount printed on the page is the check that the
   * two figures it came from were themselves read correctly.
   */
  const printedAmounts = new Set(items.map((i) => cents(i.text)).filter((v): v is number => v !== null));
  for (const m of months) {
    if (m.netPurchasesCents === null || m.totalRxCents === null) continue;
    const otc = m.netPurchasesCents - m.totalRxCents;
    if (otc >= 0 && printedAmounts.has(otc)) m.totalOtcCents = otc;
  }

  /*
   * The two identities that prove the columns are the ones they are taken to be. Both hold on
   * every row of a correctly read report, and neither can hold by accident on a shifted layout.
   */
  const checks: { what: string; ok: boolean; detail: string }[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= 2;
  let brandGenericOk = 0;
  let brandGenericSeen = 0;
  let rxOtcOk = 0;
  let rxOtcSeen = 0;
  for (const m of months) {
    if (m.netPurchasesCents !== null && m.totalBrandCents !== null && m.totalGenericCents !== null) {
      brandGenericSeen++;
      if (near(m.netPurchasesCents, m.totalBrandCents + m.totalGenericCents)) brandGenericOk++;
    }
    if (m.netPurchasesCents !== null && m.totalRxCents !== null && m.totalOtcCents !== null) {
      rxOtcSeen++;
      if (near(m.netPurchasesCents, m.totalRxCents + m.totalOtcCents)) rxOtcOk++;
    }
  }
  const checkable = brandGenericSeen;
  checks.push({
    what: "Every month's brand and generic pair uniquely to its net purchases",
    ok: brandGenericSeen > 0 && brandGenericOk === brandGenericSeen && paired === months.length,
    detail: `${paired} of ${months.length} months paired, ${brandGenericOk} of ${brandGenericSeen} add up`,
  });
  checks.push({
    what: "Net purchases = Rx + OTC",
    ok: rxOtcSeen > 0 && rxOtcOk === rxOtcSeen,
    detail: rxOtcSeen === 0 ? "no OTC column found" : `${rxOtcOk} of ${rxOtcSeen} months`,
  });
  for (const m of months) {
    if (m.totalBrandCents !== null && m.totalRxCents) {
      m.brandOverRxPercent = Math.round((m.totalBrandCents / m.totalRxCents) * 10000) / 100;
    }
  }
  if (checkable === 0) problems.push("No month row carried enough amounts to check the columns against the report's own arithmetic.");
  else if (!checks.every((c) => c.ok)) {
    problems.push(
      "The columns did not satisfy the report's own arithmetic, so they have not been taken as read. " +
        "Reading them anyway would file figures that look reasonable and sit under the wrong headings.",
    );
  }

  return { generatedOn: generatedOn(text), exclusions: printed, scrubbed, months, checks, problems };
}
