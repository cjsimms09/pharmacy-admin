import Link from "next/link";
import type { SuppliersView, RemitsView, SpendingView, DeliveriesView, PackView } from "@/lib/engine/read";
import type { OrderFrom } from "@/lib/engine/order-from";
import { atLocal } from "@/lib/dates";

/**
 * The Money tabs that are lookups and nothing else: Suppliers, Order from, Remits, Spending, Deliveries. Each is a
 * server component over one view from engine/read.ts. No answers here yet; the answers a supplier or a remittance
 * needs arrive with stage 3 (Claims) and the supplier statement work.
 */

const money = (c: number | null | undefined, signed = false) => (c === null || c === undefined ? "—" : `${signed && c < 0 ? "−" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const th = "py-2 text-left text-[11px] font-medium uppercase tracking-wide text-ink-3";
const thr = `${th} text-right`;
const td = "border-t border-line py-1.5 text-[13px] text-ink";
const tdr = `${td} text-right tabular-nums`;

export function SuppliersTab({ v, month }: { v: SuppliersView; month: string }) {
  return (
    <section className="space-y-3">
      <div className="rounded-lg border border-line bg-surface px-4 py-2">
        {v.suppliers.length === 0 ? (
          <p className="py-4 text-[14px] text-ink-2">No supplier invoices dated in this month are on file.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>Supplier</th>
                <th className={thr}>Invoices</th>
                <th className={thr}>Billed</th>
                <th className={thr}>Not yet settled</th>
                <th className={th}>Oldest unsettled</th>
                <th className={th}>Next draw</th>
                <th className={th}>Statements</th>
              </tr>
            </thead>
            <tbody>
              {v.suppliers.map((s) => (
                <tr key={s.supplier}>
                  <td className={td}>
                    <Link href={`/inventory/invoices?supplier=${encodeURIComponent(s.supplier)}&month=${month}`} className="hover:underline">
                      {s.supplier}
                    </Link>
                    {s.controlled ? <span className="ml-2 rounded bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn">{s.controlled} C-II</span> : null}
                  </td>
                  <td className={tdr}>{s.invoices}</td>
                  <td className={tdr}>{money(s.totalCents)}</td>
                  <td className={tdr}>{s.openInvoices ? `${money(s.openCents)} (${s.openInvoices})` : "—"}</td>
                  <td className={td}>{s.oldestOpen ?? "—"}</td>
                  <td className={td}>{s.nextDraw ? `${s.nextDraw.dueOn} · ${money(s.nextDraw.cents)} · ${s.nextDraw.invoices} invoices, statement of ${s.nextDraw.statementDate}` : "no statement names one"}</td>
                  <td className={td}>{s.statements ? `${s.statements}, last ${s.lastStatement}` : "none"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-[12.5px] text-ink-3">Billed is the month&apos;s invoices as filed: cost of goods on the accrual side. Not yet settled means no bank draw, statement line or credit memo on file has paid the invoice; for McKesson that is mostly invoices not yet due, for IPD it is invoices its next statement will offset against a credit. The draws themselves are on Bank and Cash ahead; a statement of account names the next draw and its day.</p>
    </section>
  );
}

export function OrderFromTab({ v }: { v: OrderFrom | null }) {
  if (!v) return <p className="rounded-lg border border-line bg-surface px-4 py-4 text-[14px] text-ink-2">Not computed yet. The engine works this out on its nightly pass from the buy list, the shelf&apos;s movement and each supplier&apos;s contract.</p>;
  /* Only the suppliers with something on today's list or something worth adding; the rest are named in one line. */
  const live = v.suppliers.filter((s) => s.basketCents > 0 || s.picks.length > 0 || s.candidates > 0);
  const quiet = v.suppliers.length - live.length;
  return (
    <section className="space-y-3">
      {live.map((s) => (
        <div key={s.supplier} className="rounded-lg border border-line bg-surface px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <h3 className="text-[15px] font-semibold text-ink">{s.supplier}</h3>
            <span className="text-[13px] text-ink-2">
              ordering today {money(s.basketCents)}
              {s.minimumCents !== null ? ` · minimum ${money(s.minimumCents)}` : " · no minimum on file"}
              {s.shortfallCents > 0 ? ` · ${money(s.shortfallCents)} short` : s.meets ? " · met" : ""}
            </span>
          </div>
          <p className="mt-1 text-[12.5px] text-ink-2">{s.says}</p>
          {s.picks.length ? (
            <table className="mt-2 w-full">
              <thead>
                <tr>
                  <th className={th}>Add</th>
                  <th className={thr}>Packs</th>
                  <th className={thr}>Cost</th>
                  <th className={thr}>Saves</th>
                  <th className={thr}>Days of stock after</th>
                  <th className={th}>Why</th>
                </tr>
              </thead>
              <tbody>
                {s.picks.map((p) => (
                  <tr key={p.ndc11}>
                    <td className={td}>{p.name ?? p.ndc11}</td>
                    <td className={tdr}>{p.packs} × {p.packQty}</td>
                    <td className={tdr}>{money(p.costCents)}</td>
                    <td className={tdr}>{money(p.savingCents)}</td>
                    <td className={tdr}>{p.daysOfStockAfter}</td>
                    <td className={`${td} text-[12px] text-ink-2`}>{p.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : s.shortfallCents > 0 ? (
            <p className="mt-1 text-[12.5px] text-ink-3">Nothing worth adding: {s.candidates} candidates, {s.leftOut.notGeneric} not generic, {s.leftOut.controlled} controlled, {s.leftOut.unknownClass} of unknown class.</p>
          ) : null}
        </div>
      ))}
      <p className="text-[12.5px] text-ink-3">
        Computed {atLocal(v.computedAt)} from {v.evidence.days} days of dispensing ({v.evidence.from} to {v.evidence.to}), a {v.horizonDays}-day horizon.{quiet ? ` ${quiet} other suppliers have nothing on today's list and nothing worth adding.` : ""}{v.missing.length ? ` Missing: ${v.missing.join("; ")}.` : ""}
      </p>
    </section>
  );
}

export function RemitsTab({ v }: { v: RemitsView }) {
  return (
    <section className="space-y-3">
      <div className="rounded-lg border border-line bg-surface px-4 py-2">
        <div className="flex flex-wrap gap-4 py-2 text-[13px] text-ink-2">
          <span>{v.remits.length} remittances, {money(v.totalCents)}</span>
          <span>at the bank {money(v.bankedCents)}</span>
          <span>not yet {money(v.totalCents - v.bankedCents)}</span>
        </div>
        {v.remits.length === 0 ? (
          <p className="py-3 text-[14px] text-ink-2">No remittances in the register for this month.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>Remitted</th>
                <th className={th}>Payer</th>
                <th className={thr}>Amount</th>
                <th className={th}>Payment no.</th>
                <th className={th}>At the bank</th>
              </tr>
            </thead>
            <tbody>
              {v.remits.map((r) => (
                <tr key={r.id}>
                  <td className={`${td} tabular-nums`}>{r.remitOn}</td>
                  <td className={td}>{r.payer}</td>
                  <td className={tdr}>{money(r.amountCents)}</td>
                  <td className={`${td} tabular-nums text-ink-3`}>{r.paymentNumber ? `…${r.paymentNumber.slice(-6)}` : "not yet"}</td>
                  <td className={td}>{r.banked ? <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent-strong">banked · by {r.banked}</span> : <span className="rounded bg-ground px-1.5 py-0.5 text-[11px] text-ink-3">waiting</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {v.mtf.length ? (
        <div className="rounded-lg border border-line bg-surface px-4 py-2">
          <h3 className="py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">Medicare facilitator, by day</h3>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pb-2 text-[13px] text-ink">
            {v.mtf.map((m) => (
              <span key={m.day} className="tabular-nums">
                {m.day.slice(5)} {money(m.cents)}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <p className="text-[12.5px] text-ink-3">A remittance is never new revenue: it settles claims already counted at pickup. Banked means a receipt on file stands for it: the payment report or the 835 carries its payment number, or the same amount arrived within a fortnight, each receipt standing for one remittance only. Waiting means no receipt does: the money has not landed, or its payment report has not been pulled.</p>
    </section>
  );
}

function CategoryRows({ rows }: { rows: SpendingView["categories"] }) {
  return (
    <table className="w-full">
      <tbody>
        {rows.map((c) => (
          <tr key={c.category}>
            <td className={td}>{c.category}</td>
            <td className={`${td} text-[12px] text-ink-3`}>{c.bills}</td>
            <td className={tdr}>{money(c.cents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SpendingTab({ v }: { v: SpendingView }) {
  const costs = v.categories.filter((c) => c.kind !== "balance_sheet");
  const notCosts = v.categories.filter((c) => c.kind === "balance_sheet");
  const sum = (xs: { cents: number }[]) => xs.reduce((n, c) => n + c.cents, 0);
  return (
    <section className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface px-4 py-2">
          <h3 className="py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">Costs · {money(sum(costs))}</h3>
          <CategoryRows rows={costs} />
          {notCosts.length ? (
            <>
              <h3 className="pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-ink-3">Paid, not a cost · {money(sum(notCosts))}</h3>
              <CategoryRows rows={notCosts} />
            </>
          ) : null}
        </div>
        <div className="rounded-lg border border-line bg-surface px-4 py-2">
          <h3 className="py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">Standing costs</h3>
          <table className="w-full">
            <tbody>
              {v.standing.map((s) => (
                <tr key={s.name}>
                  <td className={td}>{s.name}</td>
                  <td className={`${td} text-[12px] text-ink-3`}>{s.paidDay ? `the ${s.paidDay}th` : ""}</td>
                  <td className={tdr}>{money(s.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="rounded-lg border border-line bg-surface px-4 py-2">
        <h3 className="py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">Bills</h3>
        {v.bills.length === 0 ? (
          <p className="py-3 text-[13px] text-ink-2">No bills dated in this month.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>Date</th>
                <th className={th}>Payee</th>
                <th className={th}>Category</th>
                <th className={th}>What</th>
                <th className={thr}>Amount</th>
                <th className={th}>Paid</th>
              </tr>
            </thead>
            <tbody>
              {v.bills.map((b) => (
                <tr key={b.id}>
                  <td className={`${td} tabular-nums`}>{b.invoiceDate}</td>
                  <td className={td}>{b.vendor ?? "—"}</td>
                  <td className={td}>{b.category ?? "—"}</td>
                  <td className={`${td} text-[12px] text-ink-2`}>{(b.description ?? "").slice(0, 60)}</td>
                  <td className={tdr}>{money(b.amountCents, true)}</td>
                  <td className={`${td} tabular-nums text-ink-3`}>{b.paidOn ?? "open"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-[12.5px] text-ink-3">Costs are the month&apos;s bills and its standing costs, by category. Loan principal and sales tax remitted are money out but not costs: one repays a balance owed, the other was the customer&apos;s. Drug purchases are cost of goods, on Suppliers; the bank line that paid each bill is on Bank. <Link href="/expenses" className="hover:underline">The old Spending page</Link> still holds the vendor rules until they move here.</p>
    </section>
  );
}

export function DeliveriesTab({ v }: { v: DeliveriesView }) {
  return (
    <section className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["Days entered", `${v.entered} of ${v.weekdays}`],
          ["Deliveries", String(v.deliveries)],
          ["Mail trips", String(v.mailTrips)],
          ["Invoice", money(v.totalCents)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-line bg-surface px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
            <div className="mt-1 text-[20px] font-semibold tabular-nums text-ink">{value}</div>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-ink-2">
        {v.invoice ? (
          <p>
            Driver invoice {v.invoice.number ?? ""}: <span className="text-ink">{v.invoice.status}</span>
            {v.invoice.sentAt ? `, sent ${v.invoice.sentAt.slice(0, 10)}${v.invoice.sentTo ? ` to ${v.invoice.sentTo}` : ""}` : ""}
            {v.changedSinceSent ? " — the days have changed since it was sent." : ""}
          </p>
        ) : (
          <p>No invoice issued yet for this month{v.complete ? "; every weekday is entered, so it can be." : `; ${v.missing.length} weekday${v.missing.length === 1 ? "" : "s"} still to enter.`}</p>
        )}
        <p className="mt-1">
          <Link href="/deliveries" className="hover:underline">Enter today&apos;s deliveries</Link> · {v.trips} trips at {money(v.rateCents)}.
        </p>
      </div>
    </section>
  );
}

function PL({ title, pl }: { title: string; pl: PackView["accrual"] }) {
  if (!pl) return <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-ink-2">{title}: not computed.</div>;
  const row = (label: string, cents: number, strong = false) => (
    <tr key={label}>
      <td className={`${td} ${strong ? "font-medium" : ""}`}>{label}</td>
      <td className={`${tdr} ${strong ? "font-medium" : ""}`}>{money(cents, true)}</td>
    </tr>
  );
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-2">
      <h3 className="py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">{title}</h3>
      <table className="w-full">
        <tbody>
          {row("Revenue", pl.revenueCents)}
          {pl.offsets.map((l) => row(`  less ${l.label}`, -l.amountCents))}
          {row("Net revenue", pl.netRevenueCents, true)}
          {pl.costOfGoods.map((l) => row(`  ${l.label}`, -l.amountCents))}
          {row(`Gross profit${pl.grossMarginPercent !== null ? ` (${pl.grossMarginPercent.toFixed(1)}%)` : ""}`, pl.grossProfitCents, true)}
          {pl.operating.map((l) => row(`  ${l.label}`, -l.amountCents))}
          {row("Net profit", pl.netProfitCents, true)}
          {pl.otherCashOut.length ? pl.otherCashOut.map((l) => row(`  ${l.label} (not a cost)`, -l.amountCents)) : null}
          {pl.cashChangeCents !== null ? row("Cash change", pl.cashChangeCents, true) : null}
        </tbody>
      </table>
    </div>
  );
}

export function PackTab({ v, monthWord }: { v: PackView; monthWord: string }) {
  const f = v.figures;
  const tone = (s: string) => (s === "agrees" || s === "received" ? "bg-accent-soft text-accent-strong" : s === "not_yet_due" || s === "estimated" || s === "stated" ? "bg-ground text-ink-2" : s === "not_measured" || s === "no_rate" ? "bg-ground text-ink-3" : "bg-warn-soft text-warn");
  return (
    <section className="space-y-3 print:space-y-2">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-[16px] font-semibold text-ink">Month-end pack · {monthWord}</h2>
        <span className="text-[12px] text-ink-3">{v.closedAt ? `closed ${v.closedAt.slice(0, 10)}` : "not closed"} · for printing; it goes nowhere else</span>
      </div>
      <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">The bank</h3>
        {f && f.bankLines > 0 ? (
          <p className="mt-1 text-ink">
            Opening {money(f.bankOpeningCents)} + {money(f.bankInCents)} in − {money(f.bankOutCents)} out = closing {money(f.bankClosingCents)}, {f.bankLines} lines, {f.bankOpenLines} open. Receipts {money(f.receiptsCents)} against the bank: {f.receiptsGapSays ?? "gap unexplained"}.
          </p>
        ) : (
          <p className="mt-1 text-ink-2">No bank statement on file for the month.</p>
        )}
        <ul className="mt-2 space-y-0.5 text-[12.5px]">
          {v.proofs.map((p) => (
            <li key={p.proof} className="flex items-start gap-2">
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${p.passed ? "bg-accent-soft text-accent-strong" : "bg-crit-soft text-crit"}`}>{p.passed ? "proven" : "not yet"}</span>
              <span className="text-ink-2">{p.says}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <PL title="The accrual account" pl={v.accrual} />
        <PL title="The cash account" pl={v.cash} />
      </div>
      {v.bridge.bankChangeCents !== null && v.bridge.cashChangeCents !== null ? (
        <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">The bank is not the cash account</h3>
          <p className="mt-1 text-ink">
            The bank moved {money(v.bridge.bankChangeCents, true)} over the month; the cash account says {money(v.bridge.cashChangeCents, true)}. By your rule, what the bank paid for purchases made before the books began is counted on neither basis: {money(v.bridge.beforeBooksCents, true)} this month.
            {v.bridge.unplacedCents ? ` ${money(v.bridge.unplacedCents, true)} is on lines not yet placed.` : ""}
            {v.bridge.notedCents ? ` ${money(v.bridge.notedCents, true)} is noted and not booked.` : ""}
            {v.bridge.receiptsGapCents ? ` Receipts the bank has not seen yet: ${money(v.bridge.receiptsGapCents, true)}, named above.` : ""}
            {(() => {
              const named = v.bridge.cashChangeCents! + v.bridge.beforeBooksCents + v.bridge.unplacedCents + v.bridge.notedCents - (v.bridge.receiptsGapCents ?? 0);
              const rest = v.bridge.bankChangeCents! - named;
              return Math.abs(rest) >= 100 ? ` ${money(rest, true)} between the two is not named by any of those.` : " Those name the whole difference.";
            })()}
          </p>
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">The payers, on the month&apos;s fills</h3>
          <p className="mt-1 text-ink">
            {v.claims.legs} claim legs; {v.claims.paidLegs} paid; {money(v.claims.owedCents)} still owed, of which {money(v.claims.dueCents)} past its plan&apos;s cycle; {v.claims.shortLegs} paid short, {money(v.claims.shortCents)}.
          </p>
        </div>
        <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Compliance at month end</h3>
          <p className="mt-1 text-ink">
            {v.compliance.missed} duties missed, {v.compliance.partial} partly done. CQI {v.compliance.cqi}. Controlled substances: {v.compliance.cs}.
          </p>
        </div>
      </div>
      <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Sales tax</h3>
        <p className="mt-1 flex items-start gap-2 text-ink">
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${tone(v.salesTax.state)}`}>{v.salesTax.state.replace(/_/g, " ")}</span>
          <span>{v.salesTax.says}</span>
        </p>
      </div>
      <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Wholesaler rebates</h3>
        {v.rebates.length === 0 ? <p className="mt-1 text-ink-2">No purchases on file for the month.</p> : null}
        {v.rebates.map((r) => (
          <p key={r.supplierId} className="mt-1 flex items-start gap-2 text-ink">
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${tone(r.state)}`}>{r.state.replace(/_/g, " ")}</span>
            <span>{r.says}</span>
          </p>
        ))}
      </div>
      <p className="text-[12.5px] text-ink-3">Still open across the site: {v.open.bankLines} bank lines this month, {v.open.questions} questions on Today. Everything above is what the engine already proved; nothing is computed on this page.</p>
    </section>
  );
}
