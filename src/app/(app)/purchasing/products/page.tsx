import { familyTabs } from "@/lib/families";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { purchasingOpportunities } from "@/lib/suppliers";
import { productLedger, type Flag } from "@/lib/product-ledger";
import { productsExtrasNow } from "@/lib/products-store";
import { formatCents } from "@/lib/money";
import { requireReimbursement } from "@/lib/features";
import { PageHeader, Notice, Empty, Card, Figure } from "@/components/ui";
import { DataTable } from "@/components/data-table";
import { drugProfitNow } from "@/lib/drug-profit-store";
import type { Model } from "@/lib/drug-profit";
import { ExportData } from "@/components/export-data";

export const metadata = { title: "Which NDC pays" };
export const dynamic = "force-dynamic";

const money = (cents: number) => formatCents(cents);
const perUnit = (micros: number | null) =>
  micros === null ? "—" : `${micros < 0 ? "-" : ""}$${(Math.abs(micros) / 1_000_000).toFixed(5)}`;

/**
 * Which NDC of each drug pays most against what it costs, and which drugs earn or lose.
 *
 * This used to sit under the order on What to buy, where it buried the one question that page
 * exists to answer. It is a different question — not "what do I order this week" but "of the
 * drugs I dispense, which NDC and which source are worth moving to" — and it has its own tab.
 */
export default async function ProductsPage() {
  await requireReimbursement();
  await requireUser();
  const [opps, ledger, profit] = await Promise.all([purchasingOpportunities(), productLedger(), drugProfitNow()]);
  void ledger.rows;
  // Worth acting on: a better NDC or source worth at least five dollars a month on this pharmacy's fills.
  const better = profit.rows.filter((r) => (r.gainPerMonthCents ?? 0) >= 500);
  const unplaced = profit.rows.filter((r) => r.gainPerMonthCents === null && r.fills >= 2);
  const betterMonthCents = better.reduce((n, r) => n + (r.gainPerMonthCents ?? 0), 0);
  const MODEL_WORDS: Record<Model, string> = { NADAC: "NADAC + fee", AWP: "AWP − discount", MAC: "MAC", UC: "usual & customary", WAC: "WAC − discount", FUL: "FUL", flat: "flat price", unknown: "flat (basis not on export)" };
  const byModel = new Map<Model, number>();
  for (const r of profit.rows) byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.fills);
  const modelMix = [...byModel.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${MODEL_WORDS[m]} ${Math.round((100 * n) / Math.max(1, profit.rows.reduce((t, r) => t + r.fills, 0)))}%`).join(" · ");
  const sum = profit.summary;
  const extras = await productsExtrasNow();
  const { ledgerRows, buys, switches, unstocked, earned, losing } = extras;
  const bestEarners = earned.filter((m) => m.marginCents > 0).slice(0, 15);
  const totalMarginCents = earned.reduce((n, m) => n + m.marginCents, 0);
  const totalSaving = opps.rows.reduce((s, r) => s + (r.savingCents ?? 0), 0);

  return (
    <>
      <PageHeader
        tabs={familyTabs("order", "/purchasing/products")}
        title="Which NDC pays"
        subtitle="For every drug this pharmacy dispenses: how its payers pay for it, and therefore which NDC to buy and from where to earn the most on it. Then what each drug earns, and which are dispensed at a loss."
        actions={<Link href="/purchasing" className="btn">Buying</Link>}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure size="sm" value={better.length} label="Drugs with a better NDC or source" sub={`of ${profit.rows.length} dispensed, on how each is paid`} tone={better.length ? "ok" : "muted"} href="#bymodel" />
        <Figure size="sm" value={money(betterMonthCents)} label="Worth a month" sub="on this pharmacy's own fills, after rebate" tone={betterMonthCents > 0 ? "ok" : "muted"} href="#bymodel" />
        <Figure size="sm" value={losing.length} label="Dispensed at a loss" sub={losing.length ? `${money(Math.abs(losing.reduce((n, m) => n + m.marginCents, 0)))} so far` : "every product held earns"} tone={losing.length ? "crit" : "ok"} href={earned.length ? "#earns" : undefined} />
        <Figure size="sm" value={money(totalMarginCents)} label="Earned across everything held" sub={`${earned.length.toLocaleString()} products`} tone={totalMarginCents < 0 ? "crit" : "ok"} href="#earns" />
      </div>

      {/*
        The owner's question, answered per drug: how is it paid, so which NDC should we buy.

        The cheapest NDC is only the most profitable one when the reimbursement does not move with
        the NDC. Under NADAC-plus-a-fee the plan pays each NDC's own NADAC, so the one to buy is the
        one furthest under its own benchmark; under AWP-less-a-discount a dearer NDC with a higher
        AWP earns more. The model is read off the claims — the PBM's basis code where the export
        carries it, the arithmetic of what was paid against the benchmarks where it does not.
      */}
      <Card id="bymodel" title="Under NADAC, and the rest: what to buy for each drug, given how it is paid" className="my-4" count={profit.ready ? `${profit.rows.length} drugs · ${profit.fills.toLocaleString()} fills over ${profit.months.toFixed(1)} months` : undefined}>
        {!profit.ready ? (
          <Empty>{profit.reason}</Empty>
        ) : (
          <>
            {/*
              The two figures that say how much of the answer the floor is. On a fill the law settles
              (Medicaid; a plan the register says the floor reaches, from 1 July 2026) the plan pays
              the NDC's own NADAC plus the fee, and the NDC furthest under its own NADAC is the
              exact answer. Where the floor did not bind the contract paid more, and the contract's
              way decides. Everything else is the PBM's code or the money, and the row says which.
            */}
            <div className="mb-3 grid gap-3 sm:grid-cols-3">
              <Figure size="sm" value={sum.remitCents > 0 ? `${Math.round((100 * sum.byLaw.remitCents) / sum.remitCents)}%` : "—"} label="Of paid dollars settled by law" sub={`${sum.byLaw.fills.toLocaleString()} fills on Medicaid or a plan the floor reaches`} tone={sum.byLaw.fills ? "ok" : "muted"} href="/plans" />
              <Figure size="sm" value={sum.floor.bound + sum.floor.above > 0 ? `${Math.round((100 * sum.floor.bound) / (sum.floor.bound + sum.floor.above))}%` : "—"} label="Of floor fills where the floor bound" sub={sum.floor.fills ? `${sum.floor.above.toLocaleString()} paid above it by the contract${sum.floor.unpriced ? `, ${sum.floor.unpriced} with no NADAC` : ""}` : "no plan is classified as one the floor reaches"} tone={sum.floor.fills ? "ok" : "muted"} href="/claims/floor" />
              <Figure size="sm" value={sum.fills > 0 ? `${Math.round((100 * (sum.byLaw.fills + sum.byCode)) / sum.fills)}%` : "—"} label="Of fills settled by law or the PBM's code" sub={`${sum.inferred.toLocaleString()} read from the money against NADAC and AWP`} tone={sum.fills && (sum.byLaw.fills + sum.byCode) / sum.fills >= 0.8 ? "ok" : "warn"} />
            </div>
            <p className="mb-2 text-xs text-ink-2">
              How this pharmacy&rsquo;s fills are paid: {modelMix}. {profit.withBasis > 0 ? `${Math.round((100 * profit.withBasis) / profit.fills)}% of fills carry the PBM's basis code.` : "The claims export carries no basis-of-reimbursement column (NCPDP 522-FM); add it to the PioneerRx report and every fill the law does not settle becomes the PBM's own word."}
              {" "}Drugs are grouped on the FDA directory where it carries the NDC ({profit.grouping.directory.toLocaleString()} of {(profit.grouping.directory + profit.grouping.description).toLocaleString()} dispensed) and on NADAC&rsquo;s description for the rest.
              {" "}Margins are per fill of the drug&rsquo;s typical quantity, after the rebate each price earns; a drug paid more than one way is valued under each, weighed by share.
            </p>
            {better.length === 0 ? (
              <Empty>No drug has an NDC or source worth five dollars a month more than the one dispensed today, on the prices and benchmarks held.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="table text-sm">
                  <thead>
                    <tr>
                      <th>Drug</th>
                      <th className="num">Fills / mo</th>
                      <th>Paid how</th>
                      <th>Dispensed today</th>
                      <th>Buy instead</th>
                      <th className="num">Earns / fill</th>
                      <th className="num">Gain / fill</th>
                      <th className="num">A month</th>
                    </tr>
                  </thead>
                  <tbody>
                    {better.slice(0, 40).map((r) => (
                      <tr key={r.group}>
                        <td>
                          <span className="block font-medium">{r.name ?? r.current?.ndc11 ?? r.group}</span>
                          <span className="block text-[11px] text-ink-3">{Math.round(r.typicalThousandths / 1000).toLocaleString()} a fill · {r.why}</span>
                        </td>
                        <td className="num">{r.fillsPerMonth.toFixed(1)}</td>
                        <td className="text-xs">
                          <span className="block">{r.modelSays}{r.mix.length > 1 ? <span className="text-ink-3"> · {Math.round(r.modelShare * 100)}%</span> : null}</span>
                          {r.mix.slice(1, 3).map((m) => (
                            <span key={m.model} className="block text-ink-3">{m.says} · {Math.round(m.share * 100)}%</span>
                          ))}
                          <span className="block text-ink-3">
                            {r.settledBy.law > 0 ? `${r.settledBy.law} by law` : null}{r.settledBy.law > 0 && r.settledBy.code > 0 ? ", " : ""}{r.settledBy.code > 0 ? `${r.settledBy.code} by code` : null}{(r.settledBy.law > 0 || r.settledBy.code > 0) && r.settledBy.inferred > 0 ? ", " : ""}{r.settledBy.inferred > 0 ? `${r.settledBy.inferred} read` : null}
                            {" · "}{r.payers.slice(0, 2).map((p) => `${p.payer} ${p.fills}`).join(", ")}
                          </span>
                          {r.confidence === "read" ? <span className="badge badge-warn mt-0.5">read from the money</span> : null}
                        </td>
                        <td className="text-xs">
                          <span className="block font-mono">{r.current?.ndc11}</span>
                          <span className="block text-ink-3">{r.current?.supplier ?? "no price held"}{r.current?.marginCents !== null && r.current?.marginCents !== undefined ? ` · earns ${money(r.current.marginCents)}` : ""}</span>
                        </td>
                        <td className="text-xs">
                          <span className="block font-mono">{r.best?.ndc11}{r.best?.itemNumber ? <span className="text-ink-3"> · #{r.best.itemNumber}</span> : null}</span>
                          <span className="block text-ink-3">{r.best?.supplier} at {perUnit(r.best?.unitMicros ?? null)}{r.best?.ndc11 === r.current?.ndc11 ? " · same NDC, better source" : ""}</span>
                        </td>
                        <td className="num">{money(r.best?.marginCents ?? 0)}</td>
                        <td className="num text-accent">{money(r.gainPerFillCents ?? 0)}</td>
                        <td className="num font-medium text-accent">{money(r.gainPerMonthCents ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {unplaced.length > 0 && (
              <p className="mt-2 text-xs text-ink-3">
                {unplaced.length} drug{unplaced.length === 1 ? "" : "s"} dispensed more than once could not be placed: no price is held for the NDC dispensed, or no benchmark under a way it is paid (an NDC with no NADAC cannot be priced on a floor plan, and is never the answer there) — {unplaced.slice(0, 5).map((r) => r.name ?? r.current?.ndc11 ?? r.group).join(", ")}{unplaced.length > 5 ? ", …" : ""}.
              </p>
            )}
          </>
        )}
      </Card>

      {/*
        Everything known about a drug, in one row.

        The four records that answer this question were held apart: the invoices say what was
        actually paid and whether the line earned the rebate, the catalogues say what everyone else
        charges, NADAC says what the government reckons it costs, and the claims say what went out
        of the door. Each on its own is a page somebody has to reconcile in their head. Together
        they say which drugs to move, where to, and what it is worth.
      */}
      {/*
        The switches worth making, above the table that explains them.
        
        A table of every drug is a reference; this is the list of things to actually do this week,
        ranked by what each is worth on the quantities this pharmacy dispenses — because a large
        percentage off something bought twice a year is not worth an afternoon.
      */}
      {(switches.length > 0 || unstocked.length > 0) && (
        <Card id="instead" title="Buy these instead" className="my-4">          <p className="mt-1 text-xs text-ink-2">
            Every NDC offered under what the federal benchmark says the drug costs, after the rebate this pharmacy
            actually earns. Grouped into products on NADAC&rsquo;s own description, so a switch is between genuine
            equivalents rather than between things that merely sound alike.
          </p>

          {switches.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Buying now</th>
                    <th>Better</th>
                    <th className="text-right">Worth</th>
                  </tr>
                </thead>
                <tbody>
                  {switches.slice(0, 25).map((p) => (
                    <tr key={p.groupKey} className="border-t border-line align-top">
                      <td>
                        {p.name ?? p.pick.ndc11}
                        <span className="block text-[11px] text-ink-3">{p.units.toLocaleString()} units dispensed</span>
                      </td>
                      <td className="font-mono text-[11px]">{p.current?.ndc11 ?? "—"}</td>
                      <td>
                        <span className="font-mono text-[11px]">{p.pick.ndc11}</span>
                        <span className="block text-[11px] text-ink-3">{p.pick.buy.supplier}</span>
                      </td>
                      <td className="text-right font-medium tabular-nums text-accent">{formatCents(p.gainCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {switches.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-ink-2">
              {switches.slice(0, 5).map((p) => (
                <li key={`says-${p.groupKey}`}>{p.says}</li>
              ))}
            </ul>
          )}

          {unstocked.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-ink-3">
                {unstocked.length} NDCs offered well under the benchmark that this pharmacy neither buys nor dispenses
              </summary>
              <p className="mt-1 text-xs text-ink-3">
                Not a recommendation on its own — a drug nobody here dispenses is not worth stocking however cheap it
                is. It is the shelf the pharmacy does not have, for the day somebody asks why a script went elsewhere.
              </p>
              <ul className="mt-2 grid gap-0.5 text-xs sm:grid-cols-2">
                {unstocked.slice(0, 30).map((r) => (
                  <li key={r.ndc11} className="flex justify-between gap-2">
                    <span className="truncate">{r.name ?? r.ndc11}</span>
                    <span className="shrink-0 tabular-nums text-ink-3">{r.underNadacPercent.toFixed(0)}% under</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {buys.excluded.length > 0 && (
            <p className="mt-2 text-[11px] text-ink-3">
              {buys.excluded.length} rows could not be measured and are named rather than dropped — a shorter list reads
              as good news.
            </p>
          )}
        </Card>
      )}

      <Card title="What to do about it" className="my-4">        <p className="mt-1 text-sm text-ink-2">
          Every drug this pharmacy has bought or dispensed, with what was paid, what it earns back, what else it costs
          elsewhere and what the benchmark says. Sorted by what the move is actually worth on the quantities dispensed,
          because a large percentage off something bought twice a year is not worth an afternoon.
        </p>
        {ledger.rate === null ? (
          <p className="mt-2 rounded-md border border-warn bg-warn-soft px-3 py-2 text-xs text-warn">
            <b>No generic rebate rate is on file, so every McKesson contract line is being compared at its gross invoice
            price.</b> That understates this pharmacy&rsquo;s position rather than overstating it — a rebated line looks
            dearer than it is, so a competitor may look better than it really is. Put the tier rate from the rebate
            report in Settings and every figure below sharpens. It is deliberately not estimated.
          </p>
        ) : (
          <p className="mt-2 text-xs text-ink-3">
            Contract lines are compared after taking off the {(ledger.rate * 100).toFixed(2)}% generic tier rate from
            the rebate report. A line the invoice did not mark as rebated is never given that discount.
          </p>
        )}
        {ledgerRows.length === 0 ? (
          <Empty>
            Nothing to compare yet. This fills in as invoices arrive and are read, the Monday catalogues land, and NADAC
            is fetched — it needs at least the invoices, which is where what you actually paid comes from.
          </Empty>
        ) : (
          <div className="mt-3">
            <DataTable
              initialSort={{ key: "worth", dir: "desc" }}
              caption={`${ledgerRows.length.toLocaleString()} drugs · sort by any column, filter by name, NDC or supplier`}
              columns={[
                { key: "drug", label: "Drug" },
                { key: "pay", label: "We pay", align: "right" },
                { key: "nadac", label: "NADAC", align: "right" },
                { key: "vs", label: "Against it", align: "right", firstSort: "desc" },
                { key: "best", label: "Cheapest known" },
                { key: "worth", label: "Worth", align: "right" },
                { key: "means", label: "What it means", sortable: false },
              ]}
              rows={ledgerRows.map((r) => ({
                key: r.ndc11,
                sort: {
                  drug: `${r.name ?? ""} ${r.ndc11}`,
                  pay: r.paid ? r.paid.effectiveUnitMicros : null,
                  nadac: r.nadacMicros,
                  vs: r.vsNadacMicros,
                  best: r.best ? `${r.best.supplier} ${r.best.effectiveUnitMicros}` : null,
                  worth: r.switchSavingCents ?? 0,
                  means: r.flags.map((f) => MEANS[f]).join(" "),
                },
                cells: {
                  drug: (
                    <>
                      <span className="block text-sm font-medium">{r.name ?? "—"}</span>
                      <span className="font-mono text-xs text-ink-3">{r.ndc11}</span>
                    </>
                  ),
                  pay: (
                    <span className="whitespace-nowrap text-sm">
                      {r.paid ? perUnit(r.paid.effectiveUnitMicros) : "—"}
                      {r.paid?.rebated === true && <span className="badge badge-ok ml-1">rebated</span>}
                      {r.paid && <span className="block text-xs text-ink-3">{r.paid.supplier}</span>}
                    </span>
                  ),
                  nadac: <span className="whitespace-nowrap text-sm">{r.nadacMicros === null ? <span className="text-ink-3">none</span> : perUnit(r.nadacMicros)}</span>,
                  vs: (
                    <span className={`whitespace-nowrap text-sm ${r.vsNadacMicros === null ? "" : r.vsNadacMicros > 0 ? "text-crit" : "text-accent"}`}>
                      {r.vsNadacMicros === null ? "—" : `${r.vsNadacMicros > 0 ? "+" : ""}${perUnit(r.vsNadacMicros)}`}
                    </span>
                  ),
                  best: r.best ? (
                    <span className="text-sm">
                      {r.best.supplier}
                      <span className="block text-xs text-ink-3">{perUnit(r.best.effectiveUnitMicros)} · {r.best.source === "invoice" ? "what we paid" : "listed"}</span>
                    </span>
                  ) : (
                    <span className="text-sm text-ink-3">—</span>
                  ),
                  worth: <span className="whitespace-nowrap text-sm font-medium">{r.switchSavingCents ? `$${(r.switchSavingCents / 100).toFixed(2)}` : "—"}</span>,
                  means: (
                    <span className="text-xs">
                      {r.flags.map((f) => (
                        <span key={f} className={`badge mr-1 ${f === "buying_above_nadac" || f === "not_dispensed" ? "badge-warn" : f === "cheaper_elsewhere" ? "badge-ok" : "badge-muted"}`}>
                          {MEANS[f]}
                        </span>
                      ))}
                    </span>
                  ),
                },
              }))}
            />
          </div>
        )}
      </Card>

      {/*
        Margin, which is the question the comparison does not answer.

        Everything above says what the pharmacy pays against what it could pay and against the
        benchmark. None of that says whether dispensing the drug makes money, and the two do not
        follow from each other. This is revenue received against the cost actually paid — after the
        rebate the supplier really pays on that line, because a margin worked out on gross invoice
        prices understates every contract generic by the tier rate, which here is enough to turn a
        profitable drug into an apparent loss and get it dropped.
      */}
      {earned.length > 0 && (
        <Card id="earns" title="What each drug earns" className="my-4">          <p className="mt-1 text-sm text-ink-2">
            What the plans and patients paid, against what the drug actually cost this pharmacy — the invoice price less
            the rebate that supplier really pays on the line. Across everything held, {money(totalMarginCents)} on{" "}
            {earned.length.toLocaleString()} product{earned.length === 1 ? "" : "s"}.
          </p>

          {losing.length > 0 && (
            <div className="mt-3 rounded-md border border-crit bg-crit-soft p-3">
              <p className="text-sm font-semibold text-crit">
                {losing.length} dispensed at a loss, costing {money(Math.abs(losing.reduce((n, m) => n + m.marginCents, 0)))} so far
              </p>
              <div className="mt-2 overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr><th>Drug</th><th>From</th><th className="text-right">Came in</th><th className="text-right">Cost</th><th className="text-right">Loss</th><th className="text-right">Per unit</th></tr>
                  </thead>
                  <tbody>
                    {losing.slice(0, 10).map((m) => (
                      <tr key={m.ndc11}>
                        <td>
                          <span className="block text-sm">{m.name ?? "—"}</span>
                          <span className="font-mono text-[11px] text-ink-3">{m.ndc11} · {m.claims} claim{m.claims === 1 ? "" : "s"}</span>
                        </td>
                        <td className="text-xs">{m.supplier ?? "—"}{m.rebated === true && <span className="badge badge-ok ml-1">rebated</span>}</td>
                        <td className="num text-sm">{money(m.receivedCents)}</td>
                        <td className="num text-sm">{money(m.costCents)}</td>
                        <td className="num text-sm font-medium text-crit">{money(m.marginCents)}</td>
                        <td className="num text-xs">{perUnit(m.marginPerUnitMicros)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-ink-2">
                A loss here is the plan paying below what the drug cost. It is not always a reason to stop dispensing —
                but it is always a reason to know, and the ones bought above the benchmark are also the ones worth
                appealing or sourcing elsewhere.
              </p>
            </div>
          )}

          <div className="mt-3 overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Best earners</th><th>From</th>
                  <th className="text-right">Came in</th><th className="text-right">True cost</th>
                  <th className="text-right">Margin</th><th className="text-right">%</th><th className="text-right">vs NADAC</th>
                </tr>
              </thead>
              <tbody>
                {bestEarners.map((m) => (
                  <tr key={m.ndc11}>
                    <td>
                      <span className="block text-sm">{m.name ?? "—"}</span>
                      <span className="font-mono text-[11px] text-ink-3">{m.ndc11} · {m.unitsDispensed.toLocaleString()} units</span>
                    </td>
                    <td className="text-xs">{m.supplier ?? "—"}{m.rebated === true && <span className="badge badge-ok ml-1">rebated</span>}</td>
                    <td className="num text-sm">{money(m.receivedCents)}</td>
                    <td className="num text-sm">{money(m.costCents)}</td>
                    <td className="num text-sm font-medium text-accent">{money(m.marginCents)}</td>
                    <td className="num text-sm">{m.marginPercent === null ? "—" : `${m.marginPercent}%`}</td>
                    <td className={`num text-xs ${m.vsNadacMicros === null ? "" : m.vsNadacMicros > 0 ? "text-crit" : "text-accent"}`}>
                      {m.vsNadacMicros === null ? "—" : `${m.vsNadacMicros > 0 ? "+" : ""}${perUnit(m.vsNadacMicros)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-ink-3">
            Nothing appears here without a price this pharmacy actually paid and a pack size to convert it by. NADAC is
            what pharmacies on average paid, not what this one paid, so it is never used as the cost side — a margin
            worked out from it would be a statement about somebody else&rsquo;s business.
          </p>
        </Card>
      )}

      {!opps.ready ? (
        <Notice kind="warn">{opps.reason}</Notice>
      ) : (
        <>
          {totalSaving > 0 && (
            <Notice kind="ok">
              {formatCents(totalSaving)} of buying difference across the loaded claims, on products where a cheaper
              source carries the same strength, salt, release profile and dosage form.
            </Notice>
          )}

          <DataTable
            initialSort={{ key: "diff", dir: "desc" }}
            pageSize={25}
            caption={`${opps.rows.length.toLocaleString()} products · sort by any column, filter by name, NDC or supplier`}
            columns={[
              { key: "product", label: "Product" },
              { key: "fills", label: "Fills", align: "right" },
              { key: "paid", label: "We paid / unit", align: "right" },
              { key: "source", label: "Cheapest source" },
              { key: "their", label: "Their price", align: "right" },
              { key: "diff", label: "Difference", align: "right" },
            ]}
            rows={opps.rows.map((r) => ({
              key: r.productKey,
              className: "align-top",
              sort: {
                product: `${r.description} ${r.currentNdc ?? ""}`,
                fills: r.claims,
                paid: r.paidUnitMicros,
                source: r.best ? `${r.best.supplier} ${r.best.ndc11} ${r.best.manufacturer ?? ""}` : null,
                their: r.best?.unitCostMicros ?? null,
                diff: r.savingCents ?? 0,
              },
              cells: {
                product: (
                  <>
                    {r.description}
                    <div className="font-mono text-xs text-ink-3">{r.currentNdc ?? "—"}</div>
                  </>
                ),
                fills: r.claims,
                paid: perUnit(r.paidUnitMicros),
                source: r.best ? (
                  <>
                    <b>{r.best.supplier}</b>
                    <div className="font-mono text-xs text-ink-3">{r.best.ndc11}</div>
                    <div className="text-xs text-ink-3">
                      {r.best.manufacturer ?? "—"}
                      {r.best.contractFlag && ` · ${r.best.contractFlag}`}
                    </div>
                  </>
                ) : (
                  <span className="text-ink-3">no catalogue match</span>
                ),
                their: perUnit(r.best?.unitCostMicros ?? null),
                diff: <span className={(r.savingCents ?? 0) > 0 ? "font-medium text-accent" : "text-ink-3"}>{r.savingCents ? formatCents(r.savingCents) : "—"}</span>,
              },
            }))}
          />
        </>
      )}


      <Card title="How this compares things, and what it will not do" className="mt-8  text-sm">        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">
          <li>
            Only NDCs that match on <b>ingredient, salt, strength, release profile and dosage form</b> are compared.
            Metoprolol succinate is never offered in place of metoprolol tartrate, and an ER tablet is never offered
            in place of an immediate-release one.
          </li>
          <li>
            A product whose description carries no strength — a sensor, a device, a kit — is not matched at all rather
            than matched loosely.
          </li>
          <li>
            The difference is scaled by the quantity actually dispensed, so it is a figure about this pharmacy rather
            than a list-price comparison.
          </li>
          <li>
            <b>The cheapest line is not always the cheapest buy.</b> Purchasing agreements pay rebates on the share of
            volume bought through the primary wholesaler, so moving spend to a secondary can cost more in a lost tier
            than it saves on the invoice. The contract flag is shown where a file carries one; the tier maths is not
            something this can do for you.
          </li>
        </ul>
      </Card>

      <ExportData page="purchasing" className="mt-6" />
    </>
  );
}

/** What each flag means, in the words somebody acting on it would use. */
const MEANS: Record<Flag, string> = {
  buying_above_nadac: "paying over NADAC",
  cheaper_elsewhere: "cheaper elsewhere",
  no_nadac: "no NADAC",
  not_dispensed: "bought, never dispensed",
  short_dated_only: "only short-dated",
  rebate_unknown: "rebate rate not on file",
  pack_size_unknown: "pack size unknown — not compared",
};

