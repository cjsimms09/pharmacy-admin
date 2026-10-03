import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { replayNow } from "@/lib/replay-store";
import { headToHead } from "@/lib/contract-replay";
import { formatCents } from "@/lib/money";
import { PageHeader, Card, Notice, Empty, Figure } from "@/components/ui";
import { Bars } from "@/components/bars";

export const dynamic = "force-dynamic";
export const metadata = { title: "Which contract" };

/**
 * Which wholesaler's contract would have cost least on what this pharmacy actually dispensed.
 *
 * Every fill of the last twelve months, priced at each supplier's cheapest equivalent product and
 * run through that supplier's own ladder. The ranking is among suppliers whose catalogue covers
 * enough of the dispensing to be a real alternative; the rest are shown with what they could not
 * supply. To test a wholesaler not yet on file: add it under Suppliers, load its price file, type
 * its rebate ladder on its terms page, and open this page again.
 */
export default async function ReplayPage({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  await requireReimbursement();
  await requireUser();
  const { a, b } = await searchParams;
  const view = await replayNow(12);
  const r = view.replay;
  const ranked = r.ranking;
  const eligible = new Set(ranked.filter((x) => x.eligible).map((x) => x.supplier));
  const pairA = a ?? ranked[0]?.supplier;
  const pairB = b ?? ranked[1]?.supplier;
  const h2h = pairA && pairB ? headToHead(r, pairA, pairB) : null;
  const units = (t: number) => (t / 1000).toLocaleString("en-US", { maximumFractionDigits: 0 });

  return (
    <>
      <PageHeader
        title="Which contract"
        subtitle="A year of dispensing replayed through each wholesaler's catalogue and rebate ladder, so the renewal is decided on this pharmacy's own claims."
        back={{ href: "/purchasing", label: "Buying" }}
        help={
          <>
            <p><b>Every fill of the last twelve months</b> is priced at each supplier&rsquo;s cheapest product in the same group: drug, strength, form, brand-or-generic and pricing unit from NADAC&rsquo;s descriptions. A brand is never replayed as its generic.</p>
            <p><b>Each supplier&rsquo;s ladder</b> is measured on the replayed month, unscrubbed, so every ladder is understated the same way, and applied to the spend the programme calls eligible. No ladder on file earns nothing, and says so.</p>
            <p><b>Coverage</b> is shown apart: a supplier cheapest on ninety per cent of the dispensing and unable to supply the rest is a different proposition. The ranking is among suppliers covering 90%; the head-to-head compares two on the products both supply.</p>
            <p><b>To test a new wholesaler:</b> add it under Suppliers, load its price file, type its ladder on its terms page, and open this page again. Rule 8 in <code>buying-logic.md</code>.</p>
          </>
        }
        actions={<Link href="/suppliers" className="btn">Suppliers and terms</Link>}
      />

      {view.missing.map((m) => <Notice key={m} kind="warn">{m}</Notice>)}

      {r.fills === 0 ? (
        <Empty>Nothing to replay yet.</Empty>
      ) : (
        <>
          <Notice kind={ranked.filter((x) => x.eligible).length >= 2 ? "ok" : "warn"}>{r.says}</Notice>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Figure value={r.fills.toLocaleString()} label="fills replayed" sub={`${r.from} to ${r.to}${r.unplaceable ? ` · ${r.unplaceable} with no product key, in nobody's figures` : ""}`} tone="muted" />
            {ranked.slice(0, 3).map((x, i) => (
              <Figure
                key={x.supplier}
                size="sm"
                value={formatCents(x.netCents)}
                label={`${x.supplier}, net`}
                sub={`${Math.round(x.coverageShare * 100)}% of fills covered${x.eligible ? "" : " — under 90%, not ranked"}`}
                tone={i === 0 && x.eligible ? "ok" : "muted"}
                href={`/purchasing/replay?a=${encodeURIComponent(x.supplier)}&b=${encodeURIComponent(pairB ?? "")}`}
              />
            ))}
          </div>

          <Card className="mt-4" title="Every supplier, on the same year" subtitle="Gross is the invoice at each supplier's cheapest equivalent product; the rebate is its ladder at the ratio the replayed month produces; net is what the year would have cost.">
            <div className="overflow-x-auto">
              <table className="table text-sm">
                <thead>
                  <tr>
                    <th>Supplier</th>
                    <th className="num">Covers</th>
                    <th className="num">Gross</th>
                    <th className="num">Rebate</th>
                    <th className="num">Net</th>
                    <th>Says</th>
                  </tr>
                </thead>
                <tbody>
                  {/* The same order as the ranking: the suppliers that cover the dispensing first, cheapest first
                      among them, and only then the ones that could supply part of it. A cheap partial supplier at
                      the top of the table read as the winner. */}
                  {[...r.suppliers]
                    .sort(
                      (x, y) =>
                        Number(eligible.has(y.supplier)) - Number(eligible.has(x.supplier)) ||
                        (x.coverage.matched === 0 ? 1 : 0) - (y.coverage.matched === 0 ? 1 : 0) ||
                        x.netCents - y.netCents,
                    )
                    .map((s) => (
                    <tr key={s.supplier}>
                      <td className="font-medium">{s.supplier}{!s.hasTerms && <span className="badge badge-warn ml-2">no ladder on file</span>}</td>
                      <td className="num">{Math.round(s.coverage.share * 100)}%</td>
                      <td className="num">{formatCents(s.grossCents)}</td>
                      <td className="num text-accent">{formatCents(s.rebateCents)}</td>
                      <td className="num font-semibold">{formatCents(s.netCents)}</td>
                      <td className="text-xs text-ink-2">{s.says}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {ranked.length >= 1 && (
            <Card className="mt-4" title="Month by month, net" subtitle="Each ranked supplier's net cost per month of the replay. A month with nothing dispensed is blank.">
              <Bars
                labels={r.suppliers[0]?.months.map((m) => m.month.slice(5) + "/" + m.month.slice(2, 4)) ?? []}
                series={ranked.slice(0, 3).map((x, i) => ({ label: x.supplier, values: r.suppliers.find((s) => s.supplier === x.supplier)!.months.map((m) => (m.grossCents > 0 ? m.netCents : null)), tone: i === 0 ? "accent" : i === 1 ? "ink" : "warn" }))}
              />
            </Card>
          )}

          {h2h && pairA && pairB && (
            <Card className="mt-4" title={`${pairA} against ${pairB}, product by product`} count={`${h2h.products.length} products both supply`} subtitle={`On the products both can supply: ${formatCents(h2h.aCents)} at ${pairA}, ${formatCents(h2h.bCents)} at ${pairB}, before rebates. Largest differences first.`}>
              <div className="overflow-x-auto">
                <table className="table text-sm">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="num">{pairA}</th>
                      <th className="num">{pairB}</th>
                      <th className="num">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {h2h.products.slice(0, 40).map((p) => (
                      <tr key={p.groupKey}>
                        <td>
                          <span className="block">{p.name ?? p.groupKey.split("|")[0]}</span>
                          <span className="block font-mono text-[11px] text-ink-3">{p.groupKey}</span>
                        </td>
                        <td className="num">{formatCents(p.aCents)}</td>
                        <td className="num">{formatCents(p.bCents)}</td>
                        <td className={`num ${p.aCents < p.bCents ? "text-accent" : "text-crit"}`}>{formatCents(p.aCents - p.bCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-ink-3">
                Compare another pair:{" "}
                {r.suppliers.filter((s) => s.coverage.matched > 0).map((s) => (
                  <Link key={s.supplier} href={`/purchasing/replay?a=${encodeURIComponent(pairA)}&b=${encodeURIComponent(s.supplier)}`} className="mr-2 text-accent underline">{s.supplier}</Link>
                ))}
              </p>
            </Card>
          )}

          {r.suppliers.some((s) => s.unmatched.fills > 0) && (
            <Card className="mt-4" title="What each supplier could not supply" subtitle="Products dispensed that no NDC in the supplier's catalogue matches. Not in its figures; the reason a cheaper supplier may not be a complete one.">
              <div className="grid gap-3 lg:grid-cols-2">
                {r.suppliers.filter((s) => s.unmatched.fills > 0).map((s) => (
                  <div key={s.supplier}>
                    <p className="text-sm font-semibold">{s.supplier} <span className="font-normal text-ink-3">· {s.unmatched.fills} fills, {units(s.unmatched.unitsThousandths)} units</span></p>
                    <ul className="mt-1 text-xs text-ink-2">
                      {s.unmatched.products.slice(0, 10).map((p) => <li key={p.groupKey}>{p.groupKey.split("|")[0]} · {p.fills} fill{p.fills === 1 ? "" : "s"}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <p className="mt-4 text-xs text-ink-3">
            Ratios are computed from the replayed spend without the wholesaler&rsquo;s exclusions, so every ladder is understated the same way. A brand is
            never replayed as its generic. A supplier with no ladder on its terms page earns nothing here, which is said rather than guessed.
          </p>
        </>
      )}
    </>
  );
}
