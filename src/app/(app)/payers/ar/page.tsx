import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { familyTabs } from "@/lib/families";
import { audit } from "@/lib/audit";
import { todayIso, fmtLong } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { getSettings, setSetting } from "@/lib/settings";
import { arReportFor, arMonths, arMailSetup, sendArReport } from "@/lib/ar-report-store";
import { AGE_BANDS, AGE_BAND_LABEL, SEND_ON_DAY, monthLabel, previousMonth } from "@/lib/ar-report";
import { PageHeader, Card, Notice, Empty, Figure } from "@/components/ui";
import { PrintButton } from "@/components/print-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Monthly AR report" };

/**
 * What payers owed at a month end, on a page that is meant to leave the building.
 *
 * The owner asked for it in one line — "do we have an AR report I can print monthly.." — and then
 * for the other half of it: "i should also be able to setup auto email of this report to another
 * email." Both are here, because they are the same document and separating them would mean two
 * places to look when the figures are questioned.
 *
 * ── Why this is not the payer screen with a date on it ──
 *
 * "What they owe" answers the question about now, over whatever window happens to be loaded — four
 * hundred days by default, a figure chosen so the screen is never empty. This answers it as at a
 * date that has passed, and everything it counts is pinned there: a remittance that arrived in
 * October cannot settle a September balance, and a fill dated in October was not owed in September.
 * That is what makes reprinting it in January give the same document, which is the entire point of
 * handing one to an accountant.
 *
 * ── What it will not print ──
 *
 * A patient. It is by payer and by claim count, and there is no column anywhere on it for a name, a
 * date of birth or a member id. And a due date: no remittance cycle for any of these payers is on
 * file, so the report gives the age of each balance and leaves the judgement to the contract.
 */
export default async function ArReportPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; ok?: string; error?: string; setup?: string }>;
}) {
  await requireReimbursement();
  const user = await requireUser();
  const sp = await searchParams;
  const canManage = user.role !== "staff";

  const today = todayIso();
  const months = arMonths(today);
  /*
   * The month that has just finished, not the one in progress. Somebody opening this on the 3rd of
   * October wants September — the month there is a report for — and defaulting to the two days of
   * October already elapsed would make the page look empty on the day it is most likely to be used.
   */
  const fallback = months.find((m) => m.complete)?.month ?? months[0]?.month ?? today.slice(0, 7);
  const month = months.some((m) => m.month === sp.month) ? sp.month! : fallback;

  const [loaded, setup, settings] = await Promise.all([arReportFor(month, today), arMailSetup(), getSettings()]);
  const pharmacy = (settings.pharmacy_name || "the pharmacy").trim();
  const here = `/payers/ar?month=${month}`;

  async function saveSetup(fd: FormData) {
    "use server";
    const u = await requireManager();
    const to = String(fd.get("to") ?? "").trim();
    await setSetting("ar_report_email", to);
    await setSetting("ar_report_auto", fd.get("auto") ? "yes" : "no");
    await audit({ action: "ar.report.settings", userId: u.id, userName: u.name, details: to || "(nobody)" });
    revalidatePath("/payers/ar");
    redirect(
      `/payers/ar?month=${String(fd.get("month") ?? "")}&ok=` +
        encodeURIComponent(
          to
            ? `Saved. The report for each month will go to ${to} on the ${SEND_ON_DAY}th of the month after it, or the first day the computer is on after that.`
            : "Saved. No address is set, so nothing is sent automatically. The report is still here to print whenever you want it.",
        ),
    );
  }

  async function sendNow(fd: FormData) {
    "use server";
    const u = await requireManager();
    const m = String(fd.get("month") ?? "");
    const to = String(fd.get("to") ?? "").trim();
    /*
     * A copy sent by hand is never recorded as the month having gone out. Otherwise mailing
     * yourself a copy to see what it looks like marks September as dealt with, and the accountant
     * never gets one — a silence nobody notices for a quarter.
     */
    const record = fd.get("record") === "yes";
    try {
      const r = await sendArReport(m, to, { record });
      await audit({ action: record ? "ar.report.send" : "ar.report.test", userId: u.id, userName: u.name, details: `${m} → ${to}` });
      revalidatePath("/payers/ar");
      redirect(`/payers/ar?month=${m}&${r.ok ? "ok" : "error"}=` + encodeURIComponent(r.message));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/payers/ar?month=${m}&error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not send that."));
    }
  }

  const r = loaded.report;

  return (
    <>
      <div className="no-print">
        <PageHeader
          tabs={familyTabs("payers", "/payers/ar")}
          title="Monthly AR report"
          subtitle="What every payer owed on the last day of a month, fixed at that date so it prints the same in January as it did in October."
          actions={
            <>
              <Link href={`/payers/ar?month=${month}&setup=1`} className="btn">
                Who gets it each month
              </Link>
              <PrintButton />
            </>
          }
        />

        {sp.ok && <Notice kind="ok">{sp.ok}</Notice>}
        {sp.error && <Notice kind="crit">{sp.error}</Notice>}

        {/* ── Who it goes to ───────────────────────────────────────────── */}
        {sp.setup === "1" && canManage && (
          <Card title="Email a copy every month" className="mb-6">
            <p className="card-sub">
              One address. The report for a finished month goes out on the {SEND_ON_DAY}th of the month after it —
              a few days&rsquo; grace, because an 835 for September routinely arrives in the first days of October
              carrying a September date, and a report sent at midnight on the 1st would be missing money that is
              about to be counted in it.
            </p>
            <form action={saveSetup} className="mt-2 grid gap-3">
              <input type="hidden" name="month" value={month} />
              <label className="text-xs font-medium text-ink-2">
                Send it to
                <input
                  name="to"
                  type="email"
                  defaultValue={setup.to}
                  placeholder="your accountant's address"
                  className="field mt-1 w-full max-w-sm"
                />
                <span className="mt-1 block font-normal text-ink-3">
                  Leave it empty and nothing is sent. The report stays here to print whenever you want it.
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="auto" defaultChecked={setup.auto} className="mt-0.5" />
                <span>
                  Send it on its own each month.
                  <span className="block text-xs text-ink-3">
                    Turn this off and nothing goes out unless you press send below. Only the most recently finished
                    month is ever sent — setting this up today will not post six months of back reports.
                  </span>
                </span>
              </label>
              <div>
                <button className="btn btn-primary">Save</button>
                <Link href={here} className="btn ml-1.5">Done</Link>
              </div>
            </form>

            {!setup.canSend && (
              <p className="mt-3 text-xs text-crit">
                This site cannot send mail yet, so an address here would be a wish rather than an arrangement. Set the
                mailbox up first in <Link href="/settings/email" className="underline">Settings &rarr; Email</Link>.
              </p>
            )}
            {setup.lastResult && <p className="mt-3 text-xs text-ink-3">Last time: {setup.lastResult}</p>}
          </Card>
        )}

        {/* ── Which month ──────────────────────────────────────────────── */}
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <form className="flex items-center gap-1.5">
            <label className="text-xs font-medium text-ink-2">Month</label>
            <select name="month" defaultValue={month} className="field w-auto py-1 text-sm">
              {months.map((m) => (
                <option key={m.month} value={m.month}>
                  {m.label}
                  {m.complete ? "" : " — not finished"}
                </option>
              ))}
            </select>
            <button className="btn btn-sm">Show</button>
          </form>

          {canManage && setup.canSend && r && (
            <form action={sendNow} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="month" value={month} />
              <input type="hidden" name="record" value="no" />
              <label className="text-xs font-medium text-ink-2">
                Send this month&rsquo;s to
                <input name="to" type="email" required defaultValue={setup.to} className="field mt-1 w-56" />
              </label>
              <button className="btn btn-sm">Send it now</button>
            </form>
          )}
        </div>

        <p className="mb-4 text-xs leading-snug text-ink-3">
          Printing: in the print box, open <b>More settings</b> and untick <b>Headers and footers</b> — that is what
          puts the web address along the bottom of every page, which does not belong on a document you are handing to
          somebody. Then print, or save as PDF.
        </p>
      </div>

      {/*
        The document itself, from here down. The same thing on screen and on paper, deliberately —
        a print preview that differs from what was on the screen is how somebody sends the wrong
        figures without ever seeing them.
      */}
      {!r ? (
        <Empty>{loaded.why}</Empty>
      ) : (
        <>
          <header className="print-block mb-4 border-b-2 border-line-strong pb-2">
            <div className="text-lg font-bold tracking-tight">Accounts receivable — {r.label}</div>
            <div className="text-sm text-ink-2">{pharmacy}</div>
            <div className="mt-1 text-xs text-ink-3">
              As at {fmtLong(r.asAt)}. Every figure is what stood on that date. Counted from {fmtLong(r.from)}, the day
              these books begin.
            </div>
          </header>

          {!r.complete && (
            <Notice kind="warn">
              <b>{r.label} has not finished.</b> This is the balance as at {fmtLong(r.asAt)}, which is today — useful to
              look at, and not a month end. Pick a finished month for anything that is going to be filed.
            </Notice>
          )}

          <p className="print-prose mb-4 text-sm leading-relaxed text-ink-2">{r.says}</p>

          <div className="grid gap-3 sm:grid-cols-3">
            <Figure value={formatCents(r.billedCents)} label="Billed" sub={`${r.lines.length} payer${r.lines.length === 1 ? "" : "s"} that can pay`} tone="muted" />
            <Figure
              value={formatCents(r.receivedCents)}
              label="Received"
              sub={r.nothingHasArrived ? "Nothing had arrived by that date" : `Against those claims, by ${r.asAt}`}
              tone="muted"
            />
            <Figure
              value={formatCents(r.outstandingCents)}
              label="Outstanding"
              sub={`As at ${r.asAt}`}
              tone={r.outstandingCents > 0 ? "warn" : "ok"}
            />
          </div>

          {r.lines.length === 0 ? (
            <Empty>Nothing was billed to a payer that pays in this period, so nobody owed anything.</Empty>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface">
              <table className="table">
                <thead>
                  <tr>
                    <th>Payer</th>
                    <th className="text-right">Claims</th>
                    <th className="text-right">Billed</th>
                    <th className="text-right">Received</th>
                    <th className="text-right">Outstanding</th>
                    <th className="text-right">Oldest claim</th>
                  </tr>
                </thead>
                <tbody>
                  {r.lines.map((l) => (
                    <tr key={l.key}>
                      <td>
                        <div className="font-medium">{l.name}</div>
                        {l.bin && <div className="font-mono text-xs text-ink-3">BIN {l.bin}</div>}
                      </td>
                      <td className="text-right tabular-nums">{l.claims.toLocaleString()}</td>
                      <td className="text-right tabular-nums">{formatCents(l.billedCents)}</td>
                      <td className="text-right tabular-nums">{formatCents(l.receivedCents)}</td>
                      <td className="text-right font-medium tabular-nums">{formatCents(l.outstandingCents)}</td>
                      <td className="whitespace-nowrap text-right text-xs text-ink-3">
                        {l.oldestOn ?? "—"}
                        {l.daysWaiting === null ? "" : ` · ${l.daysWaiting}d`}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-medium">
                    <td>Total</td>
                    <td className="text-right tabular-nums">{r.lines.reduce((n, l) => n + l.claims, 0).toLocaleString()}</td>
                    <td className="text-right tabular-nums">{formatCents(r.billedCents)}</td>
                    <td className="text-right tabular-nums">{formatCents(r.receivedCents)}</td>
                    <td className="text-right tabular-nums">{formatCents(r.outstandingCents)}</td>
                    <td className="text-right text-xs text-ink-3">as at {r.asAt}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* ── How long it has been waiting ─────────────────────────────── */}
          <Card
            title="How long it has been waiting"
            subtitle="Measured from the day each prescription was filled. Nothing here is called overdue: no remittance cycle for any of these payers is on file, so a deadline would be one this pharmacy invented."
            className="mt-4 print-block"
          >
            <div className="overflow-x-auto">
              <table className="table">
                <tbody>
                  {AGE_BANDS.map((b) => (
                    <tr key={b}>
                      <td>{AGE_BAND_LABEL[b]}</td>
                      <td className="text-right tabular-nums">{formatCents(r.ageing.bands[b])}</td>
                    </tr>
                  ))}
                  {r.ageing.unagedCents > 0 && (
                    <tr>
                      <td>
                        Cannot be aged
                        <div className="mt-0.5 max-w-xl text-xs leading-snug text-ink-3">
                          {r.ageing.unagedPayers} payer{r.ageing.unagedPayers === 1 ? " has" : "s have"} part-paid. What
                          arrived is summed against the payer rather than matched to particular claims, so nothing on
                          file says which of its prescriptions the money covered. The balance is real; the age of it is
                          not something this pharmacy knows, and a column that guessed would be worse than one that
                          says so.
                        </div>
                      </td>
                      <td className="text-right tabular-nums">{formatCents(r.ageing.unagedCents)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          {/* ── The money that is deliberately in none of the totals ─────── */}
          {r.cashPlans.length > 0 && (
            <Card title="Not receivables" className="mt-4 print-block">
              <p className="text-sm leading-relaxed text-ink-2">
                <span className="font-medium text-ink">{formatCents(r.cashBilledCents)}</span> was billed through{" "}
                {r.cashPlans.length} plan{r.cashPlans.length === 1 ? "" : "s"} the pharmacy bills through rather than
                one that pays — {r.cashPlans.map((l) => l.name).join(", ")}. The copay was collected at the counter on
                the day, so nobody owes it, and it is in none of the figures above. It is named here rather than left
                out in silence: a figure that quietly differs between two documents is discovered later and assumed to
                be a fault.
              </p>
            </Card>
          )}

          {r.unattached.count > 0 && (
            <Card title="Money that belongs to no claim here" className="mt-4 print-block">
              <p className="text-sm leading-relaxed text-ink-2">
                {r.unattached.count} payment{r.unattached.count === 1 ? "" : "s"} totalling{" "}
                <span className="font-medium text-ink">{formatCents(r.unattached.cents)}</span> arrived for
                prescriptions this site does not hold. The money is real and it settles nothing above, because there is
                no claim here for it to settle. It is not a defect and there is nothing to fix.
              </p>
            </Card>
          )}

          <p className="print-prose mt-6 text-xs leading-snug text-ink-3">
            Scoped on the date each prescription was <span className="font-medium">filled</span>, not the date it was
            collected. A payer owes what it adjudicated from the moment it adjudicated, whether or not the patient has
            been in — so this and the month&rsquo;s revenue, which counts a fill when it is sold, will not agree, and
            both are right. By payer and by claim count: no patient appears on this report.
            {setup.to ? ` A copy of each finished month goes to ${setup.to}.` : ""}
          </p>

          <div className="no-print mt-4 text-xs text-ink-3">
            {setup.to && setup.auto ? (
              <>
                Each finished month goes to {setup.to} on the {SEND_ON_DAY}th of the month after it — the next one due
                is {monthLabel(previousMonth(today.slice(0, 7)))}.{" "}
                {setup.lastMonth ? `Last sent: ${monthLabel(setup.lastMonth)}.` : "Nothing has been sent yet."}
              </>
            ) : (
              <>
                Nothing is emailed automatically.{" "}
                <Link href={`/payers/ar?month=${month}&setup=1`} className="text-accent underline">
                  Set an address
                </Link>{" "}
                and a copy of each finished month goes out on its own.
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}
