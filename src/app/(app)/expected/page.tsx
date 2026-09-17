import { Fragment } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { expectedNow } from "@/lib/expected-store";
import { cadenceWords, type ExpectedState, type Judged } from "@/lib/expected";
import { agoWords } from "@/lib/feed-rules";
import { fmt, whenLocal, todayIso } from "@/lib/dates";
import { monthClose } from "@/lib/month-close-store";
import { monthJustFinished } from "@/lib/monthly-checklist";
import { PageHeader } from "@/components/ui";

/** The month being closed is the one just finished — not the one running. */
async function closeNow() {
  const today = todayIso();
  return monthClose(monthJustFinished(today), today);
}

export const dynamic = "force-dynamic";

/**
 * Everything somebody else is supposed to send this pharmacy, in one table.
 *
 * The owner, 16 September 2026: "you need to make a tab that tracks EVERYTHING we are expecting, how
 * often we expect it, and if we are recieviing it, or last time we have"; then "this screen needs to
 * be user friendly, make sense, present in a clean, clear way"; then, of the cards that replaced the
 * first version: "I was thinking a tablet that shows everything better in a more compact manner..
 * include last time we got it, how often we expect it, if its late, anything else relevant. make the
 * table look clean and professional".
 *
 * ── Why a table is the right answer here and cards were not ──
 *
 * Every row answers the same five questions, and that is precisely when a table beats a list of
 * cards: the eye runs down one column and compares. Cards made twenty rows into a page of scrolling
 * prose where a supplier owing four invoices and a price file that arrived this morning took the same
 * space. The columns are his: what, who from, how often, when last, and whether that is late — with
 * one muted sentence under the name for the thing only that row needs.
 *
 * The site's own `.table` styles carry it, so this looks like every other table here rather than
 * like a page that invented its own.
 *
 * Grouped inside the one table by what to do, worst first, with a tinted band naming each group.
 * Nothing is called "missing" anywhere on it, and nothing is red before its date.
 */

const GROUPS: { state: ExpectedState; title: string; blurb: string }[] = [
  { state: "overdue", title: "Chase", blurb: "past its own measured habit, or a delivery with no invoice behind it" },
  { state: "due_now", title: "Due about now", blurb: "the date has passed and the sender is still inside the time it usually takes" },
  { state: "never_arrived", title: "Never once arrived", blurb: "each needs somebody set up to send it" },
  { state: "arriving", title: "Arriving on time", blurb: "came on or after the last date it was due" },
  { state: "not_yet_due", title: "Not started yet", blurb: "arranged, and the first one is not owed yet" },
  { state: "not_expected", title: "Not expected", blurb: "the pharmacy does not receive these" },
];

const CHIP: Record<ExpectedState, { label: string; badge: string; stripe: string }> = {
  overdue: { label: "Wrong", badge: "badge-crit", stripe: "bg-crit" },
  due_now: { label: "Due", badge: "badge-warn", stripe: "bg-warn" },
  never_arrived: { label: "Never", badge: "badge-warn", stripe: "bg-warn" },
  arriving: { label: "On time", badge: "badge-ok", stripe: "bg-accent" },
  not_yet_due: { label: "Not yet", badge: "badge-muted", stripe: "bg-line" },
  not_expected: { label: "n/a", badge: "badge-muted", stripe: "bg-line" },
};

export default async function ExpectedPage() {
  await requireUser();
  const [{ rows, summary, readAt }, close] = await Promise.all([expectedNow(), closeNow()]);
  const now = new Date();
  const wrong = rows.filter((r) => r.state === "overdue").length;
  const due = rows.filter((r) => r.state === "due_now").length;
  const never = rows.filter((r) => r.state === "never_arrived").length;

  return (
    <>
      <PageHeader
        title="What we're expecting"
        subtitle={
          wrong === 0 ? `Nothing is wrong. ${rows.length} things tracked.` : `${wrong} wrong, out of ${rows.length} tracked.`
        }
        actions={
          <>
            <Link href="/" className="btn">Today</Link>
            <Link href="/inbox" className="btn hidden sm:inline-flex">Inbox</Link>
          </>
        }
      />

      <MonthStrip close={close} />

      {/* Wide, so it scrolls in its own box rather than pushing the page sideways. */}
      <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="table min-w-[820px]">
          <thead>
            <tr>
              <th className="w-[92px]">Status</th>
              <th className="w-[32%]">Document</th>
              <th className="w-[14%]">From</th>
              <th className="w-[17%]">How often</th>
              <th className="w-[12%]">Last received</th>
              <th className="w-[12%]">Next expected</th>
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((g) => {
              const mine = rows.filter((r) => r.state === g.state);
              if (mine.length === 0) return null;
              return (
                <Fragment key={g.state}>
                  <tr className="bg-ground hover:bg-ground">
                    <td colSpan={6} className="py-1.5">
                      <span className="text-xs font-semibold uppercase tracking-wide text-ink-2">
                        {g.title} <span className="font-normal">({mine.length})</span>
                      </span>
                      <span className="ml-2 text-xs font-normal normal-case tracking-normal text-ink-3">{g.blurb}</span>
                    </td>
                  </tr>
                  {mine.map((r) => (
                    <Row key={r.key} r={r} now={now} />
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-ink-3">
        Read {whenLocal(readAt)} from the tables each reader fills, never from a job saying it ran. {summary.measured} of{" "}
        {rows.length} senders have arrived often enough for the site to have measured their rhythm, shown in the “how
        often” column; the rest are marked <span className="badge badge-muted">declared</span> and are never accused of
        having stopped, because nothing measured the habit they would be breaking.
      </p>
    </>
  );
}

function Count({ n, label, tone, big }: { n: number; label: string; tone: "crit" | "warn" | "ok"; big?: boolean }) {
  const colour = tone === "crit" ? "text-crit" : tone === "warn" ? "text-warn" : "text-ink-3";
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-2">
      <span className={`block tabular-nums font-semibold ${big ? "text-3xl" : "text-2xl"} ${n > 0 ? colour : "text-ink-3"}`}>{n}</span>
      <span className="block text-xs text-ink-2">{label}</span>
    </div>
  );
}

/**
 * One row, one line.
 *
 * The owner, having been shown a table twice: "we still hjavent turned it into a table.. that is
 * easily readbale". He was looking at a table, so what he meant was that it does not read like one —
 * and he was right. Every row carried two or three lines of wrapped prose under the name, so
 * twenty-five rows were seventy lines of text with a grid drawn round them. A table you cannot run
 * your eye down is a list wearing a table's clothes.
 *
 * So a row is one line and nothing wraps. The sentence that explains a row still matters, but only
 * for the rows that need doing — a feed that arrived this morning does not need a paragraph saying
 * so — and it appears under the name only there, where there are never many. Every row carries it on
 * hover as well, so nothing is lost for the ones that stay quiet.
 */
function Row({ r, now }: { r: Judged; now: Date }) {
  const chip = CHIP[r.state];
  const last = r.lastAt ? r.lastAt.slice(0, 10) : null;
  const needsDoing = r.state === "overdue" || r.state === "due_now" || r.state === "never_arrived";
  return (
    <tr title={r.says}>
      {/*
        Status first, with a colour bar, because this page exists to make a problem obvious and the
        last column on the right is the last place a reader looks.
      */}
      <td className="whitespace-nowrap">
        <span className="flex items-center gap-2">
          <span className={`inline-block h-4 w-1 rounded-sm ${chip.stripe}`} aria-hidden />
          <span className={`badge ${chip.badge}`}>{chip.label}</span>
        </span>
      </td>
      <td>
        <Link href={r.href} className="font-medium text-ink hover:underline">
          {r.label}
        </Link>
        {needsDoing && <div className="mt-0.5 text-xs leading-snug text-ink-2">{r.says}</div>}
      </td>
      <td className="truncate text-xs text-ink-2">{r.from}</td>
      <td className="whitespace-nowrap text-xs text-ink-2">
        {r.owing ? "one per delivery" : cadenceWords(r.using)}
        {!r.owing && r.basis === "declared" && <span className="ml-1 text-ink-3">(declared)</span>}
      </td>
      <td className="num whitespace-nowrap text-xs">
        {last ? (
          <>
            <span className="text-ink">{fmt(last)}</span> <span className="text-ink-3">{agoWords(last, now)}</span>
          </>
        ) : (
          <span className="text-ink-3">never</span>
        )}
      </td>
      <td className="num whitespace-nowrap text-xs text-ink-2">
        {r.nextDueOn ? fmt(r.nextDueOn) : <span className="text-ink-3">—</span>}
      </td>
    </tr>
  );
}

/**
 * The month's close: one strip, and what has to be true before it closes.
 *
 * "Closed" is claimed only where every document is in and every figure agrees. A month with its
 * statement on file and bank lines nothing explains is not closed, and saying so would be a promise
 * that the books balance.
 */
function MonthStrip({ close }: { close: Awaited<ReturnType<typeof closeNow>> }) {
  const chip =
    close.state === "closed"
      ? { label: "closed", cls: "badge-ok" }
      : close.state === "running"
        ? { label: "still running", cls: "badge-muted" }
        : close.state === "before_books"
          ? { label: "before the books", cls: "badge-muted" }
          : close.state === "waiting_on_documents"
            ? { label: `waiting on ${close.documentsOutstanding}`, cls: "badge-warn" }
            : { label: "does not tie", cls: "badge-crit" };
  const stripe =
    close.state === "closed" ? "border-l-accent" : close.state === "money_does_not_tie" ? "border-l-crit" : "border-l-line";

  return (
    <section className={`card mt-4 border-l-4 py-3 ${stripe}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="flex items-baseline gap-2 text-sm font-semibold">
          {monthWords(close.month)}
          <span className={`badge ${chip.cls}`}>{chip.label}</span>
        </span>
        <Link href="/money" className="btn btn-sm">The month&rsquo;s books</Link>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink-2">{close.says}</p>
      {close.checks.length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-xs text-ink-3">What has to be true before it closes</summary>
          <ul className="mt-1.5 grid gap-1 text-xs text-ink-2">
            {close.checks.map((c) => (
              <li key={c.key}>
                <span className={`badge ${c.done ? "badge-ok" : "badge-warn"}`}>
                  {c.gate === "money" ? (c.done ? "ties" : "does not tie") : c.done ? "in" : "not in"}
                </span>{" "}
                {c.says}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function monthWords(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]} ${y}`;
}
