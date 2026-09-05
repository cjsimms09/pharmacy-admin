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
};

export const TITLE = "Rx Transaction Details By Submission Type";

/** The column names the report carries, on both header lines, in any order. */
export const EXPECTED_HEADERS = [
  "Rx Number", "Status", "Amount", "Group", "Ntw Reim. Id", "Copay", "Dispensing Fee", "Total", "Completed Date",
  "Date Filled", "BIN", "Tax", "QTY", "Acq. Inv. Cost", "PCN", "NDC", "GrossProfit",
];

/**
 * Where each field sits in a data row. Fixed, because the wrapped header gives no positions;
 * verified on every row by the shape checks in readRow.
 */
const POS = {
  rxFill: 0, status: 1, amount: 2, group: 3, network: 4, copay: 5, dispensingFee: 6, patientTotal: 7,
  completed: 8, dateFilled: 9, bin: 10, qty: 11, acquisition: 12, pcn: 13, ndc: 14, grossProfit: 15,
} as const;
const FIELD_COUNT = 16;

const RX_FILL = /^(\d+)-(\d+)$/;
const DATE_MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/;
const PERIOD = /^(\d{1,2}\/\d{1,2}\/\d{4})[^,]*,\s*to\s*,\s*(\d{1,2}\/\d{1,2}\/\d{4})/i;
const FOOTER = /Page \d+ of \d+\s*$/i;
const SECTION = /^Third Party:,(.*)$/;
const MONEY_AS_ID = /^\$([\d,]+)\.00$/;

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
    if (/Totals?:/.test(line)) continue;

    const parts = splitRow(raw, ",").map((x) => x.trim());

    // Header lines: every field is a column name we know. Both lines feed one set.
    if (parts.length > 1 && parts.every((p) => EXPECTED_HEADERS.includes(p))) {
      parts.forEach((p) => headers.add(p));
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

    if (!RX_FILL.test(parts[0] ?? "")) { skip("a line that is not a transaction"); continue; }
    if (!headerSeen) { skip("a transaction before the header row"); continue; }
    if (parts.length !== FIELD_COUNT) { skip(`a transaction with ${parts.length} fields where ${FIELD_COUNT} were expected`); continue; }
    if (!section) { skip("a transaction under no Third Party line"); continue; }

    const t = readRow(parts, section, submissionType, ++ordinal);
    if (typeof t === "string") { skip(t); continue; }
    const n = (keysSeen.get(t.transactionKey) ?? 0) + 1;
    keysSeen.set(t.transactionKey, n);
    t.transactionKey = `${t.transactionKey}#${n}`;
    rows.push(t);
  }

  if (!headerSeen) {
    problems.push(`This does not look like the "${TITLE}" report — no header row beginning "Rx Number" was found.`);
  } else {
    const missing = EXPECTED_HEADERS.filter((h) => !headers.has(h));
    if (missing.length) {
      problems.push(
        `The report's columns have changed: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} no longer in the header. ` +
          "The positions this reads by are fixed for the report as it was set up, so nothing was loaded until somebody has looked.",
      );
      rows.length = 0;
    }
  }
  if (rows.length === 0 && problems.length === 0 && ordinal === 0) problems.push("No transactions were found in the report.");

  return { rows, period, printedOn, headers: [...headers], skipped, reasons, problems };
}

function readRow(parts: string[], section: ReturnType<typeof parseSectionLabel>, submissionType: string | null, ordinal: number): Transaction | string {
  const rx = RX_FILL.exec(parts[POS.rxFill])!;
  const status = parts[POS.status];
  if (status !== "P" && status !== "A" && status !== "R") return `a status other than P, A or R ("${status}")`;
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
  const pcn = parts[POS.pcn] || section.pcnHint || null;
  const groupNumber = repairNumericId(parts[POS.group]) || null;
  const networkId = repairNumericId(parts[POS.network]) || null;
  const ndc11 = ndcRaw.length === 11 ? ndcRaw : null;
  const ndcBare10 = ndcRaw.length === 10 ? ndcRaw : null;
  const quantityThousandths = parseQuantityThousandths(qtyRaw);

  const raw: Record<string, string> = {
    "Rx Number": parts[POS.rxFill], Status: status, Amount: parts[POS.amount], Group: parts[POS.group], "Ntw Reim. Id": parts[POS.network],
    Copay: parts[POS.copay], "Dispensing Fee": parts[POS.dispensingFee], Total: parts[POS.patientTotal], "Completed Date": completed,
    "Date Filled": parts[POS.dateFilled], BIN: binRaw, QTY: qtyRaw, "Acq. Inv. Cost": parts[POS.acquisition], PCN: parts[POS.pcn],
    NDC: parts[POS.ndc], GrossProfit: parts[POS.grossProfit], "Third Party": section.label, "Submission Type": submissionType ?? "",
    "Ingredient Cost Paid (derived)": ingredientPaidCents === null ? "" : (ingredientPaidCents / 100).toFixed(2),
  };

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
 * cancelled them alike — so a day's report sent twice changes nothing the second time.
 *
 * Rows the pharmacy has said to disregard — its own cash plan — are skipped by name and BIN, and
 * so, by default, are rows with no completed date: transmitted, not yet sold, not yet money.
 */
export function planTransactions(
  txns: Transaction[],
  existing: { keys: Set<string>; paid: PaidClaimRef[] },
  opts: { ignoreBins?: string[]; ignoreLabels?: RegExp; requireCompleted?: boolean } = {},
): TransactionPlan {
  const plan: TransactionPlan = { insertPaid: [], insertReversedPaid: [], reverseExisting: [], insertUnmatchedReversal: [], skipped: [], duplicates: 0 };
  const ignoreBins = new Set(opts.ignoreBins ?? []);
  const ignore = opts.ignoreLabels ?? /pharmd/i;
  const usedExisting = new Set<string>();
  const fillKey = (rx: string, fill: number | null) => `${rx}|${fill ?? ""}`;
  const negate = (n: number | null) => (n === null ? null : -n);

  for (const t of txns) {
    if (existing.keys.has(t.transactionKey)) { plan.duplicates++; continue; }
    if ((t.bin && ignoreBins.has(t.bin)) || ignore.test(t.payerLabel)) { plan.skipped.push({ txn: t, why: "cash plan (PharmD), not a third-party claim" }); continue; }
    if (t.status === "R") { plan.skipped.push({ txn: t, why: "rejected by the plan, nothing paid" }); continue; }
    // A row with no completed date is a claim transmitted but not yet sold: the pharmacy's
    // instruction is to leave those until they are, and to price only what has gone out the door.
    if (opts.requireCompleted !== false && !t.completedAt) { plan.skipped.push({ txn: t, why: "not yet sold (no completed date)" }); continue; }
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
