import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { periodAccount, monthlyTrend, accountMonths } from "@/lib/profit-and-loss";
import { parsePeriod, periodsFor, previousPeriod, changeFrom } from "@/lib/period-account";
import { formatCents } from "@/lib/money";
import { todayIso } from "@/lib/dates";
import { PageHeader, Notice, Empty, Card } from "@/components/ui";
import { BarChart, LineChart, Movement, type Series } from "@/components/charts";
import { PrintButton } from "@/components/print-button";
import { ExportData } from "@/components/export-data";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports" };

/**
 * The business over time, rather than one month at a time.
 *
 * The monthly account answers "did September work". This answers the questions that only have
 * answers across months: is the script count going anywhere, is the margin holding, is a good month
 * a trend or a fortnight, and what does a quarter or a year actually come to.
 *
 * ── What is on it, and why these ──
 *
 * Scripts, because everything else here divides by it and a pharmacy that is quietly losing volume
 * can hold its revenue for two months on mix alone before anybody notices. Net revenue and gross
 * profit as amounts, because they are what the business took and kept. Gross margin as a rate on
 * its own axis, because a two-point move is the difference between a business and a hobby and a
 * nought-based bar chart flattens it into a straight line. And gross profit per script, which is
 * the one figure that says whether the work is worth doing — a month can grow its revenue, hold
 * its margin and still be earning less for the same labour.
 *
 * Net profit is here but is deliberately not the headline. It moves on when the rent was paid and
 * whether payroll has been entered yet, so month to month it is the noisiest line on the page; the
 * quarter and the year are where it means something.
 *
 * Every figure is added up from months the monthly account has already computed, never recomputed
 * a second way — so a quarter cannot disagree with the three months printed inside it, which is
 * how a spreadsheet goes wrong.
 */
export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; basis?: string; months?: string }>;
}) {
  await requireUser();
  const { period: periodParam, basis: basisParam, months: monthsParam } = await searchParams;
  const basis = basisParam === "cash" ? "cash" : "accrual";

  const recorded = await accountMonths();
  const choices = periodsFor(recorded);
  const fallback = choices.quarters[0] ?? choices.months[0] ?? todayIso().slice(0, 7);
  const key = periodParam && parsePeriod(periodParam) ? periodParam : fallback;
  const span = Math.min(24, Math.max(3, Number(monthsParam) || 12));

  const [totals, series] = await Promise.all([periodAccount(key, basis), monthlyTrend(span, basis)]);
  const prevKey = totals ? previousPeriod(totals.period)?.key : null;
  const prev = prevKey ? await periodAccount(prevKey, basis) : null;

  if (recorded.length === 0 || !totals) {
    return (
      <>
        <PageHeader title="Reports" subtitle="Quarters, years and how the months are moving." />
        <Empty>
          Nothing has been recorded yet. A month appears here as soon as it has claims, sales or bills against it.
        </Empty>
      </>
    );
  }

  const money = (c: number) => formatCents(c);
  /* A comparison only where the earlier period had something in it; a change against nothing is not
     a change, and showing it as a percentage would be inventing a trend out of a first month. */
  const against = (now: number, before: number | undefined) => {
    if (before === undefined || (before === 0 && now === 0)) return null;
    const c = changeFrom(now, before);
    const dir = c.deltaCents >= 0 ? "+" : "−";
    return {
      display: `${dir}${money(Math.abs(c.deltaCents))}${c.percent !== null ? ` (${c.percent > 0 ? "+" : ""}${c.percent}%)` : ""} on ${prevKey}`,
      percent: c.percent,
    };
  };

  const scripts: Series[] = series.map((p) => ({ label: p.label, value: p.scripts, display: p.scripts.toLocaleString(), usable: p.usable }));
  const revenue: Series[] = series.map((p) => ({ label: p.label, value: p.netRevenueCents, display: money(p.netRevenueCents), usable: p.usable }));
  const gross: Series[] = series.map((p) => ({ label: p.label, value: p.grossProfitCents, display: money(p.grossProfitCents), usable: p.usable }));
  const net: Series[] = series.map((p) => ({ label: p.label, value: p.netProfitCents, display: money(p.netProfitCents), usable: p.usable }));
  const margin: Series[] = series
    .filter((p) => p.grossMarginPercent !== null)
    .map((p) => ({ label: p.label, value: p.grossMarginPercent as number, display: `${p.grossMarginPercent}%`, usable: p.usable }));
  const perScript: Series[] = series
    .filter((p) => p.grossProfitPerScriptCents !== null)
    .map((p) => ({ label: p.label, value: p.grossProfitPerScriptCents as number, display: money(p.grossProfitPerScriptCents as number), usable: p.usable }));

  const link = (p: Record<string, string>) =>
    `/money/report?${new URLSearchParams({ period: key, basis, months: String(span), ...p }).toString()}`;

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Quarters, years, and how the months are moving. Every figure is the monthly account added up, never worked out a second way."
        actions={
          <>
            <Link href={`/money/report/print?period=${key}&basis=${basis}`} className="btn btn-sm">Printable sheet</Link>
            <Link href="/money/monthly" className="btn btn-sm">One month in full</Link>
            <PrintButton />
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-4 rounded-lg border border-line bg-surface p-3">
        <label className="text-xs font-medium text-ink-2">
          Period
          <select name="period" className="field mt-1" defaultValue={key} disabled>
            <option value={key}>{totals.period.label}</option>
          </select>
        </label>
        <div className="flex flex-wrap gap-1">
          {choices.quarters.slice(0, 4).map((q) => (
            <Link key={q} href={link({ period: q })} className={`btn btn-sm ${q === key ? "btn-primary" : ""}`}>{q}</Link>
          ))}
          {choices.years.slice(0, 2).map((y) => (
            <Link key={y} href={link({ period: y })} className={`btn btn-sm ${y === key ? "btn-primary" : ""}`}>{y}</Link>
          ))}
          {choices.months.slice(0, 3).map((m) => (
            <Link key={m} href={link({ period: m })} className={`btn btn-sm ${m === key ? "btn-primary" : ""}`}>{m}</Link>
          ))}
        </div>
        <div className="ml-auto flex gap-1">
          <Link href={link({ basis: "accrual" })} className={`btn btn-sm ${basis === "accrual" ? "btn-primary" : ""}`}>Accrual</Link>
          <Link href={link({ basis: "cash" })} className={`btn btn-sm ${basis === "cash" ? "btn-primary" : ""}`}>Cash</Link>
        </div>
      </div>

      {totals.emptyMonths.length > 0 && (
        <Notice kind="warn">
          <b>
            {totals.emptyMonths.length} of the {totals.period.months.length} months in {totals.period.label} have nothing
            recorded at all
          </b>{" "}
          ({totals.emptyMonths.join(", ")}). The totals below are of the months that do, and are not the whole period.
        </Notice>
      )}
      {totals.unusableMonths.length > 0 && (
        <Notice kind="warn">
          <b>{totals.unusableMonths.join(", ")} {totals.unusableMonths.length === 1 ? "is" : "are"} short of something material.</b>{" "}
          {totals.missing.slice(0, 3).join(" ")} Those months are still counted — leaving them out would understate the
          period just as badly — but the bottom line below is not a finished figure.
        </Notice>
      )}

      <Card className="mb-4" title={totals.period.label} subtitle={`${basis === "cash" ? "What reached the bank" : "What the period earned"}, across ${totals.months.length} month${totals.months.length === 1 ? "" : "s"}`}>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Movement label="scripts" value={totals.scripts.toLocaleString()} change={against(totals.scripts, prev?.scripts)} />
          <Movement label="net revenue" value={money(totals.netRevenueCents)} change={against(totals.netRevenueCents, prev?.netRevenueCents)} />
          <Movement label="cost of goods" value={money(totals.costOfGoodsCents)} change={against(totals.costOfGoodsCents, prev?.costOfGoodsCents)} invert />
          <Movement
            label="gross profit"
            value={money(totals.grossProfitCents)}
            change={against(totals.grossProfitCents, prev?.grossProfitCents)}
            sub={totals.grossMarginPercent !== null ? `${totals.grossMarginPercent}% of revenue` : undefined}
          />
          <Movement label="overheads" value={money(totals.operatingCents)} change={against(totals.operatingCents, prev?.operatingCents)} invert />
          <Movement
            label="net profit"
            value={money(totals.netProfitCents)}
            change={against(totals.netProfitCents, prev?.netProfitCents)}
            sub={totals.netMarginPercent !== null ? `${totals.netMarginPercent}% of revenue` : undefined}
          />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Movement
            label="net revenue a script"
            value={totals.revenuePerScriptCents !== null ? money(totals.revenuePerScriptCents) : "—"}
            change={totals.revenuePerScriptCents !== null ? against(totals.revenuePerScriptCents, prev?.revenuePerScriptCents ?? undefined) : null}
            sub="The period's revenue over the period's scripts — not the average of the months'"
          />
          <Movement
            label="gross profit a script"
            value={totals.grossProfitPerScriptCents !== null ? money(totals.grossProfitPerScriptCents) : "—"}
            change={totals.grossProfitPerScriptCents !== null ? against(totals.grossProfitPerScriptCents, prev?.grossProfitPerScriptCents ?? undefined) : null}
            sub="Whether the work is worth doing, in one figure"
          />
        </div>
      </Card>

      <Card className="mb-4" title={`The last ${series.length} month${series.length === 1 ? "" : "s"}`} subtitle="Hollow bars are months known to be short of something, so a dip is not read as a fall." actions={
        <div className="flex gap-1">
          {[6, 12, 24].map((n) => (
            <Link key={n} href={link({ months: String(n) })} className={`btn btn-sm ${span === n ? "btn-primary" : ""}`}>{n}</Link>
          ))}
        </div>
      }>
        <div className="grid gap-6 lg:grid-cols-2">
          <BarChart title="Scripts" series={scripts} />
          <BarChart title="Net revenue" series={revenue} />
          <BarChart title="Gross profit" series={gross} />
          <LineChart title="Gross margin" series={margin} />
          <BarChart title="Gross profit a script" series={perScript} />
          <BarChart title="Net profit" series={net} tone="warn" />
        </div>
      </Card>

      <Card className="mb-4" title="Month by month" subtitle="The same figures as numbers, for anyone who would rather read them.">
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Month</th>
                <th className="text-right">Scripts</th>
                <th className="text-right">Net revenue</th>
                <th className="text-right">Cost of goods</th>
                <th className="text-right">Gross profit</th>
                <th className="text-right">Margin</th>
                <th className="text-right">Per script</th>
                <th className="text-right">Net profit</th>
              </tr>
            </thead>
            <tbody>
              {totals.months.map((m) => (
                <tr key={m.month}>
                  <td>
                    <Link href={`/money/monthly?month=${m.month}&basis=${basis}`} className="text-accent hover:underline">{m.month}</Link>
                    {!m.usable && <span className="badge badge-warn ml-2">incomplete</span>}
                  </td>
                  <td className="text-right tabular-nums">{m.claimsCount.toLocaleString()}</td>
                  <td className="text-right tabular-nums">{money(m.netRevenueCents)}</td>
                  <td className="text-right tabular-nums">{money(m.costOfGoodsCents)}</td>
                  <td className="text-right tabular-nums">{money(m.grossProfitCents)}</td>
                  <td className="text-right tabular-nums">{m.grossMarginPercent !== null ? `${m.grossMarginPercent}%` : "—"}</td>
                  <td className="text-right tabular-nums">
                    {m.claimsCount > 0 ? money(Math.round(m.grossProfitCents / m.claimsCount)) : "—"}
                  </td>
                  <td className="text-right tabular-nums">{money(m.netProfitCents)}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td>{totals.period.key}</td>
                <td className="text-right tabular-nums">{totals.scripts.toLocaleString()}</td>
                <td className="text-right tabular-nums">{money(totals.netRevenueCents)}</td>
                <td className="text-right tabular-nums">{money(totals.costOfGoodsCents)}</td>
                <td className="text-right tabular-nums">{money(totals.grossProfitCents)}</td>
                <td className="text-right tabular-nums">{totals.grossMarginPercent !== null ? `${totals.grossMarginPercent}%` : "—"}</td>
                <td className="text-right tabular-nums">
                  {totals.grossProfitPerScriptCents !== null ? money(totals.grossProfitPerScriptCents) : "—"}
                </td>
                <td className="text-right tabular-nums">{money(totals.netProfitCents)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <ExportData page="report" />
    </>
  );
}
