import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { bankReview, monthsWithStatements, recentPayerNames } from "@/lib/bank-review-store";
import { categories, vendors } from "@/lib/expenses";
import { allStandingCosts } from "@/lib/standing-costs";
import { BankLineDecider } from "@/components/bank-line-decider";
import { nameBankLine } from "./actions";
import { formatCents } from "@/lib/money";
import { fmt, todayIso } from "@/lib/dates";
import { familyTabs } from "@/lib/families";
import { readBankStatement } from "../bank";
import { SubmitButton } from "@/components/submit-button";
import { PageHeader, Card, Notice, Field } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "The bank statement" };

/**
 * A month's statement, line by line, so every line can be accounted for.
 *
 * The owner: "I need ability in site to go through bank statements and make sure everything is
 * accounted for and categorized!! Everything should line up perfectly between accural accounting,
 * cash accounting, remits, invoices!!"
 *
 * The site already had the count — how many lines it placed, and a list of the ones it could not.
 * That answers "is there a problem" and not the question somebody sits down to answer, which is "is
 * every line right". So this is the whole statement, in the bank's own order, with what each line
 * was tied to and why, and the lines needing him at the top rather than filtered out of a total.
 *
 * ── Why three states and not "matched / unmatched" ──
 *
 * Most of a healthy statement is CONFIRMED rather than booked: the money was already on the books
 * from its own feed — a card batch, an 835, a postage confirmation — and the bank line proves it
 * arrived. Nothing is booked from those, deliberately, because booking them would count the money
 * twice. Collapsing that into "matched" hid the difference between money the site understood and
 * money it had merely seen, and it is the difference that says whether the feeds are working.
 */
export default async function BankReviewPage({ searchParams }: { searchParams: Promise<{ month?: string; ok?: string; error?: string; q?: string }> }) {
  await requireUser();
  const { month: asked, ok, error, q: askedQ } = await searchParams;
  const months = await monthsWithStatements();
  const month = asked && /^\d{4}-\d{2}$/.test(asked) ? asked : (months[0] ?? todayIso().slice(0, 7));
  const r = await bankReview(month);
  /*
   * The tool on the row. The owner, 2 October 2026: "easy way to reconcile bank statements (tell site things it cant
   * match)". This page said a cheque was "yours to categorise" and offered nothing here to do it with. The lists are
   * the site's own: categories, payees, payers that have paid before, the standing costs.
   */
  const [cats, vends, standing, payers] = await Promise.all([categories(), vendors(), allStandingCosts(), recentPayerNames()]);
  const categoryNames = cats.map((c) => c.name).sort((a, b) => a.localeCompare(b));
  const vendorNames = vends.map((v) => v.name).sort((a, b) => a.localeCompare(b));
  const standingNames = standing.map((s) => s.name);
  const q = (askedQ ?? "").trim().toLowerCase();
  /* One sentence at rest; the rest behind a press. */
  const firstSentence = (s: string) => s.replace(/\s+/g, " ").split(/(?<=\.)\s/)[0];

  const TONE: Record<string, string> = { needs_you: "badge-crit", confirmed: "badge-ok", booked: "badge-muted" };
  const LABEL: Record<string, string> = { needs_you: "needs you", confirmed: "confirmed", booked: "booked here" };

  /* Worst first: a page somebody works through puts the work at the top. */
  const order = { needs_you: 0, booked: 1, confirmed: 2 } as const;
  const lines = [...r.lines].sort((a, b) => order[a.state] - order[b.state] || a.on.localeCompare(b.on));
  const shown = q ? lines.filter((l) => l.description.toLowerCase().includes(q) || (l.why ?? "").toLowerCase().includes(q) || formatCents(l.amountCents).replace(/[,$]/g, "").includes(q.replace(/[,$]/g, ""))) : lines;

  return (
    <>
      <PageHeader
        title="The bank statement"
        subtitle="Every line, what it was tied to, and what still needs you. The bank is the only figure here that does not come from us."
        tabs={familyTabs("money", "/money/bank-review")}
        actions={
          <>
            <Link href="/money" className="btn">The books</Link>
            <Link href="/expenses" className="btn">Spending</Link>
          </>
        }
      />

      {months.length > 1 && (
        <div className="my-4 flex flex-wrap gap-1.5">
          {months.map((m) => (
            <Link key={m} href={`/money/bank-review?month=${m}`} className={`nav-item ${m === month ? "on" : ""}`}>
              {m}
            </Link>
          ))}
        </div>
      )}

      {/*
        The way in, on the page that exists to use it.

        The upload has always lived at the foot of the books page, under a heading about banking
        deposits. Nothing on this site has ever read a bank statement — bank_lines is empty — and a
        control nobody finds is the likeliest reason. It is the same server action; only the place
        it is offered has changed.
      */}
      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <details className="my-4">
        <summary className="cursor-pointer text-sm font-medium text-ink-2">Read a statement</summary>
      <form action={readBankStatement} encType="multipart/form-data" className="mt-2 flex flex-wrap items-end gap-3 rounded-xl bg-surface p-5" style={{ boxShadow: "var(--shadow-rest)" }}>
        <input type="hidden" name="period" value={month} />
        <Field
          label="Read a statement"
          hint="Emprise's monthly statement as the PDF it comes in. The lines are proved against the bank's own running balances, so a figure the scan read two ways is settled by arithmetic rather than guessed."
        >
          <input type="file" name="file" accept=".pdf,.csv,.txt" required className="w-full" />
        </Field>
        <SubmitButton className="btn btn-primary" pendingLabel="Reading the statement…">Read it</SubmitButton>
      </form>
      </details>

      {r.lines.length === 0 ? (
        <Notice kind="warn">{r.says}</Notice>
      ) : (
        <>
          <Notice kind={r.counts.needsYou > 0 ? "warn" : "ok"}>{r.says}</Notice>

          <div className="my-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card title="In">
              <p className="text-2xl font-bold tabular-nums">{formatCents(r.inCents)}</p>
            </Card>
            <Card title="Out">
              <p className="text-2xl font-bold tabular-nums">{formatCents(r.outCents)}</p>
            </Card>
            <Card title="Confirmed by a feed">
              <p className="text-2xl font-bold tabular-nums">{r.counts.confirmed}</p>
              <p className="mt-1 text-xs text-ink-3">Already on the books; the bank agrees.</p>
            </Card>
            <Card tone={r.counts.needsYou > 0 ? "crit" : undefined} title="Needs you">
              <p className="text-2xl font-bold tabular-nums">{r.counts.needsYou}</p>
              <p className="mt-1 text-xs text-ink-3">
                {r.counts.needsYou === 0
                  ? "Nothing outstanding."
                  : `${formatCents(r.unaccountedOutCents)} out, ${formatCents(r.unaccountedInCents)} in.`}
              </p>
            </Card>
          </div>

          <Card
            title={`Every line in ${month}`}
            count={shown.length}
            actions={
              <form method="get" className="flex items-center gap-2">
                <input type="hidden" name="month" value={month} />
                <input name="q" defaultValue={askedQ ?? ""} placeholder="find a line by words or amount" aria-label="Find a line" className="field h-9 w-64 rounded-full text-sm" />
              </form>
            }
          >
            <div className="overflow-x-auto">
              <table className="table min-w-[860px]">
                <thead>
                  <tr>
                    <th className="w-[92px]">Date</th>
                    <th className="w-[100px]">State</th>
                    <th>What the bank said, and what it was tied to</th>
                    <th className="num w-[120px]">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((l) => (
                    <tr key={l.id} id={`line-${l.id}`}>
                      <td className="whitespace-nowrap text-xs">{fmt(l.on)}</td>
                      <td>
                        <span className={`badge ${TONE[l.state]}`}>{LABEL[l.state]}</span>
                      </td>
                      <td>
                        <span className="block text-sm">{l.description}</span>
                        {l.why &&
                          (firstSentence(l.why).length < l.why.replace(/\s+/g, " ").length ? (
                            <details className="mt-0.5 text-xs text-ink-2">
                              <summary className="cursor-pointer list-none">
                                {firstSentence(l.why)} <span className="text-ink-3">more</span>
                              </summary>
                              <span className="block pt-1">{l.why}</span>
                            </details>
                          ) : (
                            <span className="mt-0.5 block text-xs text-ink-2">{l.why}</span>
                          ))}
                        {l.state === "needs_you" && (
                          <BankLineDecider lineId={l.id} month={month} amountCents={l.amountCents} categories={categoryNames} vendors={vendorNames} payers={payers} standing={standingNames} action={nameBankLine} />
                        )}
                      </td>
                      <td className={`num whitespace-nowrap text-sm ${l.amountCents < 0 ? "" : "text-accent"}`}>
                        {formatCents(l.amountCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {/*
        Said on the page rather than only in a commit: the reconciliation is only as complete as the
        documents behind it, and a person deciding whether to trust this needs to know which are
        missing without going to ask.
      */}
      <Card title="What a line still cannot be tied to, and why" className="mt-6">
        <ul className="rows text-sm">
          <li className="py-2">
            <b>A cheque</b> — the bank prints a number and an amount and nothing else. Nothing in the site can
            name it, and it is the one line that will always need a person the first time.
          </li>
          <li className="py-2">
            <b>The card processor&rsquo;s monthly fee</b> — needs their statement. Booking it from the bank line would
            count the fees twice when the statement arrives, so the site refuses to.
          </li>
          <li className="py-2">
            <b>A wholesaler&rsquo;s draw whose period is not fully on file</b> — the site now learns each supplier&rsquo;s
            cadence from draws it has already settled, and says which days a draw is for. Where the invoices for
            those days are short, it names the shortfall rather than hunting for a set that fits.
          </li>
        </ul>
      </Card>
    </>
  );
}
