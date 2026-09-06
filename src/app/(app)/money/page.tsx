import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { formatCents } from "@/lib/money";
import { moneyFound, type MoneyRow } from "@/lib/money-found";
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
 */
export default async function MoneyPage() {
  await requireUser();
  const { rows, firstYearCents, recurringMonthlyCents, oneOffCents, blocked } = await moneyFound();

  return (
    <>
      <PageHeader
        title="Where the money is"
        subtitle="Everything this site can currently see that is worth acting on, in what it is worth, with what to do about each. Nothing here is estimated — every figure is arithmetic on a document the pharmacy holds."
      />

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
            {rows.map((r, i) => <Row key={r.key} r={r} n={i + 1} />)}
          </div>
        </>
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

      <p className="mt-4 text-xs text-ink-3">
        Two problems with the same cause are not added together — a drug bought dearly and dispensed at a loss is one
        problem with two symptoms, and the total counts it once. A recurring saving is shown as a monthly figure and
        only multiplied out in the first-year total, so nothing here is a year&rsquo;s money dressed up as this
        month&rsquo;s.
      </p>
    </>
  );
}

function Row({ r, n }: { r: MoneyRow; n: number }) {
  const yearly = r.cadence === "recurring_monthly" ? r.amountCents * 12 : r.amountCents;
  const tone = r.confidence === "certain" ? "badge-ok" : r.confidence === "likely" ? "badge-muted" : "badge-warn";
  return (
    <section className="card">
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
        <span className={`badge ${tone}`}>{r.confidence}</span>
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
