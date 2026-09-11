import { SITE_STARTS_ON, isOutOfBooks, monthIsOutOfBooks } from "./books-start";
import { daysBetween, pad } from "./dates";
import { formatCents } from "./money";
import { payerKey, type OwedSummary, type PayerLine, type Receivable, type Received } from "./payer-owed";

/**
 * A month's accounts receivable, as at the last day of it.
 *
 * The owner asked for it in one line — *"do we have an AR report I can print monthly.."* — and the
 * answer was no. `payer-owed.ts` has answered "what does this payer owe" since the 9th, but it
 * answers it about *now*, over whatever window happens to be loaded: its range defaults to the last
 * four hundred days, which is a number chosen so the screen is never empty and is not a period
 * anybody reports on. A report is not that page with a different heading. It is a statement as at a
 * date that has already passed, and everything it counts has to be pinned to that date and stay
 * pinned — otherwise the copy printed in October and the copy printed in January carry the same
 * title, the same month and different figures, and the one in the accountant's file is the wrong one.
 *
 * Three rules do the pinning. All three live here rather than in the loader, so the arithmetic that
 * decides what an accountant is handed can be checked without a database.
 *
 *   The billed side is clamped at both ends. `allFills` loads a fill if it was *either* filled or
 *   collected inside the window, which is right for the account — revenue follows the day the
 *   patient collects — and wrong here, because it drags an August fill collected in September into
 *   a report whose first day is 1 September. A receivable is in this report only if the day it was
 *   filled falls between the day the books begin and the day the report is as at.
 *
 *   The received side is clamped at the top. A remittance that arrived on 4 October did not exist
 *   on 30 September and must not settle a 30 September balance, or the September report shrinks
 *   every time it is reprinted.
 *
 *   Nothing from before the books begin reaches it at all. The owner, of the April and June
 *   remittances he pulled to prove the claim matcher works: *"I do not want to track or keep track
 *   of payments from before 09/01.. these are test only and should not show up on any AR reports or
 *   anything."* He named this report. The loader excludes those rows in SQL; they are excluded
 *   again here, where a test can see it, because the one rule this file cannot get wrong is that one.
 *
 * ── What it will not say ──
 *
 * That anything is overdue. No remittance cycle is on file for any payer, so a due date would be one
 * this pharmacy invented and then believed — the same mistake `payer-owed.ts` refuses to make, and
 * it is not a mistake that becomes safe because the page is printed. The report ages the balance by
 * how long ago the prescription was filled and leaves the judgement to whoever holds the contract.
 *
 * And it will not age a balance it cannot age. What has arrived is summed per payer rather than
 * matched claim by claim, so where a payer has part-paid there is no telling which of its claims the
 * money covered — and an ageing column that quietly assumes the oldest was settled first is a
 * confident answer to a question the data cannot answer. Those balances go in a column of their own
 * that says why.
 *
 * Pure. `ar-report-store.ts` loads the rows and sends it.
 */

/** "2026-09" and nothing else. Four digits, a dash, and a month that exists. */
export function isMonth(s: string | null | undefined): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec((s ?? "").trim());
  return m !== null && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

/** The last day of a month, which is the date every figure in the report is as at. */
export function lastDayOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  // UTC, so the answer cannot depend on which side of midnight the pharmacy computer is.
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${pad(last)}`;
}

/** "September 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })} ${y}`;
}

export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

/**
 * The months there can be a report for: the month the books begin in, up to the month today is in.
 *
 * Newest first, because the one somebody wants is almost always the one that has just ended. The
 * current month is in the list — a balance as at this morning is a useful thing to print in the
 * middle of a month — and it is marked as unfinished so nobody files a half month as a month end.
 */
export function reportableMonths(today: string): { month: string; label: string; complete: boolean }[] {
  const first = SITE_STARTS_ON.slice(0, 7);
  const now = today.slice(0, 7);
  const out: { month: string; label: string; complete: boolean }[] = [];
  let cursor = now;
  // A guard rather than a while: a mis-set books-start date must not spin here forever.
  for (let i = 0; i < 600 && cursor >= first; i++) {
    out.push({ month: cursor, label: monthLabel(cursor), complete: lastDayOf(cursor) < today });
    cursor = previousMonth(cursor);
  }
  return out;
}

/**
 * The window a month's report covers.
 *
 * It begins on the day the books begin rather than on the first of the month, and that is the
 * difference between an AR report and a month's activity. What a payer owes on 30 September is
 * everything it has not paid for, whenever the prescription was filled — a claim from the first
 * week of September is still outstanding at the end of October and belongs on October's report too.
 * A window of one month would answer "what did we bill in September", which the monthly statement
 * already answers, and would quietly drop every older debt from the page whose whole subject is
 * older debts.
 *
 * `asAt` is held back to today for a month that has not finished, so a report run on the 12th says
 * it is as at the 12th instead of claiming to know the 30th.
 */
export function monthWindow(month: string, today: string): { from: string; asAt: string; complete: boolean } {
  const end = lastDayOf(month);
  const complete = end < today;
  return { from: SITE_STARTS_ON, asAt: complete ? end : today < monthStart(month) ? monthStart(month) : today, complete };
}

/** Whether a month can be reported on at all: a real month, and not one from before the books begin. */
export function monthIsReportable(month: string, today: string): { ok: boolean; why: string } {
  if (!isMonth(month)) return { ok: false, why: "That is not a month. Pick one from the list." };
  if (monthIsOutOfBooks(month)) {
    return {
      ok: false,
      why: `These books begin on ${SITE_STARTS_ON}, so there is nothing to report for ${monthLabel(month)}. Anything on file from before then is test data and is deliberately counted nowhere.`,
    };
  }
  if (month > today.slice(0, 7)) return { ok: false, why: `${monthLabel(month)} has not happened yet.` };
  return { ok: true, why: "" };
}

/**
 * The receivables that belong in a report as at `asAt`, and only those.
 *
 * Both ends matter and for different reasons. The bottom end keeps out-of-books fills out: the
 * loader's window is a union of filled-in and collected-in, so an August fill a patient came in for
 * in September arrives here with an August fill date, and an August fill is not this pharmacy's
 * September receivable. The top end keeps the report honest when it is reprinted: a fill dated after
 * the month end cannot have been owed at the month end.
 */
export function receivablesAsAt(receivables: Receivable[], asAt: string): Receivable[] {
  return receivables.filter((r) => r.dateFilled >= SITE_STARTS_ON && r.dateFilled <= asAt);
}

/**
 * The payments that had actually arrived by `asAt`.
 *
 * A payment with no date on it is kept, for the same reason `isOutOfBooks` keeps one: a remittance
 * that names no date is far more likely to be the one being read right now than a deliberate pull of
 * an old month, and the failure that matters is dropping money the pharmacy really has. The
 * out-of-books test is applied again here even though the loader already excluded those rows in
 * SQL — this is the report the owner named by name, and a rule worth stating twice is this one.
 */
export function receivedAsAt(received: Received[], asAt: string): Received[] {
  return received.filter((p) => !isOutOfBooks(p.receivedOn) && (p.receivedOn === null || p.receivedOn <= asAt));
}

/** How long a claim had been waiting at the month end. Not how late it is: nothing here is late. */
export const AGE_BANDS = ["0-30", "31-60", "61-90", "91+"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export function ageBandOf(dateFilled: string, asAt: string): AgeBand {
  const days = daysBetween(dateFilled, asAt);
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "91+";
}

export const AGE_BAND_LABEL: Record<AgeBand, string> = {
  "0-30": "Filled within 30 days",
  "31-60": "31 to 60 days",
  "61-90": "61 to 90 days",
  "91+": "More than 90 days",
};

export type Ageing = {
  bands: Record<AgeBand, number>;
  /**
   * Outstanding that cannot honestly be put in a band, and the reason it cannot.
   *
   * A payer that has part-paid. Its payments are summed against it rather than matched to
   * particular claims, so nothing on file says which of its prescriptions the money covered — and
   * an ageing column that assumes the oldest was cleared first is an invention. It is a real
   * balance and it is in the total; it is simply not aged.
   */
  unagedCents: number;
  unagedPayers: number;
};

/**
 * The balance, by how long its prescriptions have been waiting.
 *
 * Only the payers that have never remitted can be aged, and for them the arithmetic is exact rather
 * than assumed: nothing has arrived, so every cent billed is still outstanding and each cent sits in
 * the band of the fill it came from. Everything else goes to `unagedCents`. On the day this was
 * written that is every payer on the list, because no payer 835 has ever reached this pharmacy.
 */
export function ageOutstanding(receivables: Receivable[], lines: PayerLine[], asAt: string): Ageing {
  const bands: Record<AgeBand, number> = { "0-30": 0, "31-60": 0, "61-90": 0, "91+": 0 };
  const ageable = new Set(
    lines.filter((l) => l.state !== "cashPlan" && l.outstandingCents > 0 && l.receivedCents === 0).map((l) => l.key),
  );
  const unaged = lines.filter((l) => l.state !== "cashPlan" && l.outstandingCents > 0 && l.receivedCents > 0);

  /*
   * Grouped with `payerKey` rather than with a rule of this file's own. Which rows are one payer is
   * decided in exactly one place, so a payer carrying no BIN — grouped on its printed name there —
   * cannot end up aged as one payer and totalled as another.
   */
  for (const r of receivables) {
    if (!ageable.has(payerKey(r.bin, r.name))) continue;
    bands[ageBandOf(r.dateFilled, asAt)] += r.cents;
  }

  return {
    bands,
    unagedCents: unaged.reduce((n, l) => n + l.outstandingCents, 0),
    unagedPayers: unaged.length,
  };
}

export type ArReport = {
  month: string;
  label: string;
  /** The first day counted. The books begin here; nothing earlier is in any figure. */
  from: string;
  /** Every figure is as at this date. */
  asAt: string;
  /** False where the month has not finished, so nobody files a part month as a month end. */
  complete: boolean;
  /** The payers that can owe. A cash plan is not one of them and is not in any total. */
  lines: PayerLine[];
  /** Plans the pharmacy bills through that never remit, kept apart rather than dropped in silence. */
  cashPlans: PayerLine[];
  cashBilledCents: number;
  billedCents: number;
  receivedCents: number;
  outstandingCents: number;
  ageing: Ageing;
  unattached: { count: number; cents: number };
  nothingHasArrived: boolean;
  says: string;
};

/**
 * The report, from the summary the shared code already produced.
 *
 * Cash plans are lifted out of every total rather than left in them. On the payer screen their
 * billed figure is worth showing beside the others — it is money the pharmacy took — but a
 * receivables statement that counts it is claiming somebody owes it, and nobody does: the copay was
 * collected at the counter on the day. They are listed under the table with that sentence, because
 * a figure that vanishes between two documents is discovered later and assumed to be a fault.
 */
export function arReport(
  month: string,
  window: { from: string; asAt: string; complete: boolean },
  summary: OwedSummary,
): ArReport {
  const cashPlans = summary.lines.filter((l) => l.state === "cashPlan");
  const lines = summary.lines.filter((l) => l.state !== "cashPlan");
  const billedCents = lines.reduce((n, l) => n + l.billedCents, 0);
  const receivedCents = lines.reduce((n, l) => n + l.receivedCents, 0);
  const outstandingCents = lines.reduce((n, l) => n + l.outstandingCents, 0);

  const report: ArReport = {
    month,
    label: monthLabel(month),
    from: window.from,
    asAt: window.asAt,
    complete: window.complete,
    lines,
    cashPlans,
    cashBilledCents: cashPlans.reduce((n, l) => n + l.billedCents, 0),
    billedCents,
    receivedCents,
    outstandingCents,
    ageing: { bands: { "0-30": 0, "31-60": 0, "61-90": 0, "91+": 0 }, unagedCents: 0, unagedPayers: 0 },
    unattached: summary.unattached,
    nothingHasArrived: summary.nothingHasArrived,
    says: "",
  };
  report.says = arSays(report);
  return report;
}

/** The sentence at the top, which is the whole report for anybody who reads no further. */
export function arSays(r: ArReport): string {
  const when = r.complete ? `as at ${r.asAt}` : `as at ${r.asAt}, part way through ${r.label}`;
  if (r.lines.length === 0) {
    return `Nothing was billed to a payer that pays, ${when}. Nobody owes this pharmacy anything.`;
  }
  const head =
    `${formatCents(r.outstandingCents)} outstanding from ${r.lines.length} payer${r.lines.length === 1 ? "" : "s"} ${when} — ` +
    `${formatCents(r.billedCents)} billed, ${formatCents(r.receivedCents)} received.`;
  if (r.nothingHasArrived) {
    return (
      `${head} Not one payer had remitted anything by that date, so every received figure is a true nought rather ` +
      `than a missing one, and none of this is called late: no remittance cycle for any of these payers is on file.`
    );
  }
  return `${head} Nothing here is called overdue — no remittance cycle for any of these payers is on file, so the age of each claim is given and the judgement left to the contract.`;
}

/**
 * The report as an email.
 *
 * The whole of it, in the body. There is a spreadsheet attached for whoever wants to sort it, and
 * the attachment is the part most likely not to arrive — `send-mail.ts` carries the scar: a bare
 * message went and the same message with files on it was dropped by the provider without bouncing.
 * So the body is the report and the attachment is a convenience, not the other way round.
 */
export function arReportText(r: ArReport, pharmacy: string): string {
  const out: string[] = [];
  const rule = (s: string) => [s, "-".repeat(s.length)];

  out.push(`ACCOUNTS RECEIVABLE — ${r.label.toUpperCase()}`, `${pharmacy}`, `As at ${r.asAt}. Every figure below is what stood on that date.`, "");
  if (!r.complete) {
    out.push(`${r.label} has not finished. This is the balance so far, not a month end.`, "");
  }
  out.push(r.says, "");

  out.push(...rule("TOTAL"));
  out.push(`  Billed        ${formatCents(r.billedCents)}`);
  out.push(`  Received      ${formatCents(r.receivedCents)}`);
  out.push(`  OUTSTANDING   ${formatCents(r.outstandingCents)}`);
  out.push("");

  out.push(...rule("BY PAYER"));
  if (r.lines.length === 0) out.push("  Nothing was billed to a payer that pays.");
  for (const l of r.lines) {
    out.push(
      `  ${l.name}${l.bin ? ` (BIN ${l.bin})` : ""}`,
      `      ${l.claims.toLocaleString()} claim${l.claims === 1 ? "" : "s"} · billed ${formatCents(l.billedCents)} · received ${formatCents(l.receivedCents)} · outstanding ${formatCents(l.outstandingCents)}`,
      `      Oldest claim filled ${l.oldestOn ?? "—"}${l.daysWaiting === null ? "" : ` (${l.daysWaiting} days before the month end)`}`,
    );
  }
  out.push("");

  out.push(...rule("HOW LONG IT HAS BEEN WAITING"));
  out.push("  Measured from the day each prescription was filled. Nothing here is overdue: no");
  out.push("  remittance cycle for any of these payers is on file, so no deadline is claimed.");
  for (const b of AGE_BANDS) out.push(`  ${AGE_BAND_LABEL[b].padEnd(24)} ${formatCents(r.ageing.bands[b])}`);
  if (r.ageing.unagedCents > 0) {
    out.push(
      `  ${"Cannot be aged".padEnd(24)} ${formatCents(r.ageing.unagedCents)}`,
      `      ${r.ageing.unagedPayers} payer${r.ageing.unagedPayers === 1 ? " has" : "s have"} part-paid. What arrived is summed against the payer`,
      "      rather than matched to particular claims, so nothing on file says which of its",
      "      prescriptions the money covered. The balance is real; the age of it is not knowable.",
    );
  }
  out.push("");

  if (r.cashPlans.length > 0) {
    out.push(...rule("NOT RECEIVABLES"));
    out.push(
      `  ${formatCents(r.cashBilledCents)} was billed through ${r.cashPlans.length} plan${r.cashPlans.length === 1 ? "" : "s"} the pharmacy bills through rather than`,
      "  one that pays. The copay was collected at the counter, so nobody owes it and it is in",
      `  none of the figures above: ${r.cashPlans.map((l) => l.name).join(", ")}.`,
      "",
    );
  }

  if (r.unattached.count > 0) {
    out.push(...rule("MONEY THAT BELONGS TO NO CLAIM HERE"));
    out.push(
      `  ${r.unattached.count} payment${r.unattached.count === 1 ? "" : "s"} totalling ${formatCents(r.unattached.cents)} arrived for prescriptions this site does`,
      "  not hold. It is real money and it settles nothing above, because there is no claim here",
      "  for it to settle. It is not an error.",
      "",
    );
  }

  out.push(
    "Scoped on the date each prescription was filled, not the date it was collected. A payer owes",
    "what it adjudicated from the moment it adjudicated, whether or not the patient has been in, so",
    "this will not agree with the month's revenue and both are right.",
    "",
    `Counted from ${r.from}, the day these books begin. Nothing from before that date is in any figure.`,
    "By payer and by prescription count. No patient appears on this report.",
  );
  return out.join("\n");
}

/**
 * The same thing as a spreadsheet.
 *
 * Money as a plain number rather than through `formatCents`, which is the one place on this site
 * that is right: a dollar sign and a thousands separator turn a column an accountant wants to add
 * up into text, and then the total at the bottom of their sheet is blank and nobody knows why.
 */
export function arReportCsv(r: ArReport): string {
  const dollars = (cents: number) => (cents / 100).toFixed(2);
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows: string[] = [];
  rows.push(["Payer", "BIN", "Claims", "Billed", "Received", "Outstanding", "Oldest claim filled", "Days waiting", "Where it stands"].join(","));
  for (const l of r.lines) {
    rows.push(
      [
        cell(l.name),
        cell(l.bin ?? ""),
        l.claims,
        dollars(l.billedCents),
        dollars(l.receivedCents),
        dollars(l.outstandingCents),
        cell(l.oldestOn ?? ""),
        l.daysWaiting ?? "",
        cell(l.says),
      ].join(","),
    );
  }
  rows.push(["Total", "", r.lines.reduce((n, l) => n + l.claims, 0), dollars(r.billedCents), dollars(r.receivedCents), dollars(r.outstandingCents), "", "", cell(`As at ${r.asAt}`)].join(","));
  return rows.join("\r\n") + "\r\n";
}

export function arFileName(month: string): string {
  return `accounts-receivable-${month}.csv`;
}

/**
 * How many days into the new month the report waits before it sends itself.
 *
 * Not nought. An 835 for September routinely lands in the first days of October carrying a
 * September remittance date, and a report sent at one minute past midnight on the 1st would be
 * missing money that was about to be counted in it — so the copy in the accountant's file and the
 * copy on the screen would disagree within the week. Five days is enough for the cycle and short
 * enough that nobody is waiting on it.
 */
export const SEND_ON_DAY = 5;

/**
 * The month whose report is due to go out, or null if none is.
 *
 * Deliberately only ever the most recent one. A recipient set up in March should get March's report
 * in April, not six months of back reports in one morning — the months are all still on the screen,
 * and an inbox full of them is how somebody learns to filter the sender.
 */
export function monthDueOn(today: string, sendOnDay: number = SEND_ON_DAY): string | null {
  const day = Number(today.slice(8, 10));
  const thisMonth = today.slice(0, 7);
  // Before the send day, last month's report is not due yet — the one before it is the newest due.
  const due = day >= sendOnDay ? previousMonth(thisMonth) : previousMonth(previousMonth(thisMonth));
  if (monthIsOutOfBooks(due)) return null;
  return due;
}
