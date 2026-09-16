import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { expectedNow } from "@/lib/expected-store";
import { cadenceWords, type ExpectedState, type Judged } from "@/lib/expected";
import { fmt, whenLocal } from "@/lib/dates";
import { PageHeader, Notice } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Everything somebody else is supposed to send this pharmacy, and whether they are sending it.
 *
 * The owner, 16 September 2026: "you need to make a tab that tracks EVERYTHING we are expecting, how
 * often we expect it, and if we are receiving it, or last time we have.. this need to be smart, IE
 * shouldnt expect bank statement until end of month".
 *
 * The smartness is the whole page and it is subtractive: on the 16th this says nothing at all about
 * the bank statement except that it is not due yet. Every row is judged against its own calendar, so
 * a red mark here means a date has genuinely passed. A screen that is red for three weeks in four
 * teaches a person to stop looking at it, and then it cannot do the one job it has.
 *
 * Grouped by what to do about it rather than by what kind of document it is: the things that have
 * stopped, the things that have never once come, the things arriving. Nothing is called "missing".
 */

const GROUPS: { state: ExpectedState; title: string; blurb: string; tone: "crit" | "warn" | "muted" }[] = [
  {
    state: "overdue",
    title: "Chase these",
    blurb:
      "Either a sender that has broken its own measured habit, or a delivery booked in at the counter with no invoice behind it. " +
      "Nothing reaches this list on a rhythm nobody measured.",
    tone: "crit",
  },
  {
    state: "due_now",
    title: "Due about now",
    blurb: "The date has just passed and the sender is still inside the time they usually take. Nothing to do yet.",
    tone: "warn",
  },
  {
    state: "never_arrived",
    title: "Never once arrived",
    blurb: "Expected, and not one has ever reached the site. Each of these needs somebody set up to send it — a job for a quiet afternoon, not an emergency.",
    tone: "warn",
  },
  { state: "arriving", title: "Arriving", blurb: "Came on or after the last date it was due.", tone: "muted" },
  { state: "not_yet_due", title: "Not started yet", blurb: "Arranged, and the first one is not owed yet.", tone: "muted" },
  { state: "not_expected", title: "Not expected", blurb: "The pharmacy does not receive these, so no date makes them late.", tone: "muted" },
];

export default async function ExpectedPage() {
  await requireUser();
  const { rows, summary, readAt } = await expectedNow();

  return (
    <>
      <PageHeader
        title="What we're expecting"
        subtitle="Everything somebody else has to send, how often, and when the last one came."
        actions={
          <>
            <Link href="/" className="btn">Today</Link>
            <Link href="/inbox" className="btn hidden sm:inline-flex">Inbox</Link>
          </>
        }
      />

      <Notice kind={summary.overdue > 0 ? "warn" : "ok"}>
        {summary.says}. Each sender is judged against its own measured rhythm — {summary.measured} of{" "}
        {rows.length} have arrived often enough to have one — so a monthly document is not late until
        its month is over, and an irregular one is not late until it has been quiet longer than it
        has ever been before.
      </Notice>

      {GROUPS.map((g) => {
        const mine = rows.filter((r) => r.state === g.state);
        if (mine.length === 0) return null;
        return (
          <section key={g.state} className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-2">
              {g.title} <span className="font-normal text-ink-3">({mine.length})</span>
            </h2>
            <p className="mt-0.5 text-xs text-ink-3">{g.blurb}</p>
            <ul className="mt-2 grid gap-3">
              {mine.map((r) => (
                <Row key={r.key} r={r} tone={g.tone} />
              ))}
            </ul>
          </section>
        );
      })}

      <p className="mt-6 text-xs text-ink-3">
        Read {whenLocal(readAt)} from the tables each reader fills, never from a job's claim to have run: a reader that
        quietly stopped storing looks exactly like a sender that stopped sending, and only the stored row tells them
        apart. A row whose cadence nobody has settled says so rather than inventing one.
      </p>
    </>
  );
}

function Row({ r, tone }: { r: Judged; tone: "crit" | "warn" | "muted" }) {
  const stripe = tone === "crit" ? "border-l-4 border-l-crit" : tone === "warn" ? "border-l-4 border-l-warn" : "";
  return (
    <li className={`card ${stripe}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-base font-semibold">{r.label}</span>
        <span className="text-right text-xs text-ink-3">
          <span className="block">{cadenceWords(r.using)}</span>
          <span className="block tabular-nums">
            {r.lastAt ? `last one ${fmt(r.lastAt.slice(0, 10))}` : "none, ever"}
            {r.everCount > 0 ? ` · ${r.everCount.toLocaleString()} on file` : ""}
          </span>
        </span>
      </div>
      <p className="mt-1 text-sm text-ink">{r.says}</p>
      <p className="mt-1 text-sm text-ink-2">
        <span className="text-ink-3">From {r.from}. </span>
        {r.whyItMatters}
      </p>
      {/*
        Which kind of number this row is judged by, on the row itself.
        A measured rhythm and one typed into a file look identical once they are both a date on a
        screen, and only one of them is evidence. "Overdue since the 5th" should send him to the
        bank; it should not, if the 5th was a guess.
      */}
      {/* A row counted in deliveries has no rhythm and needs none: the count is better evidence than any date. */}
      {!r.owing && (
        <p className="mt-1 text-xs text-ink-3">
          <span className={`badge ${r.basis === "measured" ? "" : "badge-warn"}`}>{r.basis === "measured" ? "measured" : "not yet measured"}</span>{" "}
          {r.basisSays}
        </p>
      )}
      {r.note && <p className="mt-1 text-xs text-ink-3">{r.note}</p>}
      <div className="mt-2">
        <Link href={r.href} className="btn btn-sm">Open it</Link>
      </div>
    </li>
  );
}
