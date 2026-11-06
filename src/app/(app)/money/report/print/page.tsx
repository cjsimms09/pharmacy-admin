import { requireUser } from "@/lib/auth";
import { periodAccount } from "@/lib/profit-and-loss";
import { parsePeriod, previousPeriod, changeFrom } from "@/lib/period-account";
import { formatCents } from "@/lib/money";
import { fmtLong, todayIso } from "@/lib/dates";
import { PrintFrame } from "@/components/print";

export const dynamic = "force-dynamic";
export const metadata = { title: "Period sheet" };

/**
 * One period on one sheet, for an accountant or a lender.
 *
 * The owner asked for a monthly breakdown that could be printed and kept. This is that sheet, and
 * it is deliberately not the screen with the print stylesheet turned on: a screen answers "what
 * should I do about this", and a sheet answers "what happened", which wants different things on it
 * — every figure, its basis, the months behind it, and a plain statement of what is missing.
 *
 * It carries no charts. A printed chart of six months is decoration next to the table of the same
 * six months, and this page has to survive being photocopied.
 *
 * What it will not do is print a bottom line over a hole. Where a month in the period is short of
 * something material, that is said at the top in words, on the sheet itself, so the figure cannot
 * be read out of the page and quoted without it.
 */
export default async function PeriodSheet({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; basis?: string }>;
}) {
  await requireUser();
  const { period: periodParam, basis: basisParam } = await searchParams;
  const basis = basisParam === "cash" ? "cash" : "accrual";
  const key = periodParam && parsePeriod(periodParam) ? periodParam : todayIso().slice(0, 7);
  const totals = await periodAccount(key, basis);
  const prevKey = totals ? previousPeriod(totals.period)?.key : null;
  const prev = prevKey ? await periodAccount(prevKey, basis) : null;

  const money = (c: number) => formatCents(c);

  if (!totals) {
    return (
      <PrintFrame formTitle="Period account" formNumber="" revised="" backHref="/money/report" ownDocument>
        <p className="text-sm">Nothing is recorded for {key}.</p>
      </PrintFrame>
    );
  }

  const line = (label: string, cents: number, opts: { bold?: boolean; note?: string; indent?: boolean } = {}) => (
    <tr key={label} className={opts.bold ? "font-semibold" : ""}>
      <td className={opts.indent ? "pl-6" : ""}>
        {label}
        {opts.note && <span className="block text-[10px] font-normal text-ink-3">{opts.note}</span>}
      </td>
      <td className="text-right tabular-nums">{money(cents)}</td>
      <td className="text-right tabular-nums text-ink-3">
        {prev ? money(pick(prev, label) ?? 0) : "—"}
      </td>
    </tr>
  );

  return (
    <PrintFrame
      formTitle={`Profit and loss — ${totals.period.label}`}
      formNumber=""
      revised={`${basis === "cash" ? "Cash basis" : "Accrual basis"} · prepared ${fmtLong(todayIso())}`}
      backHref={`/money/report?period=${key}&basis=${basis}`}
      ownDocument
    >
      {(totals.emptyMonths.length > 0 || totals.unusableMonths.length > 0) && (
        <div className="mb-4 border border-line bg-ground p-3 text-xs">
          <b>This sheet is not complete, and the figures below should not be quoted without this line.</b>
          {totals.emptyMonths.length > 0 && (
            <div className="mt-1">Nothing at all is recorded for {totals.emptyMonths.join(", ")}.</div>
          )}
          {totals.unusableMonths.length > 0 && (
            <div className="mt-1">
              {totals.unusableMonths.join(", ")} {totals.unusableMonths.length === 1 ? "is" : "are"} short of something
              material: {totals.missing.join(" ")}
            </div>
          )}
        </div>
      )}

      <table className="table text-sm">
        <thead>
          <tr>
            <th>{totals.period.label}</th>
            <th className="text-right">This period</th>
            <th className="text-right">{prevKey ?? "—"}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="font-semibold">
            <td>Scripts dispensed</td>
            <td className="text-right tabular-nums">{totals.scripts.toLocaleString()}</td>
            <td className="text-right tabular-nums text-ink-3">{prev ? prev.scripts.toLocaleString() : "—"}</td>
          </tr>
          {line("Net revenue", totals.netRevenueCents, { bold: true, note: "Every plan's remittance plus what patients paid, less anything taken back" })}
          {line("Cost of goods sold", totals.costOfGoodsCents, { note: "The acquisition cost of what was dispensed, less the rebates earned on it" })}
          {line("Gross profit", totals.grossProfitCents, { bold: true })}
          {line("Overheads", totals.operatingCents, { note: "Wages, rent, software, and everything else it costs to open the door" })}
          {line("Net profit", totals.netProfitCents, { bold: true })}
        </tbody>
      </table>

      <table className="table mt-4 text-sm">
        <thead>
          <tr>
            <th>Rates</th>
            <th className="text-right">This period</th>
            <th className="text-right">{prevKey ?? "—"}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Gross margin</td>
            <td className="text-right tabular-nums">{totals.grossMarginPercent !== null ? `${totals.grossMarginPercent}%` : "—"}</td>
            <td className="text-right tabular-nums text-ink-3">{prev?.grossMarginPercent !== null && prev ? `${prev.grossMarginPercent}%` : "—"}</td>
          </tr>
          <tr>
            <td>Net margin</td>
            <td className="text-right tabular-nums">{totals.netMarginPercent !== null ? `${totals.netMarginPercent}%` : "—"}</td>
            <td className="text-right tabular-nums text-ink-3">{prev?.netMarginPercent !== null && prev ? `${prev.netMarginPercent}%` : "—"}</td>
          </tr>
          <tr>
            <td>Net revenue a script</td>
            <td className="text-right tabular-nums">{totals.revenuePerScriptCents !== null ? money(totals.revenuePerScriptCents) : "—"}</td>
            <td className="text-right tabular-nums text-ink-3">{prev?.revenuePerScriptCents ? money(prev.revenuePerScriptCents) : "—"}</td>
          </tr>
          <tr>
            <td>Gross profit a script</td>
            <td className="text-right tabular-nums">{totals.grossProfitPerScriptCents !== null ? money(totals.grossProfitPerScriptCents) : "—"}</td>
            <td className="text-right tabular-nums text-ink-3">{prev?.grossProfitPerScriptCents ? money(prev.grossProfitPerScriptCents) : "—"}</td>
          </tr>
        </tbody>
      </table>

      {totals.months.length > 1 && (
        <table className="table mt-4 text-sm">
          <thead>
            <tr>
              <th>Month</th>
              <th className="text-right">Scripts</th>
              <th className="text-right">Net revenue</th>
              <th className="text-right">Gross profit</th>
              <th className="text-right">Margin</th>
              <th className="text-right">Net profit</th>
            </tr>
          </thead>
          <tbody>
            {totals.months.map((m) => (
              <tr key={m.month}>
                <td>
                  {m.month}
                  {!m.usable && <span className="text-[10px] text-ink-3"> (incomplete)</span>}
                </td>
                <td className="text-right tabular-nums">{m.claimsCount.toLocaleString()}</td>
                <td className="text-right tabular-nums">{money(m.netRevenueCents)}</td>
                <td className="text-right tabular-nums">{money(m.grossProfitCents)}</td>
                <td className="text-right tabular-nums">{m.grossMarginPercent !== null ? `${m.grossMarginPercent}%` : "—"}</td>
                <td className="text-right tabular-nums">{money(m.netProfitCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {prev && (
        <p className="mt-4 text-xs text-ink-2">
          Against {prevKey}: net revenue {signed(changeFrom(totals.netRevenueCents, prev.netRevenueCents))}, gross profit{" "}
          {signed(changeFrom(totals.grossProfitCents, prev.grossProfitCents))}, net profit{" "}
          {signed(changeFrom(totals.netProfitCents, prev.netProfitCents))}, on{" "}
          {totals.scripts - prev.scripts >= 0 ? "+" : "−"}
          {Math.abs(totals.scripts - prev.scripts).toLocaleString()} scripts.
        </p>
      )}

      <p className="mt-4 text-[10px] text-ink-3">
        {basis === "cash"
          ? "Cash basis: revenue is what reached the bank in the period, and cost of goods is what was paid to suppliers in it."
          : "Accrual basis: revenue is what the period earned, whatever month it is paid in, and cost of goods is the acquisition cost of what was dispensed. Rebates reduce cost and are never counted as income."}{" "}
        Added up from the months this site computed individually; the same figures appear on each month&rsquo;s own
        account. Prepared by the pharmacy from its own records and not audited.
      </p>
    </PrintFrame>
  );
}

/** The comparable figure on the earlier period, by the same label. */
function pick(p: import("@/lib/period-account").PeriodTotals, label: string): number | null {
  switch (label) {
    case "Net revenue":
      return p.netRevenueCents;
    case "Cost of goods sold":
      return p.costOfGoodsCents;
    case "Gross profit":
      return p.grossProfitCents;
    case "Overheads":
      return p.operatingCents;
    case "Net profit":
      return p.netProfitCents;
    default:
      return null;
  }
}

function signed(c: { deltaCents: number; percent: number | null }): string {
  const dir = c.deltaCents >= 0 ? "+" : "−";
  return `${dir}${formatCents(Math.abs(c.deltaCents))}${c.percent !== null ? ` (${c.percent > 0 ? "+" : ""}${c.percent}%)` : ""}`;
}
