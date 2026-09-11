import "server-only";
import { todayIso } from "./dates";
import { getSettings, setSetting } from "./settings";
import { sendMail } from "./send-mail";
import { owedRows } from "./payer-owed-store";
import { owedByPayer } from "./payer-owed";
import {
  arReport,
  arReportCsv,
  arReportText,
  arFileName,
  ageOutstanding,
  monthWindow,
  monthIsReportable,
  monthDueOn,
  monthLabel,
  reportableMonths,
  receivablesAsAt,
  receivedAsAt,
  type ArReport,
} from "./ar-report";

/**
 * Loading the month-end AR report, and posting it to whoever the pharmacy nominates.
 *
 * The owner asked for two things in two sentences — *"do we have an AR report I can print
 * monthly.."* and then *"i should also be able to setup auto email of this report to another
 * email"* — and the second is the one with the failure mode. A report you print is a report you
 * looked at; a report that emails itself is one nobody looks at until the month it is wrong. So the
 * sending here is deliberately dull: one address, one month, and a record of exactly what went where
 * and when, kept in settings so the page can say it out loud rather than leaving it to be trusted.
 *
 * Nothing on this path calls a paid API. The standing rule is that nothing reaches out for money
 * unless somebody pressed something, and a background job that quietly bills is the shape of the
 * problem that rule exists for. This one reads the database and talks to the pharmacy's own mail
 * server, which it already does every half hour for the mailbox sweep.
 */

/** Everything a month's report needs, or the reason there is not one. */
export async function arReportFor(month: string, today = todayIso()): Promise<{ report: ArReport } | { report: null; why: string }> {
  const ok = monthIsReportable(month, today);
  if (!ok.ok) return { report: null, why: ok.why };

  const window = monthWindow(month, today);
  /*
   * The range is given rather than left to default, which is the whole difference between this and
   * the payer screen. `owedRows` defaults to the last four hundred days — a figure picked so a
   * screen is never empty — and a report drawn over a window nobody chose is a report whose totals
   * change with the date it was run.
   */
  const rows = await owedRows({ from: window.from, to: window.asAt });

  const receivables = receivablesAsAt(rows.receivables, window.asAt);
  const received = receivedAsAt(rows.received, window.asAt);

  /*
   * Aged against the month end rather than against today. "Waiting 41 days" on a September report
   * has to mean 41 days on 30 September, or the same document says something different every time
   * it is opened and the copy in the accountant's file stops matching the copy on the screen.
   */
  const summary = owedByPayer(receivables, received, window.asAt);
  const report = arReport(month, window, summary);
  report.ageing = ageOutstanding(receivables, report.lines, window.asAt);
  return { report };
}

/** The months there can be a report for, newest first. */
export function arMonths(today = todayIso()) {
  return reportableMonths(today);
}

export type ArMailSetup = {
  /** Where the monthly copy goes. Empty means nobody has been nominated and nothing is sent. */
  to: string;
  /** On unless deliberately switched off — but an unset address switches it off on its own. */
  auto: boolean;
  /** The last month that actually went out, so a restart cannot send one twice. */
  lastMonth: string;
  lastResult: string;
  /** Whether the site can send mail at all. Without this the address is a wish. */
  canSend: boolean;
};

export async function arMailSetup(): Promise<ArMailSetup> {
  const s = await getSettings();
  return {
    to: (s.ar_report_email ?? "").trim(),
    auto: s.ar_report_auto !== "no",
    lastMonth: (s.ar_report_last_month ?? "").trim(),
    lastResult: (s.ar_report_last_result ?? "").trim(),
    canSend: Boolean(s.mail_user && s.mail_password_enc),
  };
}

export type ArSendResult = { ok: boolean; message: string };

/**
 * Sends one month's report to one address.
 *
 * `record` is off for a test copy. A test proves the path works and must not be allowed to look
 * like the month having been dealt with — marking September as sent because somebody mailed
 * themselves a copy is how a month goes missing from the accountant's file and nobody notices for a
 * quarter.
 */
export async function sendArReport(
  month: string,
  to: string,
  opts: { record?: boolean } = {},
): Promise<ArSendResult> {
  const target = to.trim();
  if (!target) return { ok: false, message: "There is no address to send it to. Put one in above and save it first." };

  const loaded = await arReportFor(month);
  if (!loaded.report) return { ok: false, message: loaded.why };
  const r = loaded.report;

  const s = await getSettings();
  const pharmacy = (s.pharmacy_name || "the pharmacy").trim();
  const subject = `${pharmacy} — accounts receivable, ${r.label}`;
  const body = arReportText(r, pharmacy);

  const sent = await sendMail(target, subject, body, [
    // A spreadsheet for whoever wants to sort it. The body already carries the whole report, so
    // losing this to an attachment filter costs nothing that matters.
    { filename: arFileName(month), content: arReportCsv(r), contentType: "text/csv" },
  ]);

  const stamp = new Date().toISOString();
  if (!sent.ok) {
    if (opts.record !== false) await setSetting("ar_report_last_result", `${stamp} — ${monthLabel(month)} FAILED to ${target}. ${sent.error}`);
    return { ok: false, message: sent.error };
  }

  if (opts.record !== false) {
    await setSetting("ar_report_last_month", month);
    await setSetting(
      "ar_report_last_result",
      `${stamp} — ${monthLabel(month)} sent to ${target} via ${sent.via}.${sent.degraded ? " The spreadsheet was refused by the mail server and dropped; the whole report is in the message itself." : ""}`,
    );
  }
  return {
    ok: true,
    message:
      `${monthLabel(month)} has gone to ${target}.` +
      (sent.degraded ? " The mail server refused the attached spreadsheet, so it went without one — the whole report is in the body of the message." : ""),
  };
}

/**
 * The monthly send, run by the background beat.
 *
 * It decides on the day rather than being scheduled for one. This runs on a pharmacy computer that
 * is switched off overnight and at weekends, so a job pinned to 6am on the 5th would simply never
 * fire in a month whose 5th is a Sunday. Instead it asks "is there a month due that has not gone
 * out", which is true on the 5th, and still true on the 8th when the machine is next switched on.
 *
 * Only ever the newest due month. See `monthDueOn`: an address set up in March gets March's report
 * in April, not six months of back reports in one morning.
 */
export async function monthlyArTick(today = todayIso()): Promise<ArSendResult | null> {
  const setup = await arMailSetup();
  if (!setup.auto) return null;
  if (!setup.to) return null; // Nobody nominated. Not a failure; there is simply nothing to do.
  if (!setup.canSend) return null; // No mailbox configured. Settings → Email says so already.

  const due = monthDueOn(today);
  if (!due) return null;
  if (setup.lastMonth && setup.lastMonth >= due) return null;

  return sendArReport(due, setup.to);
}
