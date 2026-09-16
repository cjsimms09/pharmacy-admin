import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { expectedNow } from "@/lib/expected-store";
import { cadenceWords, type ExpectedState, type Judged } from "@/lib/expected";
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
 * Everything somebody else is supposed to send this pharmacy, and whether they are sending it.
 *
 * The owner, 16 September 2026: "you need to make a tab that tracks EVERYTHING we are expecting, how
 * often we expect it, and if we are receiving it, or last time we have.. this need to be smart, IE
 * shouldnt expect bank statement until end of month". Then, of the first version: "this screen needs
 * to be user friendly, make sense, present in a clean, clear way".
 *
 * ── What the second note changed ──
 *
 * The first version gave every row the same card and four sentences of prose — why it matters, how
 * it was judged, what was measured, a note — so a supplier owing four invoices and a price file that
 * arrived this morning were the same weight on the page, and the eye had nowhere to land. Twenty-odd
 * of those is a wall.
 *
 * So the page is now shaped like the decision it serves. Three things to act on at the top, at full
 * size, each with the one sentence that says what to do. Everything healthy collapses into a single
 * quiet list of one-liners — present, checkable, silent. The reasoning every row still carries is
 * behind a disclosure, because it is worth reading once and never again.
 *
 * Nothing is called "missing" anywhere on it, and nothing is red before its date.
 */

type Tone = "crit" | "warn" | "calm";

const GROUPS: { state: ExpectedState; title: string; blurb: string; tone: Tone }[] = [
  {
    state: "overdue",
    title: "Chase these",
    blurb: "A sender that has broken its own measured habit, or a delivery with no invoice behind it.",
    tone: "crit",
  },
  {
    state: "due_now",
    title: "Due about now",
    blurb: "The date has just passed and the sender is still inside the time it usually takes.",
    tone: "warn",
  },
  {
    state: "never_arrived",
    title: "Never once arrived",
    blurb: "Each needs somebody set up to send it — a quiet afternoon, not an emergency.",
    tone: "warn",
  },
];

const QUIET: { state: ExpectedState; title: string }[] = [
  { state: "arriving", title: "Arriving on time" },
  { state: "not_yet_due", title: "Not started yet" },
  { state: "not_expected", title: "Not expected here" },
];

export default async function ExpectedPage() {
  await requireUser();
  const [{ rows, summary, readAt }, close] = await Promise.all([expectedNow(), closeNow()]);
  const needsYou = rows.filter((r) => r.state === "overdue" || r.state === "due_now" || r.state === "never_arrived");

  return (
    <>
      <PageHeader
        title="What we're expecting"
        subtitle={
          needsYou.length === 0
            ? "Everything is arriving. Nothing needs chasing."
            : `${needsYou.length} of ${rows.length} need something; the rest are arriving.`
        }
        actions={
          <>
            <Link href="/" className="btn">Today</Link>
            <Link href="/inbox" className="btn hidden sm:inline-flex">Inbox</Link>
          </>
        }
      />

      <MonthCard close={close} />

      {GROUPS.map((g) => {
        const mine = rows.filter((r) => r.state === g.state);
        if (mine.length === 0) return null;
        return (
          <section key={g.state} className="mt-6">
            <h2 className="flex items-baseline gap-2 text-sm font-semibold uppercase tracking-wide text-ink-2">
              {g.title}
              <span className="font-normal normal-case tracking-normal text-ink-3">{g.blurb}</span>
            </h2>
            <ul className="mt-2 grid gap-2">
              {mine.map((r) => (
                <ActionRow key={r.key} r={r} tone={g.tone} />
              ))}
            </ul>
          </section>
        );
      })}

      {/*
        The healthy majority, one line each.
        A feed that is working needs to be visible — an absent row is how a feed disappears — but it
        does not need a card, a reason and a measurement. Name, when it last came, and the rhythm.
      */}
      {QUIET.map((g) => {
        const mine = rows.filter((r) => r.state === g.state);
        if (mine.length === 0) return null;
        return (
          <section key={g.state} className="mt-6">
            <h2 className="flex items-baseline gap-2 text-sm font-semibold uppercase tracking-wide text-ink-2">
              {g.title}
              <span className="font-normal normal-case tracking-normal text-ink-3">{mine.length}</span>
            </h2>
            <ul className="mt-2 divide-y divide-line rounded-md border border-line">
              {mine.map((r) => (
                <QuietRow key={r.key} r={r} />
              ))}
            </ul>
          </section>
        );
      })}

      <p className="mt-6 text-xs text-ink-3">
        Read {whenLocal(readAt)} from the tables each reader fills, never from a job saying it ran. {summary.measured} of{" "}
        {rows.length} senders have arrived often enough for the site to have measured their rhythm; the rest are judged
        by what was declared, and are never accused of having stopped.
      </p>
    </>
  );
}

/**
 * The month's close: one line, and the figures that have to tie under it.
 *
 * "Closed" is claimed only where every document is in and every figure agrees. A month with its
 * statement on file and eleven lines nothing explains is not closed, and saying so would be a promise
 * that the books balance.
 */
function MonthCard({ close }: { close: Awaited<ReturnType<typeof closeNow>> }) {
  const chip =
    close.state === "closed"
      ? { label: "closed", cls: "badge-ok" }
      : close.state === "running"
        ? { label: "still running", cls: "" }
        : close.state === "before_books"
          ? { label: "before the books", cls: "" }
          : close.state === "waiting_on_documents"
            ? { label: `waiting on ${close.documentsOutstanding}`, cls: "badge-warn" }
            : { label: "does not tie", cls: "badge-warn" };
  const stripe = close.state === "closed" ? "border-l-accent" : close.state === "money_does_not_tie" ? "border-l-crit" : "border-l-line";
  const money = close.checks.filter((c) => c.gate === "money");
  const docs = close.checks.filter((c) => c.gate === "document");

  return (
    <section className={`card mt-4 border-l-4 ${stripe}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="flex items-baseline gap-2 text-base font-semibold">
          {monthWords(close.month)}
          <span className={`badge ${chip.cls}`}>{chip.label}</span>
        </span>
        <Link href="/money" className="btn btn-sm">The month&rsquo;s books</Link>
      </div>
      <p className="mt-1 text-sm text-ink-2">{close.says}</p>
      {(money.length > 0 || close.documentsOutstanding > 0) && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-ink-3">What has to be true before it closes</summary>
          <ul className="mt-2 grid gap-1 text-xs text-ink-2">
            {docs.map((c) => (
              <li key={c.key}>
                <span className={`badge ${c.done ? "badge-ok" : "badge-warn"}`}>{c.done ? "in" : "not in"}</span> {c.says}
              </li>
            ))}
            {money.map((c) => (
              <li key={c.key}>
                <span className={`badge ${c.done ? "badge-ok" : "badge-warn"}`}>{c.done ? "ties" : "does not tie"}</span> {c.says}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** Something to do: the name, what it is, and the one sentence that says what happened. */
function ActionRow({ r, tone }: { r: Judged; tone: Tone }) {
  const stripe = tone === "crit" ? "border-l-crit" : "border-l-warn";
  return (
    <li className={`card border-l-4 ${stripe}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-base font-semibold">{r.label}</span>
        <span className="text-xs text-ink-3 tabular-nums">{r.lastAt ? `last ${fmt(r.lastAt.slice(0, 10))}` : "none, ever"}</span>
      </div>
      <p className="mt-1 text-sm text-ink">{r.says}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Link href={r.href} className="btn btn-sm">Open it</Link>
        <span className="text-xs text-ink-3">from {r.from}</span>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-ink-3">Why this matters, and how it was judged</summary>
        <p className="mt-1 text-xs text-ink-2">{r.whyItMatters}</p>
        {!r.owing && <p className="mt-1 text-xs text-ink-3">{r.basisSays}</p>}
        {r.note && <p className="mt-1 text-xs text-ink-3">{r.note}</p>}
      </details>
    </li>
  );
}

/** Working, and staying out of the way: name, last arrival, rhythm. */
function QuietRow({ r }: { r: Judged }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2">
      <Link href={r.href} className="text-sm font-medium text-ink hover:underline">
        {r.label}
      </Link>
      <span className="text-xs text-ink-3 tabular-nums">
        {r.lastAt ? `last ${fmt(r.lastAt.slice(0, 10))}` : "—"}
        <span className="ml-2 text-ink-3">{r.owing ? "one per delivery" : cadenceWords(r.using)}</span>
      </span>
    </li>
  );
}

function monthWords(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]} ${y}`;
}
