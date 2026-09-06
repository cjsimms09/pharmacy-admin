import { parseCents, parseQuantityThousandths } from "./money";
import { splitRow } from "./pioneer-catalog";

/**
 * Reading PioneerRx's "Rx Transaction Details By Submission Type" report.
 *
 * This is the daily claims feed. The pharmacy tried to get a one-row-per-fill export with the
 * columns the floor check needs and could not; what PioneerRx would give was this report, with
 * columns added until it carried NDC, quantity, date filled, the dispensing fee and the payer's
 * routing. It is enough. The floor is NADAC per unit times quantity plus the fee, compared with
 * what the plan and the patient paid between them, and every one of those is here.
 *
 * ── What it is ──
 *
 * A printed report saved as text, like the supplier catalogue: a title block and a header on
 * every page, a "Third Party:" line above each payer's rows, a totals line under them, a page
 * footer, and the odd fragment of a page break ("20", "1f") standing on a line of its own. The
 * header did not fit on one line, so two column names ("Dispensing Fee", "Completed Date") sit
 * on the line above the others, and the "Tax" column named in the header has no cell in the data.
 * Positions therefore cannot be read off the header. They are fixed here, from the file, and
 * every row is checked against them — prescription number, status, date, BIN, quantity and NDC
 * each have a shape, and a row that does not fit the shape is refused rather than read wrong.
 *
 * ── What a row is ──
 *
 * A transaction, not a fill. A claim that was paid, reversed and resubmitted is three rows —
 * status P, then A with every figure negated, then P again, often with a different NDC. The
 * reader keeps them as transactions and leaves the pairing to the importer, which has the
 * database and can match a reversal to a claim paid on an earlier day. Rejected rows (R) carry
 * no money and are counted, not kept.
 *
 * ── What is derived ──
 *
 * The report has no ingredient-cost-paid column. It has the plan's payment, the patient's
 * payment and the dispensing fee, and the ingredient cost paid is what is left: plan paid plus
 * patient paid, less the fee. That is the NCPDP identity (509-F9 + 505-F5 = 506-F6 + 507-F7 when
 * tax is nil), so it is arithmetic, not a guess, and the row says it was derived.
 *
 * ── What is repaired ──
 *
 * PioneerRx formats a purely numeric group or network id as money: group 714553005 arrives as
 * "$714,553,005.00". The digits before the decimal point are the original, so they are put back.
 */

export type TxnStatus = "P" | "A" | "R";

export type Transaction = {
  /** Position in the file, so two identical rows on one day are two transactions. */
  ordinal: number;
  rxNumber: string;
  fillNumber: number | null;
  status: TxnStatus;
  /** The "Third Party:" line above the row, e.g. "003858 (MA) - 003858" or "Rightway - 610862". */
  payerLabel: string;
  submissionType: string | null;
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  networkId: string | null;
  dateFilled: string;
  completedAt: string | null;
  quantityThousandths: number | null;
  /**
   * The NCPDP other coverage code (308-C8), where the report carries it.
   *
   * "08" means the row bills only the patient's financial responsibility, so its amount is not a
   * price for the drug; "03" means other coverage was billed and did not cover. Without it, whether
   * a secondary row is pricing the drug or only covering a copay has to be inferred.
   */
  otherCoverageCode?: string | null;
  /**
   * True where this is the pharmacy's own cash programme rather than a third party.
   *
   * Its margins are as real as any other — it is a fill, and it made or lost money — but there is
   * no plan behind it, no floor for the state to enforce and no payer to appeal to. So it is kept
   * and counted, and held out of every question that only makes sense about an insurer.
   */
  cashPlan?: boolean;
  /**
   * The facilitator payment the report says to expect on this fill, where it carries one.
   *
   * Null where the report has no such column, or printed nothing for this row — which is not the
   * same as zero, and only a promise can be chased.
   */
  expectedFacilitatorCents?: number | null;
  /** What the plan paid (the report's first "Amount"). Negative on a reversal. */
  remitCents: number | null;
  copayCents: number | null;
  dispensingFeeCents: number | null;
  patientTotalCents: number | null;
  acquisitionCents: number | null;
  grossProfitCents: number | null;
  /** Plan paid + patient paid − dispensing fee. Null where any part is missing. */
  ingredientPaidCents: number | null;
  /** Eleven digits, or null. Null with `ndcBare10` set means the importer still has a chance to settle it. */
  ndc11: string | null;
  /**
   * A ten-digit NDC printed without hyphens, kept for the importer to settle against the products
   * the site holds. The reader never pads it: a zero in front is right for one FDA layout and
   * wrong for two, and a claim filed under the wrong product is worse than one with no NDC.
   */
  ndcBare10: string | null;
  /** Identifies this row across re-sends of the same day's report. */
  transactionKey: string;
  raw: Record<string, string>;
};

export type TransactionParse = {
  rows: Transaction[];
  /** The "claims transmitted/processed from … to …" range, as ISO dates. */
  period: { from: string; to: string } | null;
  printedOn: string | null;
  headers: string[];
  skipped: number;
  reasons: Record<string, number>;
  problems: string[];
  /** Every totals line the report printed, by the label above it. */
  totals: { label: string; amounts: (number | null)[] }[];
  /**
   * What the report itself says the whole file came to.
   *
   * The only figures here that this site did not compute, and therefore the only real check on the
   * ones it did. Null where the totals line could not be read without guessing.
   */
  grandTotal: { salesCents: number; acquisitionCents: number; grossProfitCents: number } | null;
};

export const TITLE = "Rx Transaction Details By Submission Type";

/** The column names the report carries, on both header lines, in any order. */
export const EXPECTED_HEADERS = [
  "Rx Number", "Status", "Amount", "Group", "Ntw Reim. Id", "Copay", "Dispensing Fee", "Total", "Completed Date",
  "Date Filled", "BIN", "Tax", "Est", "QTY", "Acq. Inv. Cost", "PCN", "NDC", "GrossProfit",
];

/**
 * Names whose disappearance is not evidence that anything moved.
 *
 * "Tax" was printed in the header and had no cell beneath it — and it is the slot the report's new
 * estimate column was built into, so it has become "Est". Treating that rename as a lost column
 * refused a perfectly good file. The columns that carry figures are the ones whose absence means
 * every field after them has shifted, and those are still checked.
 */
const HEADER_ONLY = new Set(["Tax", "Est"]);

/** The pharmacy's own cash programme: its loyalty plan's BIN, and the section print name. */
export const CASH_BINS = new Set(["028249"]);
export const CASH_LABEL = /pharmd|private pay|\bcash\b/i;

/**
 * Where each field sits in a data row.
 *
 * The header cannot be used to work this out: it wraps across two lines, so two column names sit
 * above the others, and the "Tax" column it names has no cell in the data at all. Positions are
 * therefore taken from the file itself — but they are no longer *assumed*, because a column added
 * to the report shifts every field after it, and every figure then read is individually plausible
 * and collectively wrong. That is the worst failure this reader has: it does not look like an
 * error, it looks like a bad day's trading.
 *
 * So the layout is chosen by evidence. Each candidate is tried against the first rows of the file
 * and scored on things only the true layout can satisfy — a six-digit BIN in the BIN cell, dates in
 * the date cells, an NDC in the NDC cell, and above all the report's own arithmetic:
 *
 *   GrossProfit = Amount + Total − Acq. Inv. Cost
 *
 * A layout off by one fails that on nearly every row. The right one satisfies it on nearly all.
 */
type Layout = {
  rxFill: number; status: number; amount: number; group: number; network: number; copay: number;
  dispensingFee: number; patientTotal: number; completed: number; dateFilled: number; bin: number;
  qty: number; acquisition: number; pcn: number; ndc: number; grossProfit: number;
  /**
   * The columns the report has gained, in position order. Empty on the layout this began with.
   *
   * More than one is expected now: the estimated facilitator payment arrived first, and the other
   * coverage code is the obvious next one to ask for, since it says outright what this reader
   * currently has to infer — whether a row is pricing the drug or only billing the patient's share.
   */
  extras: number[];
};

const BASE: Layout = {
  rxFill: 0, status: 1, amount: 2, group: 3, network: 4, copay: 5, dispensingFee: 6, patientTotal: 7,
  completed: 8, dateFilled: 9, bin: 10, qty: 11, acquisition: 12, pcn: 13, ndc: 14, grossProfit: 15,
  extras: [],
};
const BASE_COUNT = 16;

const FIELDS = [
  "rxFill", "status", "amount", "group", "network", "copay", "dispensingFee", "patientTotal",
  "completed", "dateFilled", "bin", "qty", "acquisition", "pcn", "ndc", "grossProfit",
] as const;

/**
 * Every layout a row of this width could plausibly have.
 *
 * One extra column can land anywhere, so every landing place is offered and the evidence picks.
 * More than one added at once is not guessed at — the file is refused and somebody looks, which is
 * the right answer for a report that has been rebuilt rather than extended.
 */
export function candidateLayouts(fieldCount: number): Layout[] {
  const added = fieldCount - BASE_COUNT;
  if (added === 0) return [BASE];
  /*
   * Two at once is as far as this will guess. Beyond that the report has been rebuilt rather than
   * extended, and the honest answer is to refuse it and have somebody look — reading it on a guess
   * gives figures that are individually plausible and collectively wrong, which is the one failure
   * worth refusing a file over.
   */
  if (added < 0 || added > 2) return [];

  const out: Layout[] = [];
  const place = (at: number[]) => {
    const sorted = [...at].sort((a, b) => a - b);
    /*
     * Insertion points are given in the original layout's coordinates; the positions they end up at
     * are not the same thing. The second column inserted sits one further along than it was asked
     * for, because the first one is already in front of it — and a version of this that forgot to
     * shift them had an added column land on top of the BIN it was supposed to sit beside, which
     * scored well and read the wrong cell.
     */
    const l = { extras: sorted.map((a, i) => a + i) } as Layout;
    for (const f of FIELDS) {
      // Each added column at or before a field pushes it one further along.
      l[f] = BASE[f] + sorted.filter((x) => x <= BASE[f]).length;
    }
    return l;
  };
  if (added === 1) {
    for (let a = 0; a <= BASE_COUNT; a++) out.push(place([a]));
    return out;
  }
  for (let a = 0; a <= BASE_COUNT; a++) {
    for (let b = a; b <= BASE_COUNT + 1; b++) out.push(place([a, b]));
  }
  return out;
}

/**
 * What an added column is, decided by what is in it rather than by where it sits.
 *
 * With two of them, position says nothing about which is which — and the header cannot be used,
 * because it wraps and carries a name with no cell beneath it. But the contents are unmistakable:
 * a money column holds amounts, and an other-coverage code holds a two-digit code and never a
 * currency symbol. Read this way the report can gain them in either order and nothing has to change.
 */
/** Which added column plays which part, once the contents have said. */
export type ExtraRoles = { money: number | null; code: number | null };

export function classifyExtra(values: string[]): "money" | "code" | "unknown" {
  const seen = values.map((v) => v.trim()).filter((v) => v !== "");
  if (seen.length === 0) return "unknown";
  if (seen.every((v) => /^\(?-?\$[\d,]+\.\d{2}\)?$/.test(v) || /^-?\d+\.\d{2}$/.test(v))) return "money";
  if (seen.every((v) => /^\d{1,2}$/.test(v))) return "code";
  return "unknown";
}

const isMoney = (s: string) => s.trim() === "" || /^\(?-?\$?[\d,]*\.?\d*\)?$/.test(s.trim());

/**
 * How well a layout explains a row. The arithmetic is worth more than any single shape check,
 * because it is the one thing a shifted layout cannot accidentally satisfy.
 */
export function scoreLayout(layout: Layout, rows: string[][]): number {
  let score = 0;
  for (const parts of rows) {
    if (RX_FILL.test(parts[layout.rxFill] ?? "")) score += 1;
    if (["P", "A", "R"].includes(parts[layout.status] ?? "")) score += 1;
    /*
     * A cell must be right to earn, and wrong to lose. Merely being *allowed* to be blank earns
     * nothing, because a blank is what a shifted layout lands on as often as the true one.
     *
     * This is what separates the only two layouts that ever genuinely compete here — insertion
     * before the BIN and insertion after it, which agree about every other field in the row. On a
     * cash row the BIN is empty and both look equally good; on a third-party row one finds six
     * digits and the other finds a dollar sign, and that is the whole answer.
     */
    const bin = (parts[layout.bin] ?? "").trim();
    if (/^\d{6}$/.test(bin)) score += 4;
    else if (bin !== "") score -= 4;
    if (DATE_MDY.test(parts[layout.dateFilled] ?? "")) score += 1;
    const ndc = (parts[layout.ndc] ?? "").replace(/\D/g, "");
    if (ndc.length === 10 || ndc.length === 11) score += 4;
    else if (ndc !== "") score -= 4;
    /*
     * The quantity, which is the check that actually separates the two layouts that matter.
     *
     * The column the report gained sits directly beside QTY, so "inserted before the quantity" and
     * "inserted after it" agree about every other field and score identically on all of them. They
     * differ on one thing: a quantity is a bare number and a money cell is not. Without this the
     * evidence ties, the file is refused, and a correct report does not load.
     */
    const qty = (parts[layout.qty] ?? "").trim();
    if (qty !== "" && /^-?[\d.]+$/.test(qty)) score += 4;
    else if (qty !== "") score -= 4;
    // And an added column should hold something a column holds — money, or a short code.
    for (const x of layout.extras) {
      const v = (parts[x] ?? "").trim();
      if (v === "" || isMoney(v) || /^\d{1,2}$/.test(v)) score += 2;
      else score -= 2;
    }
    for (const f of ["amount", "copay", "patientTotal", "acquisition", "grossProfit"] as const) {
      if (isMoney(parts[layout[f]] ?? "")) score += 1;
    }
    // The report checking itself. Worth ten shape checks, because only the true layout satisfies it.
    const amount = parseCents(parts[layout.amount]);
    const total = parseCents(parts[layout.patientTotal]);
    const acq = parseCents(parts[layout.acquisition]);
    const gp = parseCents(parts[layout.grossProfit]);
    if (amount !== null && total !== null && acq !== null && gp !== null && Math.abs(amount + total - acq - gp) <= 2) {
      score += 10;
    }
  }
  return score;
}

/** The layout the rows themselves say this file has, or null where nothing fits convincingly. */
export function chooseLayout(rows: string[][]): { layout: Layout; confident: boolean } | null {
  /*
   * Sampled across the whole report, never off the top of it.
   *
   * The report is grouped by payer and the first section is Private Pay, where the BIN cell is
   * empty on every row — so the first forty rows are exactly the forty that cannot tell the two
   * competing layouts apart. Taking a stride through the file guarantees third-party rows, which
   * are the ones that decide it.
   */
  const stride = Math.max(1, Math.floor(rows.length / 120));
  const sample = rows.filter((_, i) => i % stride === 0).slice(0, 120);
  if (sample.length === 0) return null;
  const scored = candidateLayouts(sample[0].length)
    .map((layout) => ({ layout, score: scoreLayout(layout, sample) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  const [best, next] = scored;
  /*
   * A clear winner, or nothing. Two layouts scoring alike means the evidence does not distinguish
   * them, and picking one anyway is exactly the silent mis-read this exists to prevent.
   *
   * The margin is absolute rather than proportional: what matters is that the winner explains
   * something about most rows that the runner-up cannot, and a percentage of a score that grows
   * with the file says nothing about that.
   */
  const confident = best.score > 0 && (next === undefined || best.score - next.score >= sample.length);
  return confident ? { layout: best.layout, confident } : null;
}

const RX_FILL = /^(\d+)-(\d+)$/;
const DATE_MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/;
const PERIOD = /^(\d{1,2}\/\d{1,2}\/\d{4})[^,]*,\s*to\s*,\s*(\d{1,2}\/\d{1,2}\/\d{4})/i;
const FOOTER = /Page \d+ of \d+\s*$/i;
const SECTION = /^Third Party:,(.*)$/;
const MONEY_AS_ID = /^\$([\d,]+)\.00$/;

/**
 * The report's own bottom line, taken from the totals it prints rather than from our arithmetic.
 *
 * The last two lines of the file are the whole month in one row — what the pharmacy took, what the
 * drugs cost it, and what it made. It is the only figure in the building that nothing here computed,
 * which makes it the one check worth having: if our totals and these disagree, ours are wrong.
 *
 * The columns cannot be read by name — the totals row has fewer cells than the header has names,
 * and none of them is labelled. So nothing is guessed at. Gross profit is the last cell, because
 * GrossProfit is the last column of the report; and sales and acquisition are then *derived* by
 * finding the one pair on the line that satisfies the same identity every row satisfies:
 *
 *   sales − acquisition = gross profit
 *
 * On the live file exactly one pair does — $108,976.40 and $96,089.63 — and it is confirmed a
 * second way, independently: $84,179.97 from the plans plus $24,796.43 from patients is that same
 * $108,976.40. Where no single pair fits, nothing is claimed at all, which is the right answer for
 * a total somebody is going to reconcile against their bank.
 */
export function readTotalsLine(amounts: (number | null)[]): { salesCents: number; acquisitionCents: number; grossProfitCents: number } | null {
  const v = amounts.filter((x): x is number => x !== null);
  if (v.length < 4) return null;
  const grossProfitCents = v[v.length - 1];
  const hits: { salesCents: number; acquisitionCents: number }[] = [];
  for (const a of v) {
    for (const b of v) {
      // A zero on either side makes the identity trivially true and says nothing.
      if (a <= 0 || b <= 0 || a === b) continue;
      if (Math.abs(a - b - grossProfitCents) <= 2) hits.push({ salesCents: a, acquisitionCents: b });
    }
  }
  const unique = hits.filter((h, i) => hits.findIndex((x) => x.salesCents === h.salesCents && x.acquisitionCents === h.acquisitionCents) === i);
  if (unique.length !== 1) return null;
  return { ...unique[0], grossProfitCents };
}

export function looksLikeRxTransactions(text: string): boolean {
  return text.replace(/^﻿/, "").slice(0, 4000).includes(TITLE);
}

/** "09/05/26" or "9/5/2026" to ISO. A two-digit year is this century. */
export function mdyToIso(s: string): string | null {
  const m = DATE_MDY.exec(s.trim());
  if (!m) return null;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** "$714,553,005.00" back to "714553005"; anything else unchanged. */
export function repairNumericId(s: string): string {
  const m = MONEY_AS_ID.exec(s.trim());
  return m ? m[1].replace(/,/g, "") : s.trim();
}

/** The payer label and BIN from "003858 (MA) - 003858" or "PharmD Loyalty Plan - 028249". */
export function parseSectionLabel(label: string): { label: string; bin: string | null; pcnHint: string | null } {
  const t = label.trim().replace(/^"|"$/g, "");
  const m = /^(.*?)\s*-\s*(\d{6})$/.exec(t);
  const head = m ? m[1].trim() : t;
  const paren = /\(([^)]+)\)/.exec(head);
  return { label: head, bin: m ? m[2] : null, pcnHint: paren ? paren[1].trim() : null };
}

export function parseRxTransactions(text: string): TransactionParse {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const rows: Transaction[] = [];
  const reasons: Record<string, number> = {};
  const problems: string[] = [];
  let skipped = 0;
  let period: TransactionParse["period"] = null;
  let printedOn: string | null = null;
  const headers = new Set<string>();
  let headerSeen = false;
  const skip = (why: string) => {
    skipped++;
    reasons[why] = (reasons[why] ?? 0) + 1;
  };

  let section: ReturnType<typeof parseSectionLabel> | null = null;
  let submissionType: string | null = null;
  let ordinal = 0;
  const keysSeen = new Map<string, number>();
  const pending: { parts: string[]; section: ReturnType<typeof parseSectionLabel>; submissionType: string | null }[] = [];
  const totals: { label: string; amounts: (number | null)[] }[] = [];
  let pendingTotalLabel: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(TITLE)) continue;

    const per = PERIOD.exec(line);
    if (per) {
      const from = mdyToIso(per[1]);
      const to = mdyToIso(per[2]);
      if (from && to && !period) period = { from, to };
      continue;
    }
    if (FOOTER.test(line)) {
      const m = DATE_MDY.exec(line);
      if (m && !printedOn) printedOn = mdyToIso(line);
      continue;
    }

    const sec = SECTION.exec(line);
    if (sec) {
      section = parseSectionLabel(sec[1]);
      continue;
    }
    /*
     * A totals line, kept rather than stepped over.
     *
     * "Grand Total:" carries its figures on the same line; a section total and "Transmitted Totals:"
     * are a label followed by a row of money underneath. Both shapes are held, because the last one
     * in the file is the report's own answer for the whole period and is the only check on ours
     * that did not come from us.
     */
    if (/Totals?:/.test(line)) {
      const cells = splitRow(raw, ",").map((x) => x.trim());
      const label = cells[0].replace(/,$/, "");
      const money = cells.slice(1).filter((c) => c !== "");
      if (money.length >= 4 && money.every((c) => /^\(?-?\$/.test(c))) {
        totals.push({ label, amounts: money.map((c) => parseCents(c)) });
        pendingTotalLabel = null;
      } else {
        pendingTotalLabel = label;
      }
      continue;
    }

    const parts = splitRow(raw, ",").map((x) => x.trim());

    /*
     * Header lines, which must survive the report gaining a column.
     *
     * Requiring every name to be one we already knew meant the day a column was added the header
     * stopped being recognised at all, and the file was rejected as "not this report" — the least
     * useful thing it could have said. Two known names are enough to identify a header line, and
     * anything unfamiliar alongside them is kept rather than rejected: it is the new column, and
     * naming it is how the screen can say what was added.
     */
    if (parts.length > 1 && parts.filter((p) => EXPECTED_HEADERS.includes(p)).length >= 2 && !parts.some((p) => /^\(?\$/.test(p))) {
      parts.forEach((p) => { if (p) headers.add(p); });
      if (parts.includes("Rx Number")) headerSeen = true;
      continue;
    }
    // "Third Party,Script" — the header's group row — and "Transmitted", the submission type.
    if (parts.length === 2 && parts[0] === "Third Party" && parts[1] === "Script") continue;
    if (parts.length === 1) {
      // The pharmacy's name is the second line of every page; "Transmitted" is the submission
      // type the rows below belong to; anything else standing alone is a fragment of a page break.
      if (/pharmacy$/i.test(line)) continue;
      if (/^[A-Za-z][A-Za-z ]+$/.test(line)) submissionType = line;
      else if (/^Uses invoice cost/i.test(line)) { /* the report's own note */ }
      else skip("a page-break fragment");
      continue;
    }
    if (/^Uses invoice cost/i.test(line)) continue;

    if (!RX_FILL.test(parts[0] ?? "")) {
      // A payer's totals: the label line is caught above, and this is the row of figures beneath
      // it — every cell a money amount or blank, no prescription number. Counted under its own
      // reason rather than lumped in with anything unrecognised, so that a transaction row this
      // reader genuinely could not read stands out instead of hiding among thirty totals.
      const allMoney = parts.every((c) => c.trim() === "" || /^\(?\$[\d,]+\.\d{2}\)?$/.test(c.trim()));
      if (allMoney && pendingTotalLabel !== null) {
        totals.push({ label: pendingTotalLabel, amounts: parts.filter((c) => c !== "").map((c) => parseCents(c)) });
        pendingTotalLabel = null;
      }
      skip(allMoney ? "a payer's totals line" : "a line that is not a transaction");
      continue;
    }
    if (!headerSeen) { skip("a transaction before the header row"); continue; }
    if (!section) { skip("a transaction under no Third Party line"); continue; }
    /*
     * Held, not read. Which cell is which cannot be known from one row — it is decided below, from
     * all of them at once, so that a column added to the report is detected rather than absorbed.
     */
    pending.push({ parts, section, submissionType });
  }

  /*
   * Now the layout, from the rows themselves.
   *
   * Widths are counted rather than assumed: a file whose rows disagree about how many fields they
   * have is not a layout problem, it is a broken file, and the majority width is used so a handful
   * of mangled lines cannot outvote a good report.
   */
  const widths = new Map<number, number>();
  for (const r of pending) widths.set(r.parts.length, (widths.get(r.parts.length) ?? 0) + 1);
  const width = [...widths.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? BASE_COUNT;
  const usable = pending.filter((r) => r.parts.length === width);
  for (const r of pending) {
    if (r.parts.length !== width) skip(`a transaction with ${r.parts.length} fields where ${width} were expected`);
  }

  const chosen = usable.length > 0 ? chooseLayout(usable.map((r) => r.parts)) : null;
  const layout = chosen?.layout ?? null;

  if (usable.length > 0 && layout === null) {
    problems.push(
      width === BASE_COUNT || width === BASE_COUNT + 1
        ? `The report's columns are not where this reader expects them, and nothing it tried explains the rows — every figure it read would be plausible and wrong, so nothing was loaded. Send me the file and I will fix the reader.`
        : `The report now has ${width} columns where ${BASE_COUNT} were expected, which is more than one change at a time. Nothing was loaded until somebody has looked — reading it on a guess would give figures that look reasonable and are not.`,
    );
  }

  /*
   * Which added column is which, from what they contain rather than where they sit. With two of
   * them position says nothing, and the header cannot say either — it wraps, and it names a column
   * that has no cell.
   */
  const roles: ExtraRoles = { money: null, code: null };
  if (layout) {
    for (const x of layout.extras) {
      const kind = classifyExtra(usable.slice(0, 200).map((r) => r.parts[x] ?? ""));
      if (kind === "money" && roles.money === null) roles.money = x;
      else if (kind === "code" && roles.code === null) roles.code = x;
    }
  }

  if (layout) {
    for (const r of usable) {
      const t = readRow(r.parts, layout, roles, r.section, r.submissionType, ++ordinal);
      if (typeof t === "string") { skip(t); continue; }
      const n = (keysSeen.get(t.transactionKey) ?? 0) + 1;
      keysSeen.set(t.transactionKey, n);
      t.transactionKey = `${t.transactionKey}#${n}`;
      rows.push(t);
    }
  }

  if (!headerSeen) {
    problems.push(`This does not look like the "${TITLE}" report — no header row beginning "Rx Number" was found.`);
  } else {
    const missing = EXPECTED_HEADERS.filter((h) => !HEADER_ONLY.has(h) && !headers.has(h));
    if (missing.length) {
      problems.push(
        `The report's columns have changed: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} no longer in the header. ` +
          "Nothing was loaded until somebody has looked — a column that has gone means every figure after it has moved.",
      );
      rows.length = 0;
    }
  }
  if (rows.length === 0 && problems.length === 0 && ordinal === 0) problems.push("No transactions were found in the report.");

  /*
   * The report's answer for the whole file: its "Grand Total", or the widest total it printed.
   *
   * Section totals are kept too — they are how a single payer's figures can be checked — but the
   * one that matters is the last and largest, because that is the line somebody reconciles against
   * the bank.
   */
  const grand =
    totals.find((t) => /grand total/i.test(t.label)) ??
    totals.filter((t) => /^transmitted/i.test(t.label)).slice(-1)[0] ??
    null;

  return {
    rows,
    period,
    printedOn,
    headers: [...headers],
    skipped,
    reasons,
    problems,
    totals,
    grandTotal: grand ? readTotalsLine(grand.amounts) : null,
  };
}

function readRow(parts: string[], POS: Layout, roles: ExtraRoles, section: ReturnType<typeof parseSectionLabel>, submissionType: string | null, ordinal: number): Transaction | string {
  const rx = RX_FILL.exec(parts[POS.rxFill])!;
  const status = parts[POS.status];
  /*
   * A status this reader does not know is set aside by name, never guessed at.
   *
   * The live report carries "AR" on a handful of rows, one of them with $1,492.61 of patient
   * responsibility on it. Read as paid it would invent revenue; dropped as a malformed row it would
   * vanish silently. Named, it shows up in the import summary as something to ask about — which is
   * the only honest thing to do with a code whose meaning nobody here knows yet.
   */
  if (status !== "P" && status !== "A" && status !== "R") return `a status this reader does not know yet ("${status}")`;
  const dateFilled = mdyToIso(parts[POS.dateFilled]);
  if (!dateFilled) return "a row whose date-filled cell is not a date";
  const binRaw = parts[POS.bin];
  if (binRaw && !/^\d{6}$/.test(binRaw)) return "a row whose BIN cell is not a six-digit BIN";
  const qtyRaw = parts[POS.qty];
  if (qtyRaw && !/^-?[\d.]+$/.test(qtyRaw)) return "a row whose quantity cell is not a number";
  const ndcRaw = parts[POS.ndc].replace(/\D/g, "");
  if (parts[POS.ndc] && ndcRaw.length !== 11 && ndcRaw.length !== 10) return "a row whose NDC cell is not an NDC";
  const completed = parts[POS.completed];
  if (completed && !DATE_MDY.test(completed)) return "a row whose completed-date cell is not a date";

  const remitCents = parseCents(parts[POS.amount]);
  const copayCents = parseCents(parts[POS.copay]);
  const dispensingFeeCents = parseCents(parts[POS.dispensingFee]);
  const ingredientPaidCents =
    remitCents !== null && copayCents !== null && dispensingFeeCents !== null ? remitCents + copayCents - dispensingFeeCents : null;

  const bin = binRaw || section.bin;
  // PioneerRx prints the PCN as it was typed into the plan ("meddprime" on one plan, "MEDDPRIME"
  // on the section line for the same BIN). A processor control number is not case-sensitive and
  // nothing should have to remember which spelling a plan was typed with, so it is read in one case.
  const pcn = (parts[POS.pcn] || section.pcnHint || null)?.toUpperCase() ?? null;
  const groupNumber = repairNumericId(parts[POS.group]) || null;
  const networkId = repairNumericId(parts[POS.network]) || null;
  const ndc11 = ndcRaw.length === 11 ? ndcRaw : null;
  const ndcBare10 = ndcRaw.length === 10 ? ndcRaw : null;
  const quantityThousandths = parseQuantityThousandths(qtyRaw);

  /*
   * The facilitator payment the plan said to expect, where the report now carries one.
   *
   * The whole reason the report and this site used to disagree: PioneerRx knew a Part D fill had a
   * manufacturer share coming and this reader had nowhere to put it, so every one of them looked
   * like a fill that lost money. Now it is a figure with a source — the plan's own response — and
   * the loop it opens closes when the money arrives and is matched to the fill.
   *
   * A blank cell is not zero. A plan that promised nothing and a report that printed nothing are
   * different facts, and only the first can be chased.
   */
  const expectedFacilitatorCents = roles.money === null ? null : parseCents(parts[roles.money]);

  /*
   * The other coverage code, where the report carries it.
   *
   * NCPDP field 308-C8, and the one thing that would let this reader stop inferring what a
   * secondary row means. An "08" row is billing for the patient's financial responsibility only —
   * so its amount is not a price for the drug, and it must never be allowed to set one. Today that
   * has to be guessed from the shape of the row.
   */
  const otherCoverageCode = roles.code === null ? null : (parts[roles.code] ?? "").trim() || null;

  /*
   * The pharmacy's own cash programme, named from the section it was printed under.
   *
   * "Private Pay (Cash)" carries no BIN at all and "PharmD Loyalty Plan" carries 028249. Both are
   * the same thing: the pharmacy setting its own price. Recognising them here rather than throwing
   * the rows away means the margin still counts, which is the only thing about them that matters.
   */
  const cashPlan = CASH_BINS.has(bin ?? "") || CASH_LABEL.test(section.label);

  const raw: Record<string, string> = {
    "Rx Number": parts[POS.rxFill], Status: status, Amount: parts[POS.amount], Group: parts[POS.group], "Ntw Reim. Id": parts[POS.network],
    Copay: parts[POS.copay], "Dispensing Fee": parts[POS.dispensingFee], Total: parts[POS.patientTotal], "Completed Date": completed,
    "Date Filled": parts[POS.dateFilled], BIN: binRaw, QTY: qtyRaw, "Acq. Inv. Cost": parts[POS.acquisition], PCN: parts[POS.pcn],
    NDC: parts[POS.ndc], GrossProfit: parts[POS.grossProfit], "Third Party": section.label, "Submission Type": submissionType ?? "",
    "Ingredient Cost Paid (derived)": ingredientPaidCents === null ? "" : (ingredientPaidCents / 100).toFixed(2),
  };
  if (roles.money !== null) raw["Est. MTF"] = parts[roles.money] ?? "";
  if (roles.code !== null) raw["OCC"] = parts[roles.code] ?? "";

  return {
    ordinal,
    rxNumber: rx[1],
    fillNumber: Number(rx[2]),
    status,
    payerLabel: section.label,
    submissionType,
    bin,
    pcn,
    groupNumber,
    networkId,
    dateFilled,
    completedAt: completed || null,
    quantityThousandths,
    remitCents,
    copayCents,
    dispensingFeeCents,
    patientTotalCents: parseCents(parts[POS.patientTotal]),
    acquisitionCents: parseCents(parts[POS.acquisition]),
    grossProfitCents: parseCents(parts[POS.grossProfit]),
    expectedFacilitatorCents,
    otherCoverageCode,
    cashPlan,
    ingredientPaidCents,
    ndc11,
    ndcBare10,
    // Keyed on the NDC as printed, so the key is the same whether or not a bare code was later settled.
    transactionKey: [rx[1], rx[2], status, dateFilled, bin ?? "", ndc11 ?? ndcRaw, remitCents ?? "", copayCents ?? "", quantityThousandths ?? ""].join("|"),
    raw,
  };
}

// ── Pairing reversals with the claims they cancel ────────────────────

export type PaidClaimRef = {
  id: string;
  rxNumber: string;
  fillNumber: number | null;
  bin: string | null;
  ndc11: string | null;
  remitCents: number | null;
  copayCents: number | null;
};

export type TransactionPlan = {
  /** Paid rows to store as claims. */
  insertPaid: Transaction[];
  /** Paid and reversed within the same file: stored at once as a reversed claim, with the row that reversed it. */
  insertReversedPaid: { paid: Transaction; reversal: Transaction }[];
  /** Reversals matched to a claim already stored: the claim to mark reversed, and the row that did it. */
  reverseExisting: { claimId: string; reversal: Transaction }[];
  /** Reversals that matched nothing we hold: stored as reversed rows so the money is not lost from view. */
  insertUnmatchedReversal: Transaction[];
  /** Rows already held without a sale date that this file now shows sold: the claim and the date. */
  markSold: { claimId: string; completedAt: string }[];
  /** Rows already held whose figures the report has since restated, and the row to restate from. */
  refresh: { claimId: string; txn: Transaction }[];
  skipped: { txn: Transaction; why: string }[];
  duplicates: number;
};

/**
 * Decides what to do with each transaction, given what is already held.
 *
 * A reversal cancels the most recent paid claim for the same prescription and fill, on the same
 * BIN and NDC, whose figures it negates exactly — first among the paid rows earlier in this same
 * file (paid and reversed within the day), then among the claims already stored (paid on an
 * earlier day). It never cancels a claim already reversed, and never on a partial match: a
 * reversal that fits nothing is kept as its own reversed row and counted, because a reversal that
 * silently vanished would leave a paid claim standing that the plan has taken back.
 *
 * `existing.keys` holds every transaction key already stored — paid rows and the reversals that
 * cancelled them alike — so a day's report sent twice changes nothing the second time. The one
 * thing a re-sent row can change is the sale: `existing.unsold` maps the keys of held claims that
 * had no completed date to their ids, and a duplicate that now carries one fills it in.
 *
 * Rows the pharmacy has said to disregard — its own cash plan — are skipped by name and BIN.
 *
 * A row with no completed date is a claim transmitted but not yet picked up. It is stored all the
 * same, because the report is drawn by the day the claim was *transmitted*: a claim sent on
 * Tuesday and sold on Thursday is in Tuesday's file without a completed date and in no later file
 * at all. Skipping it would lose the claim for good, and with it the reversal that arrives if the
 * patient never comes — which does turn up, in its own day's file, again without a completed
 * date. So the money is kept from the day the plan agreed to pay it, a return to stock takes it
 * back through the ordinary reversal path, and the completed date is recorded when the report has
 * it. `requireCompleted: true` restores the old behaviour for a report drawn by sale date instead.
 */
export function planTransactions(
  txns: Transaction[],
  existing: { keys: Set<string>; paid: PaidClaimRef[]; unsold?: Map<string, string>; byKey?: Map<string, string> },
  opts: { ignoreBins?: string[]; ignoreLabels?: RegExp; requireCompleted?: boolean } = {},
): TransactionPlan {
  const plan: TransactionPlan = { insertPaid: [], insertReversedPaid: [], reverseExisting: [], insertUnmatchedReversal: [], markSold: [], refresh: [], skipped: [], duplicates: 0 };
  const ignoreBins = new Set(opts.ignoreBins ?? []);
  const ignore = opts.ignoreLabels ?? /pharmd/i;
  const usedExisting = new Set<string>();
  const fillKey = (rx: string, fill: number | null) => `${rx}|${fill ?? ""}`;
  const negate = (n: number | null) => (n === null ? null : -n);

  for (const t of txns) {
    if (existing.keys.has(t.transactionKey)) {
      plan.duplicates++;
      const id = t.completedAt ? existing.unsold?.get(t.transactionKey) : undefined;
      if (id) plan.markSold.push({ claimId: id, completedAt: t.completedAt! });
      /*
       * A row already held is counted again rather than stored again — but it is also re-read.
       *
       * The report is not immutable. Its gross profit column was quietly carrying an estimated
       * rebate, which made every figure drawn from it disagree with the pharmacy's own arithmetic;
       * when that was fixed at source, the corrected numbers arrived in a file whose rows this site
       * already held, and skipping them as duplicates would have kept the wrong figures for ever.
       * The same is true of a column the report gains: the promised facilitator payment exists only
       * in the new file, on rows loaded before it was added.
       *
       * So a duplicate refreshes the figures it carries. Its identity, its status and the reversal
       * that cancelled it are untouched — this replaces what the report says about a claim, never
       * what this site has worked out about one.
       */
      const held = existing.byKey?.get(t.transactionKey);
      if (held) plan.refresh.push({ claimId: held, txn: t });
      continue;
    }
    /*
     * The cash programme is kept now, not discarded.
     *
     * Throwing it away lost the margin on every fill the pharmacy priced itself — which is business
     * it fully controls, and therefore the business where a bad margin is most fixable. The rows
     * are marked instead, so nothing downstream mistakes them for an insurer with a floor to owe.
     */
    if ((t.bin && ignoreBins.has(t.bin)) || ignore.test(t.payerLabel)) t.cashPlan = true;
    if (t.status === "R") { plan.skipped.push({ txn: t, why: "rejected by the plan, nothing paid" }); continue; }
    if (opts.requireCompleted === true && !t.completedAt) { plan.skipped.push({ txn: t, why: "not yet sold (no completed date)" }); continue; }
    if (t.status === "P") { plan.insertPaid.push(t); continue; }

    // A reversal. Its figures are the negation of the claim it cancels.
    const matches = (c: { rxNumber: string; fillNumber: number | null; bin: string | null; ndc11: string | null; remitCents: number | null; copayCents: number | null }) =>
      fillKey(c.rxNumber, c.fillNumber) === fillKey(t.rxNumber, t.fillNumber) &&
      c.bin === t.bin && c.ndc11 === t.ndc11 && c.remitCents === negate(t.remitCents) && c.copayCents === negate(t.copayCents);

    let hit = -1;
    for (let i = plan.insertPaid.length - 1; i >= 0; i--) if (matches(plan.insertPaid[i])) { hit = i; break; }
    if (hit >= 0) {
      const [paid] = plan.insertPaid.splice(hit, 1);
      plan.insertReversedPaid.push({ paid, reversal: t });
      continue;
    }
    const stored = existing.paid.filter((c) => !usedExisting.has(c.id) && matches(c)).pop();
    if (stored) {
      usedExisting.add(stored.id);
      plan.reverseExisting.push({ claimId: stored.id, reversal: t });
      continue;
    }
    plan.insertUnmatchedReversal.push(t);
  }
  return plan;
}
