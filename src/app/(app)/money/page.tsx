import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { formatCents } from "@/lib/money";
import { todayIso } from "@/lib/dates";
import { parsePeriod, periodOf, neighbours, type PeriodKind } from "@/lib/ledger";
import { booksFor, recentMonths } from "@/lib/ledger-store";
import { moneyFound } from "@/lib/money-found";
import { PageHeader, Card, Notice } from "@/components/ui";
import { Bars } from "@/components/bars";
import { Stat, deltaOf } from "@/components/kit";

export const dynamic = "force-dynamic";
export const metadata = { title: "Money" };

/**
 * The books.
 *
 * One screen that says what the period took, what the goods cost, what the doors cost, and what
 * is left — on both bases, with the gap between them named for what it is — and puts a link on
 * every figure to the rows it was added from. It refuses to print a confident bottom line over a
 * hole: what is missing is said first, and the total is marked for what it is.
 *
 * The specification is docs/reference/money-ledger.md.
 */
export default async function MoneyPage({ searchParams }: { searchParams: Promise<{ period?: string; ok?: string; error?: string }> }) {
  await requireUser();
  const { period: periodParam, ok, error } = await searchParams;
  const today = todayIso();
  const period = (periodParam && parsePeriod(periodParam)) || periodOf("month", today.slice(0, 7));
  const [books, recent, found] = await Promise.all([booksFor(period, today), recentMonths(6, today), moneyFound().catch(() => null)]);
  const { accrual, cash, scripts, gap, pace, sources } = books;
  const { before, after } = neighbours(period);
  const isCurrent = period.kind === "month" && period.key === today.slice(0, 7);
  const link = (kind: PeriodKind) => `/money?period=${periodOf(kind, period.months[period.months.length - 1]).key}`;

  const tone = (c: number) => (c < 0 ? "crit" : "ok");
  const pct = (c: number) => (accrual.netRevenueCents > 0 ? `${Math.round((c / accrual.netRevenueCents) * 1000) / 10}% of net revenue` : undefined);
  /*
   * The change against the period before, and the six-month line under each figure.
   *
   * For a month the comparison is the month before; for a quarter or a year the figures are the
   * period's and the line is still the months, because the months are what moved.
   */
  const previous = period.kind === "month" ? recent[recent.findIndex((r) => r.month === period.key) - 1] ?? null : null;
  const hist = (pick: (r: (typeof recent)[number]) => number | null) => recent.map((r) => (r.pl.revenue.length ? pick(r) : null));
  const d = (now: number, before: number | null | undefined) => deltaOf(now, before, formatCents);

  return (
    <>
      <PageHeader
        title="Money"
        subtitle="The books: what the period earned and what reached the bank, both kept, neither mixed."
        help={
          <>
            <p><b>Cost of goods comes from what was dispensed, not what was bought.</b> PioneerRx prints the acquisition cost of every fill, so the cost of what actually sold is known per bottle and no stocktake is needed. Purchases less dispensed cost is stock moving on or off the shelf, reported as cash, never as profit.</p>
            <p><b>Rebates reduce cost; they are never revenue.</b> Earned against the month that earned them on the accrual basis, received against the month they were banked on the cash basis.</p>
            <p><b>DIR fees come out of revenue, not overheads,</b> so the dispensing margin is not flattered.</p>
            <p><b>Cash and accrual are both true.</b> A prescription dispensed on the 30th is this month&rsquo;s earnings and next month&rsquo;s money. The gap is the receivable, and it is named rather than hidden.</p>
            <p><b>Every figure links to its rows.</b> A wrong figure is corrected on the linked page, never here. The specification is <code>docs/reference/money-ledger.md</code>.</p>
          </>
        }
        actions={
          <>
            <Link href={`/money/monthly?period=${period.key}`} className="btn btn-primary">Statement</Link>
            <Link href="/expenses" className="btn">Spending</Link>
            <Link href="/money/found" className="btn">Money found</Link>
          </>
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {/* The period, chosen and stated. Arrows step it; the three words change its size. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Link href={`/money?period=${before.key}`} className="btn btn-sm" aria-label="Earlier">←</Link>
        <span className="font-semibold">{period.label}</span>
        <Link href={`/money?period=${after.key}`} className="btn btn-sm" aria-label="Later">→</Link>
        <span className="ml-2 inline-flex overflow-hidden rounded-md border border-line text-xs">
          {(["month", "quarter", "year"] as PeriodKind[]).map((k) => (
            <Link key={k} href={link(k)} className={`px-2.5 py-1 ${period.kind === k ? "bg-accent-soft font-semibold text-accent" : "text-ink-2 hover:bg-ground"}`}>
              {k}
            </Link>
          ))}
        </span>
        {isCurrent && pace && <span className="text-xs text-ink-3">{pace.says}</span>}
      </div>

      {!accrual.usable && (
        <Notice kind="crit">
          <b>Not yet a complete account of {period.label}.</b> Until these are in, the bottom line is wrong in the flattering direction:
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {accrual.missing.slice(0, 6).map((m, i) => <li key={i}>{m}</li>)}
            {accrual.missing.length > 6 && <li>and {accrual.missing.length - 6} more on the statement.</li>}
          </ul>
          <span className="mt-1 block">
            Record them on <Link href="/expenses" className="underline">Spending</Link>.
          </span>
        </Notice>
      )}

      {/* The five figures the period comes down to, on the accrual basis, each a link to its rows. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat size="sm" value={formatCents(accrual.netRevenueCents)} label="Net revenue" sub={pace?.netRevenueCents ? `${formatCents(pace.netRevenueCents)} at this pace` : "after DIR and chargebacks"} tone="muted" href={sources.revenue} delta={d(accrual.netRevenueCents, previous?.pl.netRevenueCents)} history={hist((r) => r.pl.netRevenueCents)} />
        <Stat size="sm" value={formatCents(accrual.grossProfitCents)} label="Gross profit" sub={accrual.grossMarginPercent !== null ? `${accrual.grossMarginPercent}% of net revenue` : "cost of goods not known"} tone={tone(accrual.grossProfitCents)} href={sources.costOfGoods} delta={d(accrual.grossProfitCents, previous?.pl.grossProfitCents)} history={hist((r) => r.pl.grossProfitCents)} />
        <Stat size="sm" value={formatCents(accrual.operatingCents)} label="Keeping the doors open" sub={pct(accrual.operatingCents) ?? "operating costs entered"} tone="muted" href={sources.expenses} delta={d(accrual.operatingCents, previous?.pl.operatingCents)} upIsGood={false} history={hist((r) => r.pl.operatingCents)} />
        <Stat size="sm" value={formatCents(accrual.netProfitCents)} label={accrual.netProfitCents < 0 ? "Net loss" : "Net profit"} sub={accrual.usable ? "every line in" : "lines missing, see above"} tone={accrual.usable ? tone(accrual.netProfitCents) : "warn"} href={`/money/monthly?period=${period.key}`} delta={d(accrual.netProfitCents, previous?.pl.netProfitCents)} history={hist((r) => r.pl.netProfitCents)} />
        <Stat size="sm" value={scripts.scripts.toLocaleString()} label="Scripts" sub={scripts.perDay !== null ? `${scripts.perDay} a day · ${scripts.cash} cash` : "none in the period"} tone="muted" href={sources.scripts} delta={previous ? deltaOf(scripts.scripts, previous.scripts, (n) => String(n)) : null} history={recent.map((r) => (r.pl.revenue.length ? r.scripts : null))} />
      </div>

      {/* Both bases, side by side, and the gap said for what it is. */}
      <Card className="mt-4" title="Earned against banked" subtitle="Accrual is what the period earned; cash is what reached the bank and left it. The difference is money owed, not money missing.">
        <div className="overflow-x-auto">
          <table className="table text-sm">
            <thead>
              <tr>
                <th></th>
                <th className="num">Accrual</th>
                <th className="num">Cash</th>
                <th className="num">Gap</th>
              </tr>
            </thead>
            <tbody>
              <Line label="Revenue" a={accrual.revenueCents} c={cash.revenueCents} href={sources.revenue} note={cash.revenue.length === 0 ? "no receipts entered for the period" : undefined} />
              <Line label="Net revenue" a={accrual.netRevenueCents} c={cash.netRevenueCents} />
              <Line label="Cost of goods" a={accrual.costOfGoodsCents} c={cash.costOfGoodsCents} href={sources.purchases} note={cash.costOfGoods.length === 0 ? "no invoice marked paid in the period" : undefined} />
              <Line label="Gross profit" a={accrual.grossProfitCents} c={cash.grossProfitCents} strong />
              <Line label="Operating" a={accrual.operatingCents} c={cash.operatingCents} href={sources.expenses} />
              <Line label="Net" a={accrual.netProfitCents} c={cash.netProfitCents} strong />
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-ink-2">{gap.says}</p>
        {accrual.stockMovementCents !== null && accrual.stockMovementCents !== 0 && (
          <p className="mt-1 text-xs text-ink-3">
            {formatCents(Math.abs(accrual.stockMovementCents))} {accrual.stockMovementCents > 0 ? "went onto the shelf" : "came off the shelf"} in the period: bought less dispensed. Not profit; where the cash went.
          </p>
        )}
      </Card>

      {/* The trend, because the trend is the point here. Each bar opens its month. */}
      <Card className="mt-4" title="The last six months" subtitle="Net revenue and gross profit on the accrual basis, with scripts. A bar with nothing on it is a month with no account.">
        <Bars
          labels={recent.map((r) => r.month.slice(5) + "/" + r.month.slice(2, 4))}
          series={[
            { label: "Net revenue", values: recent.map((r) => (r.pl.revenue.length ? r.pl.netRevenueCents : null)) },
            { label: "Gross profit", values: recent.map((r) => (r.pl.revenue.length ? r.pl.grossProfitCents : null)), tone: "ink" },
          ]}
          hrefs={recent.map((r) => `/money?period=${r.month}`)}
        />
        <div className="mt-2 overflow-x-auto">
          <table className="table text-xs">
            <thead>
              <tr>
                <th>Month</th>
                {recent.map((r) => <th key={r.month} className="num">{r.month}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr><td>Scripts</td>{recent.map((r) => <td key={r.month} className="num">{r.scripts.toLocaleString()}</td>)}</tr>
              <tr><td>Gross margin</td>{recent.map((r) => <td key={r.month} className="num">{r.pl.grossMarginPercent !== null ? `${r.pl.grossMarginPercent}%` : "—"}</td>)}</tr>
              <tr><td>Net</td>{recent.map((r) => <td key={r.month} className={`num ${r.pl.netProfitCents < 0 ? "text-crit" : ""}`}>{r.pl.revenue.length ? formatCents(r.pl.netProfitCents) : "—"}</td>)}</tr>
              <tr><td>Complete</td>{recent.map((r) => <td key={r.month} className="num">{r.pl.usable ? "yes" : `${r.pl.missing.length} missing`}</td>)}</tr>
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {/* What the period's cost of goods was checked against. A finding is a finding on the statement. */}
        <Card title="Does it tie out?" subtitle="Each month's figures against their independent record.">
          <ul className="rows">
            {accrual.months.map((m) => {
              const checks = [...m.reconciliation.cogs.checks, ...m.reconciliation.revenue];
              const findings = checks.filter((c) => !c.expected && c.agrees === false).length;
              const ties = checks.filter((c) => c.agrees === true).length;
              return (
                <li key={m.month} className="row">
                  <div className="min-w-0">
                    <div className="row-title">
                      <Link href={`/money/monthly?period=${m.month}`} className="text-accent underline">{m.month}</Link>
                      {findings > 0 ? <span className="badge badge-warn ml-2">{findings} to look at</span> : ties > 0 ? <span className="badge badge-ok ml-2">ties</span> : <span className="badge badge-muted ml-2">not enough held</span>}
                    </div>
                    <p className="row-why">{checks.map((c) => c.what).join(" · ")}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        {/* The three lines worth the most from the money list, so the books lead to the action. */}
        <Card title="Worth the most right now" subtitle="From the money list: amounts this site can see and what to do about each." actions={<Link href="/money/found" className="btn btn-sm">All of it</Link>}>
          {found && found.rows.length > 0 ? (
            <ol className="rows">
              {found.rows.slice(0, 3).map((r) => (
                <li key={r.key} className="row">
                  <div className="min-w-0">
                    <div className="row-title">{r.says}</div>
                    <p className="row-why">{r.todo}</p>
                  </div>
                  <div className="whitespace-nowrap text-right text-sm">
                    <Link href={r.href} className="font-semibold tabular-nums text-accent">{formatCents(r.amountCents)}</Link>
                    <span className="block text-[11px] text-ink-3">{r.cadence === "recurring_monthly" ? "a month" : "one-off"}</span>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-ink-3">Nothing on the list yet. It fills in as invoices, catalogues and claims arrive.</p>
          )}
        </Card>
      </div>

      <p className="mt-4 text-xs text-ink-3">
        Every figure links to the rows it was added from; a wrong figure is corrected there, never here. The statement carries every
        line with its source, printable and as a file: <Link href={`/money/monthly?period=${period.key}`} className="text-accent underline">open it</Link>.
      </p>
    </>
  );
}

function Line({ label, a, c, href, note, strong }: { label: string; a: number; c: number; href?: string; note?: string; strong?: boolean }) {
  const gap = a - c;
  return (
    <tr className={strong ? "font-semibold" : ""}>
      <td>
        {href ? <Link href={href} className="text-accent underline">{label}</Link> : label}
        {note && <span className="block text-[11px] font-normal text-ink-3">{note}</span>}
      </td>
      <td className="num">{formatCents(a)}</td>
      <td className="num">{formatCents(c)}</td>
      <td className={`num ${gap < 0 ? "text-crit" : "text-ink-2"}`}>{formatCents(gap)}</td>
    </tr>
  );
}
