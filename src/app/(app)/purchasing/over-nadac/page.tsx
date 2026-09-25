import Link from "next/link";
import { familyTabs } from "@/lib/families";
import { requireUser } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { formatCents } from "@/lib/money";
import { overNadacNow } from "@/lib/over-nadac-store";
import { PageHeader, Card, Figure, Empty } from "@/components/ui";

export const metadata = { title: "Bought over NADAC" };
export const dynamic = "force-dynamic";

const perUnit = (m: number) => `$${(m / 1_000_000).toFixed(4)}`;
const WINDOWS = [7, 28, 90] as const;

/**
 * What was bought over NADAC this week, for the buying group.
 *
 * On every fill the floor reaches, and on Medicaid, the plan pays the NDC's own NADAC plus the
 * fee, so a unit bought over NADAC is an ingredient dispensed at a loss by exactly the gap. This
 * is the list to send the buying group weekly, with the arithmetic on every row: the invoice
 * price, the price after the rebate the line earns, NADAC in force, the gap, what it came to over
 * the window, and where the same NDC is cheaper.
 */
export default async function OverNadacPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  await requireReimbursement();
  await requireUser();
  const sp = await searchParams;
  const days = WINDOWS.find((d) => String(d) === sp.days) ?? 7;
  const o = await overNadacNow(days);
  const lossRows = o.rows.filter((r) => r.lawUnits > 0);

  return (
    <>
      <PageHeader
        tabs={familyTabs("order", "/purchasing/over-nadac")}
        title="Bought over NADAC"
        subtitle={`Every NDC invoiced above the federal benchmark, ${o.from} to ${o.to}, after the rebate each line earns. The weekly file for the buying group, and what each gap cost on the fills that pay NADAC by law.`}
        actions={
          <>
            {WINDOWS.map((d) => (
              <Link key={d} href={`/purchasing/over-nadac?days=${d}`} className={`btn btn-sm${d === days ? " btn-primary" : ""}`}>
                {d === 7 ? "This week" : `${d} days`}
              </Link>
            ))}
            <Link href={`/api/over-nadac?days=${days}`} prefetch={false} className="btn btn-sm" download>
              Download the file
            </Link>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure size="sm" value={o.rows.length} label="NDCs bought over NADAC" sub={`${o.underOrAt.lines} bought at or under it`} tone={o.rows.length ? "warn" : "ok"} />
        <Figure size="sm" value={formatCents(o.totals.overCents)} label="Over the benchmark, in all" sub={`on every unit bought in ${days} days`} tone={o.totals.overCents > 0 ? "warn" : "ok"} />
        <Figure size="sm" value={formatCents(o.totals.lawLossCents)} label="Paid out as a loss" sub="on fills that pay NADAC by law" tone={o.totals.lawLossCents > 0 ? "crit" : "ok"} />
        <Figure size="sm" value={o.rows.filter((r) => r.elsewhere?.underNadac).length} label="Under NADAC elsewhere" sub="another supplier lists it under the benchmark" tone="muted" />
      </div>

      <Card title="The list" className="my-4" count={o.rows.length ? `${o.rows.length} rows · ${o.totals.suppliers.join(", ")}` : undefined}>
        {o.rows.length === 0 ? (
          <Empty>
            {o.underOrAt.lines > 0
              ? `Nothing bought in the ${days} days sits over NADAC after the rebate. ${o.underOrAt.lines} lines were at or under it.`
              : `No invoice lines fall in the ${days} days, or none could be priced. Invoices are read on Ordering → Invoices; the catalogue supplies each pack size.`}
          </Empty>
        ) : (
          <>
            <p className="mb-2 text-xs text-ink-2">
              The rebate is taken off before the comparison, so a row here is over NADAC net. A row marked <i>rate not on file</i> is compared at the invoice price and overstates the gap. Ranked by dollars over on the units bought, not by percentage.
            </p>
            <div className="overflow-x-auto">
              <table className="table text-sm">
                <thead>
                  <tr>
                    <th>NDC</th>
                    <th>Supplier</th>
                    <th className="num">Units</th>
                    <th className="num">Paid / unit</th>
                    <th className="num">NADAC</th>
                    <th className="num">Over</th>
                    <th className="num">Dollars over</th>
                    <th>Cheaper elsewhere</th>
                    <th className="num">Lost on NADAC-paid fills</th>
                  </tr>
                </thead>
                <tbody>
                  {o.rows.slice(0, 100).map((r) => (
                    <tr key={`${r.ndc11}|${r.supplier}`}>
                      <td>
                        <span className="block font-medium">{r.name ?? r.ndc11}</span>
                        <span className="block font-mono text-[11px] text-ink-3">{r.ndc11}{r.itemNumber ? ` · #${r.itemNumber}` : ""} · {r.packs} × {r.packQty} · {r.lastInvoice}</span>
                      </td>
                      <td className="text-xs">{r.supplier}{r.rebateRateMissing ? <span className="block text-warn">rate not on file</span> : r.rebateApplied ? <span className="block text-ink-3">after rebate</span> : null}</td>
                      <td className="num">{r.units.toLocaleString()}</td>
                      <td className="num">{perUnit(r.effectiveUnitMicros)}{r.rebateApplied ? <span className="block text-[11px] text-ink-3">{perUnit(r.invoiceUnitMicros)} invoiced</span> : null}</td>
                      <td className="num">{perUnit(r.nadacMicros)}<span className="block text-[11px] text-ink-3">{r.nadacOn}</span></td>
                      <td className="num text-warn">{r.overPercent.toFixed(0)}%</td>
                      <td className="num font-medium">{formatCents(r.overCents)}</td>
                      <td className="text-xs">{r.elsewhere ? <>{r.elsewhere.supplier} {perUnit(r.elsewhere.effectiveUnitMicros)}{r.elsewhere.itemNumber ? ` · #${r.elsewhere.itemNumber}` : ""}{r.elsewhere.underNadac ? <span className="block text-accent">under NADAC</span> : null}</> : <span className="text-ink-3">no other listing</span>}</td>
                      <td className="num">{r.lawUnits > 0 ? <>{formatCents(r.lawLossCents)}<span className="block text-[11px] text-ink-3">{Math.round(r.lawUnits).toLocaleString()} units</span></> : <span className="text-ink-3">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {lossRows.length > 0 && (
              <p className="mt-2 text-xs text-ink-2">
                {lossRows.length} of these went out on plans that pay NADAC plus the fee by law, so the gap on those units is money the plan will never pay back; the fee is what was earned on them.
              </p>
            )}
          </>
        )}
        {o.excluded.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-ink-3">{o.excluded.length} lines could not be measured, and are named rather than dropped</summary>
            <ul className="mt-1 space-y-0.5 text-xs text-ink-3">
              {o.excluded.slice(0, 30).map((e, i) => (
                <li key={`${e.ndc11}|${e.supplier}|${i}`}><span className="font-mono">{e.ndc11}</span> {e.name ?? ""} · {e.supplier}: {e.reason}</li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <p className="text-xs text-ink-3">
        The file is plain columns until the buying group&rsquo;s own form is on file; then it is written in the group&rsquo;s layout and can go weekly by email from Settings → Connections.
      </p>
    </>
  );
}
