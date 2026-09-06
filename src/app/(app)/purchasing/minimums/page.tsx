import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { minimumsNow } from "@/lib/minimum-store";
import { formatCents } from "@/lib/money";
import { PageHeader, Card, Notice, Empty, Figure } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Order minimums" };

/**
 * What to add at each supplier to reach its minimum, chosen rather than grabbed.
 *
 * Recomputed every time the page opens, from the latest count, the claims and the catalogues:
 * that is the daily recompute, with nothing to go stale. Every pick is a generic, not controlled,
 * moving at a steady rate, cheapest at this supplier after the rebate, and inside sixty days of use
 * counting what is on the shelf and on order. Where nothing qualifies the page says so and what
 * the alternative costs, rather than filling the order with stock that will not move.
 */
export default async function MinimumsPage() {
  await requireReimbursement();
  await requireUser();
  const view = await minimumsNow();
  const withMinimum = view.fills.filter((f) => f.minimumCents !== null);
  const short = withMinimum.filter((f) => f.shortfallCents > 0);
  const units = (t: number) => (t / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 });

  return (
    <>
      <PageHeader
        title="Order minimums"
        subtitle="What to add at each supplier to reach its minimum: generics it is the best place to buy, in quantities the next two months will use."
        back={{ href: "/purchasing", label: "What to buy" }}
        help={
          <>
            <p><b>A pick has to pass every test:</b> CMS says generic (never the name); no invoice class letter or name list says controlled; the claims show a steady rate, not one big fill; this supplier&rsquo;s price after the rebate is the lowest of everyone who prices it; whole packs fit inside sixty days of use with the shelf and the on-order counted.</p>
            <p><b>Ranking</b> is saving per dollar committed, then velocity, until the shortfall is met. The last pack may overshoot the minimum; the page says by how much. Where nothing qualifies it says so and prices the alternative.</p>
            <p><b>Recomputed on every open</b> from the latest count, claims and catalogues, starting from today&rsquo;s planned basket at each supplier. Rule 7a in <code>buying-logic.md</code>.</p>
          </>
        }
        actions={<Link href="/suppliers" className="btn">Suppliers and minimums</Link>}
      />

      {view.missing.map((m) => <Notice key={m} kind="warn">{m}</Notice>)}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure value={withMinimum.length} label="suppliers with a minimum" sub={`${short.length} short of it on today's order`} tone={short.length ? "warn" : "ok"} />
        <Figure value={formatCents(short.reduce((n, f) => n + f.shortfallCents, 0))} label="short in total" sub="before anything is added" tone="muted" />
        <Figure value={formatCents(short.reduce((n, f) => n + f.addedCents, 0))} label="worth adding" sub={`${short.reduce((n, f) => n + f.picks.length, 0)} generics that qualify`} tone="ok" />
        <Figure value={view.known.generics} label="generics moving" sub={`${view.known.brands} brands · ${view.known.controlled} controlled · ${view.known.unclassified} not on the NADAC file`} tone="muted" />
      </div>

      {withMinimum.length === 0 ? (
        <Empty>No supplier has an order minimum on file. Put each supplier&rsquo;s minimum, freight threshold and lead time on its card under Suppliers, and this fills in.</Empty>
      ) : (
        view.fills
          .filter((f) => f.minimumCents !== null)
          .map((f) => (
            <Card
              key={f.supplier}
              className="mt-4"
              title={f.supplier}
              count={`${formatCents(f.basketCents)} on today's order · minimum ${formatCents(f.minimumCents ?? 0)}`}
              subtitle={f.says}
              tone={f.shortfallCents === 0 ? "ok" : f.meets ? undefined : "warn"}
              actions={f.supplierId ? <Link href={`/suppliers/${f.supplierId}/terms`} className="btn btn-sm">Terms</Link> : undefined}
            >
              {f.picks.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="table text-sm">
                    <thead>
                      <tr>
                        <th>Add</th>
                        <th className="num">Packs</th>
                        <th className="num">Units</th>
                        <th className="num">Cost</th>
                        <th className="num">Saves</th>
                        <th className="num">A day</th>
                        <th className="num">Days after</th>
                        <th className="num">60-day use</th>
                      </tr>
                    </thead>
                    <tbody>
                      {f.picks.map((p) => (
                        <tr key={p.ndc11}>
                          <td>
                            <span className="block">{p.name ?? p.ndc11}</span>
                            <span className="block font-mono text-[11px] text-ink-3">{p.ndc11}</span>
                            <span className="block text-[11px] text-ink-3">{p.why}</span>
                          </td>
                          <td className="num">{p.packs} × {p.packQty}</td>
                          <td className="num">{units(p.unitsThousandths)}</td>
                          <td className="num">{formatCents(p.costCents)}</td>
                          <td className="num text-accent">{formatCents(p.savingCents)}</td>
                          <td className="num">{units(p.perDayThousandths)}</td>
                          <td className="num">{p.daysOfStockAfter}</td>
                          <td className="num">{units(p.projectedThousandths)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="font-semibold">
                        <td>Added</td>
                        <td></td>
                        <td></td>
                        <td className="num">{formatCents(f.addedCents)}</td>
                        <td className="num text-accent">{formatCents(f.picks.reduce((n, p) => n + p.savingCents, 0))}</td>
                        <td colSpan={3} className="text-right text-xs font-normal text-ink-3">
                          {f.meets ? `${formatCents(f.basketCents + f.addedCents)} in all${f.overshootCents > 0 ? `, ${formatCents(f.overshootCents)} over the minimum` : ""}` : `${formatCents(-f.overshootCents)} still short`}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
              {f.refused.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-ink-3 hover:text-accent">
                    {f.refused.length} considered and not added
                  </summary>
                  <ul className="mt-1 space-y-0.5 text-xs text-ink-2">
                    {f.refused.map((r) => (
                      <li key={r.ndc11}>
                        <span className="font-medium">{r.name ?? r.ndc11}</span> — {r.why}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {(f.leftOut.notGeneric > 0 || f.leftOut.controlled > 0 || f.leftOut.unknownClass > 0) && (
                <p className="mt-2 text-[11px] text-ink-3">
                  Never considered: {f.leftOut.notGeneric} brand{f.leftOut.notGeneric === 1 ? "" : "s"}, {f.leftOut.controlled} controlled, {f.leftOut.unknownClass} with no brand/generic flag on the NADAC file.
                </p>
              )}
            </Card>
          ))
      )}

      <p className="mt-4 text-xs text-ink-3">
        A pick has to pass every test: CMS says generic, no invoice or name says controlled, the claims show a steady rate, this supplier&rsquo;s
        price after the rebate is the lowest of everyone who prices it, and the packs fit inside {view.horizonDays} days of use with what is on the shelf and on order.
        Whole packs only, so an order may end a few dollars over the minimum; it is never left a few dollars under.
      </p>
    </>
  );
}
