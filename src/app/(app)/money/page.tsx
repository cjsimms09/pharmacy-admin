import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { formatCents } from "@/lib/money";
import { moneyFound, type MoneyFound, type MoneyRow } from "@/lib/money-found";
import { markRecommendation, recommendationScorecard } from "@/lib/recommendation-store";
import { PageHeader, Card, Notice, Empty, Figure } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Where the money is" };

/**
 * One list, in dollars, of everything this site can see that is worth acting on.
 *
 * The site had grown six answers to six questions and every one lived on its own page: what a drug
 * costs elsewhere, what a plan pays, what a rebate band is worth, what a return is still worth,
 * what a claim was paid against the Kansas floor. A pharmacist who wanted to know what to do this
 * morning had to open six screens and add up in his head, which is the same as not being told.
 *
 * Every row is an amount and an instruction. A row that cannot say what to do about it does not
 * belong here — this is not a dashboard of metrics, and a number with no action attached is
 * decoration.
 *
 * The three things that would make it useless are guarded against in the arithmetic rather than in
 * the wording: money is never invented, the same problem is never counted twice, and a saving that
 * recurs every month is never ranked against a one-off recovery as though they were the same thing.
 *
 * Each row is remembered from the morning it first appears, and the owner's word on it — done, or
 * not doing this — is kept beside it. That is what lets the scorecard at the bottom say what the
 * advice has been worth, and lets a row that was tried and did nothing stop being repeated.
 */
export default async function MoneyPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser();
  const { ok, error } = await searchParams;
  const found = await moneyFound();
  const { rows, firstYearCents, recurringMonthlyCents, oneOffCents, blocked, watch } = found;
  const card = await recommendationScorecard().catch(() => null);

  async function mark(fd: FormData) {
    "use server";
    await requireUser();
    const id = String(fd.get("id") ?? "");
    const status = String(fd.get("status") ?? "");
    const note = String(fd.get("note") ?? "").trim() || null;
    if (!id || (status !== "acted" && status !== "dismissed" && status !== "open")) redirect("/money?error=" + encodeURIComponent("Nothing to record."));
    await markRecommendation(id, status, note);
    revalidatePath("/money");
    revalidatePath("/");
    redirect("/money?ok=" + encodeURIComponent(status === "acted" ? "Recorded as done. The claims from here on will say what it was worth." : status === "dismissed" ? "Recorded. It stays on the list, marked as not being done, so the total is honest." : "Reopened."));
  }

  return (
    <>
      <PageHeader
        title="Where the money is"
        subtitle="Everything this site can currently see that is worth acting on, in what it is worth, with what to do about each. Nothing here is estimated — every figure is arithmetic on a document the pharmacy holds."
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {rows.length === 0 ? (
        <Empty>
          Nothing yet. This fills in as invoices are read, the catalogues land, claims arrive and the supplier terms are
          on file — each of those turns on one more of the comparisons below.
        </Empty>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Figure value={formatCents(firstYearCents)} label="in the first year" sub="One-off recoveries plus twelve months of the recurring savings" tone="ok" />
            <Figure value={formatCents(recurringMonthlyCents)} label="a month, recurring" sub="Buying and rebates, if nothing else changes" tone="muted" />
            <Figure value={formatCents(oneOffCents)} label="one-off" sub="Returns and underpayments, recoverable once" tone="muted" />
          </div>

          <div className="mt-4 space-y-3">
            {rows.map((r, i) => <Row key={r.key} r={r} n={i + 1} age={found.ages[r.key]} entry={found.log[r.key]} mark={mark} />)}
          </div>
        </>
      )}

      {watch.length > 0 && (
        <Card
          className="mt-6"
          title="Worth watching, not yet worth a figure"
          count={watch.length}
          subtitle="Measured on too few days to call a month, or on something not yet dispensed. Each becomes a row above when the claims say so."
        >
          <ul className="rows">
            {watch.map((w) => (
              <li key={w.says} className="py-2">
                <p className="text-sm">{w.says}</p>
                <p className="mt-0.5 text-xs text-ink-2">
                  {w.todo} <Link href={w.href} className="text-accent underline">Look</Link>
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {blocked.length > 0 && (
        <Card
          className="mt-6"
          tone="warn"
          title="Money this cannot see yet"
          count={blocked.length}
          subtitle="Each of these is one fact away from being an amount on the list above. They are named rather than left as a shorter list, because a silently short list reads as good news."
        >
          <ul className="rows">
            {blocked.map((b) => (
              <li key={b.says} className="py-2">
                <p className="text-sm">{b.says}</p>
                <p className="mt-0.5 text-xs text-ink-2">
                  {b.todo} <Link href={b.href} className="text-accent underline">Do it</Link>
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {card && (card.open + card.acted + card.dismissed + card.resolved) > 0 && <Scorecard card={card} />}

      <p className="mt-4 text-xs text-ink-3">
        Two problems with the same cause are not added together — a drug bought dearly and dispensed at a loss is one
        problem with two symptoms, and the total counts it once. A recurring saving is shown as a monthly figure and
        only multiplied out in the first-year total, so nothing here is a year&rsquo;s money dressed up as this
        month&rsquo;s. A row measured on less than a week of claims waits under &ldquo;worth watching&rdquo; rather than
        being called a month.
      </p>
    </>
  );
}

function Row({
  r,
  n,
  age,
  entry,
  mark,
}: {
  r: MoneyRow;
  n: number;
  age?: number;
  entry?: MoneyFound["log"][string];
  mark: (fd: FormData) => Promise<void>;
}) {
  const yearly = r.cadence === "recurring_monthly" ? r.amountCents * 12 : r.amountCents;
  const tone = r.confidence === "certain" ? "badge-ok" : r.confidence === "likely" ? "badge-muted" : "badge-warn";
  const status = entry?.status ?? "open";
  return (
    <section className={`card ${status === "dismissed" ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">
          <span className="mr-2 text-ink-3">{n}.</span>
          {r.says}
        </h2>
        <span className="whitespace-nowrap text-right">
          <span className="block text-xl font-bold tabular-nums text-accent">{formatCents(r.amountCents)}</span>
          <span className="block text-[11px] text-ink-3">
            {r.cadence === "recurring_monthly" ? `a month · ${formatCents(yearly)} a year` : "one-off"}
          </span>
        </span>
      </div>
      <p className="mt-1.5 text-sm text-ink-2">{r.todo}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Link href={r.href} className="btn btn-sm btn-primary">Go and do it</Link>
        {entry && status === "open" && (
          <>
            <form action={mark}>
              <input type="hidden" name="id" value={entry.id} />
              <input type="hidden" name="status" value="acted" />
              <button type="submit" className="btn btn-sm">Done it</button>
            </form>
            <form action={mark}>
              <input type="hidden" name="id" value={entry.id} />
              <input type="hidden" name="status" value="dismissed" />
              <button type="submit" className="btn btn-sm">Not doing this</button>
            </form>
          </>
        )}
        {entry && status !== "open" && (
          <form action={mark} className="flex items-center gap-2">
            <input type="hidden" name="id" value={entry.id} />
            <input type="hidden" name="status" value="open" />
            <span className={`badge ${status === "acted" ? "badge-ok" : "badge-muted"}`}>{status === "acted" ? "done" : "not doing this"}</span>
            <button type="submit" className="text-xs text-ink-3 underline hover:text-accent">reopen</button>
          </form>
        )}
        <span className={`badge ${tone}`}>{r.confidence}</span>
        {age !== undefined && (
          <span className="text-[11px] text-ink-3">
            {age <= 1 ? "new today" : `on the list ${age} days`}{entry ? `, since ${entry.firstSeenOn}` : ""}
          </span>
        )}
        {r.overlapsWith && r.overlapsWith.length > 0 && (
          <span className="text-[11px] text-ink-3">counted once with the row above it that shares a cause</span>
        )}
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-ink-3 hover:text-accent">Where the figure comes from</summary>
        <p className="mt-1 text-xs text-ink-2">{r.basis}</p>
      </details>
    </section>
  );
}

/**
 * What the advice has been worth.
 *
 * Promised is what the rows said when they were shown; realised is what the claims showed
 * afterwards, where the site could measure it (only a switch of NDC is scored so far). A kind of
 * advice that is shown often and acted on never is either wrong or badly put, and this is where
 * that shows.
 */
function Scorecard({ card }: { card: NonNullable<Awaited<ReturnType<typeof recommendationScorecard>>> }) {
  return (
    <Card
      className="mt-6"
      title="How the advice has done"
      subtitle="Every row is remembered from the day it first appears. Promised is what it said; realised is what the claims showed afterwards, where that can be measured."
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <Figure value={card.open} label="open" tone="muted" />
        <Figure value={card.acted} label="done" tone="ok" />
        <Figure value={card.dismissed} label="not doing" tone="muted" />
        <Figure value={card.resolved} label="went away on their own" sub="The facts moved before anyone acted" tone="muted" />
      </div>
      {card.byKey.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="table text-sm">
            <thead>
              <tr>
                <th>Kind of advice</th>
                <th className="num">Shown</th>
                <th className="num">Done</th>
                <th className="num">Not doing</th>
                <th className="num">Realised</th>
              </tr>
            </thead>
            <tbody>
              {card.byKey.map((k) => (
                <tr key={k.key}>
                  <td className="font-mono text-xs">{k.key}</td>
                  <td className="num">{k.shown}</td>
                  <td className="num">{k.acted}</td>
                  <td className="num">{k.dismissed}</td>
                  <td className="num">{k.realisedCents === 0 ? "—" : formatCents(k.realisedCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-ink-3">
        Promised {formatCents(card.promisedCents)} across every row ever shown; realised {formatCents(card.realisedCents)} where measured.
      </p>
    </Card>
  );
}
