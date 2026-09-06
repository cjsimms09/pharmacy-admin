import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { accountMonths } from "@/lib/profit-and-loss";
import { parsePeriod, periodOf, neighbours, type PeriodKind } from "@/lib/ledger";
import { booksFor } from "@/lib/ledger-store";
import { PrintButton } from "@/components/print-button";
import { formatCents } from "@/lib/money";
import { todayIso } from "@/lib/dates";
import { PageHeader, Notice, Empty, Card } from "@/components/ui";
import { ExportData } from "@/components/export-data";

export const dynamic = "force-dynamic";
export const metadata = { title: "Statement" };

/**
 * A month, honestly.
 *
 * Every other money screen here answers what a prescription made. This one answers whether the
 * month did — which is a different question, because the dispensing margin pays wages, rent,
 * software, postage and a card processor before any of it is profit.
 *
 * Two things this screen refuses to do. It will not print a confident bottom line over a hole: a
 * month with no payroll in it does not look slightly optimistic, it looks profitable when it was
 * not, so what is missing is named and the total is marked for what it is. And it will not quietly
 * mix the two bases — a prescription dispensed on the 30th is September's earnings and October's
 * money, and both are true, so the basis is chosen and stated rather than assumed.
 */
export default async function MonthlyPLPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; period?: string; basis?: string }>;
}) {
  await requireUser();
  const { month: monthParam, period: periodParam, basis: basisParam } = await searchParams;
  const basis = basisParam === "cash" ? "cash" : "accrual";

  const months = await accountMonths();
  const fallback = months[0] ?? todayIso().slice(0, 7);
  const period = (periodParam && parsePeriod(periodParam)) || (monthParam && parsePeriod(monthParam)) || parsePeriod(fallback)!;
  const month = period.key;
  const books = await booksFor(period);
  const pl = basis === "cash" ? books.cash : books.accrual;
  const { before, after } = neighbours(period);
  const kindLink = (k: PeriodKind) => `/money/monthly?period=${periodOf(k, period.months[period.months.length - 1]).key}&basis=${basis}`;

  const pct = (c: number) => (pl.netRevenueCents > 0 ? `${Math.round((c / pl.netRevenueCents) * 1000) / 10}%` : "—");

  return (
    <>
      <PageHeader
        title={`Statement · ${period.label}`}
        subtitle="What the period took, what the goods cost, and what it cost to keep the doors open."
        back={{ href: `/money?period=${period.key}`, label: "The books" }}
        actions={
          <>
            <Link href={`/api/ledger?period=${period.key}&basis=${basis}`} prefetch={false} className="btn" download>Download CSV</Link>
            <PrintButton />
            <Link href="/expenses" className="btn">Spending</Link>
          </>
        }
      />

      <form method="get" className="my-4 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-3 no-print">
        <span className="inline-flex items-center gap-1 text-sm">
          <Link href={`/money/monthly?period=${before.key}&basis=${basis}`} className="btn btn-sm" aria-label="Earlier">←</Link>
          <span className="inline-flex overflow-hidden rounded-md border border-line text-xs">
            {(["month", "quarter", "year"] as PeriodKind[]).map((k) => (
              <Link key={k} href={kindLink(k)} className={`px-2.5 py-1 ${period.kind === k ? "bg-accent-soft font-semibold text-accent" : "text-ink-2 hover:bg-ground"}`}>{k}</Link>
            ))}
          </span>
          <Link href={`/money/monthly?period=${after.key}&basis=${basis}`} className="btn btn-sm" aria-label="Later">→</Link>
        </span>
        <label className="text-xs">
          <span className="block text-ink-3">Month</span>
          <select name="period" defaultValue={period.kind === "month" ? month : ""} className="mt-0.5 rounded-md border border-line px-2 py-1 text-sm">
            {period.kind !== "month" && <option value={period.key}>{period.label}</option>}
            {(months.length ? months : [month]).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="block text-ink-3">Basis</span>
          <select name="basis" defaultValue={basis} className="mt-0.5 rounded-md border border-line px-2 py-1 text-sm">
            <option value="accrual">Accrual — what the month earned</option>
            <option value="cash">Cash — what reached the bank</option>
          </select>
        </label>
        <button className="rounded-md bg-ink px-3 py-1.5 text-sm text-white">Show</button>
        <p className="ml-auto max-w-md text-xs text-ink-3">
          {basis === "accrual"
            ? "A prescription dispensed on the 30th is this month's, whatever month the plan pays in."
            : "Only money that actually arrived. A pharmacy is paid weeks in arrears, so this always lags what was earned — and the gap is the receivable."}
        </p>
      </form>

      {/*
        What is absent, before what is present. A silently missing line does not read as missing;
        it reads as a better month.
      */}
      {pl.missing.length > 0 && (
        <Notice kind="crit">
          <b>This is not a complete account of {period.label}.</b> Until these are in it, the bottom line is wrong in the
          flattering direction:
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {pl.missing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
          <span className="mt-1 block">
            Record them on <Link href="/expenses" className="underline">Spending</Link>.
          </span>
        </Notice>
      )}

      {pl.revenue.length === 0 && pl.costOfGoods.length === 0 && pl.operating.length === 0 ? (
        <Empty>Nothing has been loaded for {period.label} yet.</Empty>
      ) : (
        <div className="my-4 overflow-hidden rounded-lg border border-line bg-surface">
          <Group title="What the month took" lines={pl.revenue} total={pl.revenueCents} />
          {pl.offsets.length > 0 && (
            <Group title="Taken back out of it" lines={pl.offsets.map((l) => ({ ...l, amountCents: -l.amountCents }))} total={-pl.netRevenueCents + pl.revenueCents} negative />
          )}
          <Row label="Net revenue" value={pl.netRevenueCents} strong />

          <Group title="What the goods cost" lines={pl.costOfGoods} total={pl.costOfGoodsCents} />
          <Row
            label="Gross profit"
            value={pl.grossProfitCents}
            strong
            note={pl.grossMarginPercent !== null ? `${pl.grossMarginPercent}% of net revenue` : undefined}
          />

          <Group title="What it cost to keep the doors open" lines={pl.operating.map((l) => ({ ...l, note: pct(l.amountCents) }))} total={pl.operatingCents} />
          <Row label={pl.netProfitCents < 0 ? "Net loss" : "Net profit"} value={pl.netProfitCents} strong big tone={pl.netProfitCents < 0 ? "crit" : "ok"} />
        </div>
      )}

      {/*
        Bought less dispensed. Not profit, and never counted as it — it is where the cash went,
        which is the question a pharmacy with a good month and an empty bank account is asking.
      */}
      {pl.stockMovementCents !== null && pl.stockMovementCents !== 0 && (
        <Notice kind="ok">
          <b>
            {formatCents(Math.abs(pl.stockMovementCents))} {pl.stockMovementCents > 0 ? "went onto the shelf" : "came off the shelf"} this
            month.
          </b>{" "}
          The wholesalers billed that much {pl.stockMovementCents > 0 ? "more" : "less"} than the cost of what was
          actually dispensed. It is not profit and is not in the figures above — it is where the cash went, which is a
          different question and the one a good month with an empty bank account is asking.
        </Notice>
      )}

      {/*
        Every figure has a source, and the ones with two sources are checked against each other.

        This is the principle the claims screen already runs on, applied to the account. Cost of
        goods has a genuinely independent second source — opening stock plus purchases less closing
        stock uses nothing from the claims — so agreement is corroboration rather than the same sum
        restated. A check that cannot be inspected is one nobody believes the second time it
        disagrees, so the working is shown alongside the verdict.
      */}
      <Card
        className="my-4"
        title="Does it tie out?"
        subtitle="Where two records of the same month exist, they are compared. A difference that is expected is said to be expected; one that is not is a finding."
        tone={
          pl.months.some((m) => [...m.reconciliation.cogs.checks, ...m.reconciliation.revenue].some((c) => !c.expected && c.agrees === false))
            ? "warn"
            : undefined
        }
      >
        <ul className="rows">
          {pl.months.flatMap((m) => [...m.reconciliation.cogs.checks, ...m.reconciliation.revenue].map((c) => ({ ...c, month: m.month }))).map((c) => (
            <li key={`${c.month}|${c.what}`} className="row">
              <div className="min-w-0">
                <div className="row-title">
                  {pl.months.length > 1 && <span className="mr-2 font-mono text-xs text-ink-3">{c.month}</span>}
                  {c.what}
                  {c.agrees === true && <span className="badge badge-ok ml-2">ties</span>}
                  {c.agrees === false && !c.expected && <span className="badge badge-warn ml-2">look at this</span>}
                  {c.agrees === false && c.expected && <span className="badge badge-muted ml-2">expected</span>}
                  {c.agrees === null && <span className="badge badge-muted ml-2">not enough held</span>}
                </div>
                <p className="row-why">{c.says}</p>
              </div>
              <div className="whitespace-nowrap text-right text-sm tabular-nums">
                {c.differenceCents === null ? "—" : formatCents(c.differenceCents)}
              </div>
            </li>
          ))}
        </ul>
        {pl.months.length === 1 && pl.months[0].reconciliation.cogs.impliedCogsCents !== null && (
          <p className="mt-3 text-xs text-ink-3">
            The shelf&rsquo;s own answer for cost of goods this month is{" "}
            <b className="text-ink-2">{formatCents(pl.months[0].reconciliation.cogs.impliedCogsCents)}</b> — opening stock plus what
            the wholesalers billed, less closing stock. Not one figure in it comes from the claims, which is what makes
            it worth comparing.
          </p>
        )}
      </Card>

      <details className="my-4 rounded-lg border border-line bg-surface p-4">
        <summary className="cursor-pointer text-sm font-semibold">How each figure is arrived at</summary>
        <div className="mt-2 space-y-2 text-xs leading-relaxed text-ink-2">
          <p>
            <b>Cost of goods comes from what was dispensed, not what was bought.</b> Purchases are not cost of goods: a
            month with a big buy-in would look catastrophic and the month that sold the stock wonderful, and neither
            figure would mean anything. The textbook fix needs the shelves counted every month. PioneerRx prints the
            acquisition cost of every fill, so the cost of what actually sold is known per bottle and no stocktake is
            needed.
          </p>
          <p>
            <b>Rebates reduce cost; they are never revenue.</b> Booked as income they would overstate sales and cost of
            goods by the same amount, leave the bottom line right, and make every margin percentage wrong. They follow
            the basis too: earned against the month that earned them, received against the month they were banked.
          </p>
          <p>
            <b>DIR fees come out of revenue, not overheads.</b> They are money a plan said the pharmacy had earned and
            later took back. Filed as an overhead they flatter the dispensing margin — the figure used to decide what to
            stock and who to contract with.
          </p>
          <p>
            <b>Cash and accrual are both true.</b> A prescription dispensed on the 30th is this month&rsquo;s earnings
            and next month&rsquo;s money. The gap between the two accounts is the receivable, which is real and worth
            watching on its own.
          </p>
        </div>
      </details>

      {period.kind === "month" && <ExportData page="monthly" params={{ month, basis }} className="mt-6" />}
    </>
  );
}

function Group({
  title,
  lines,
  total,
  negative,
}: {
  title: string;
  lines: { label: string; amountCents: number; note?: string }[];
  total: number;
  negative?: boolean;
}) {
  if (lines.length === 0) return null;
  return (
    <div className="border-b border-line">
      <p className="bg-ground px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">{title}</p>
      {lines.map((l, i) => (
        <div key={i} className="flex items-baseline gap-3 px-4 py-1.5 text-sm">
          <span className="flex-1">{l.label}</span>
          {l.note && <span className="text-xs text-ink-3">{l.note}</span>}
          <span className={`w-28 shrink-0 text-right tabular-nums ${negative || l.amountCents < 0 ? "text-ink-2" : ""}`}>
            {formatCents(l.amountCents)}
          </span>
        </div>
      ))}
      <div className="flex items-baseline gap-3 border-t border-line px-4 py-1.5 text-sm">
        <span className="flex-1 text-ink-3">Total</span>
        <span className="w-28 shrink-0 text-right font-medium tabular-nums">{formatCents(total)}</span>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  big,
  note,
  tone,
}: {
  label: string;
  value: number;
  strong?: boolean;
  big?: boolean;
  note?: string;
  tone?: "ok" | "crit";
}) {
  return (
    <div className={`flex items-baseline gap-3 border-b border-line px-4 py-2.5 ${strong ? "bg-ground" : ""}`}>
      <span className={`flex-1 ${strong ? "font-semibold" : ""} ${big ? "text-base" : "text-sm"}`}>{label}</span>
      {note && <span className="text-xs text-ink-3">{note}</span>}
      <span
        className={`w-28 shrink-0 text-right tabular-nums ${big ? "text-lg" : ""} ${strong ? "font-bold" : ""} ${
          tone === "crit" ? "text-crit" : tone === "ok" ? "text-accent" : ""
        }`}
      >
        {formatCents(value)}
      </span>
    </div>
  );
}
