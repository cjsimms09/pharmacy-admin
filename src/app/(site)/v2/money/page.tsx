import Link from "next/link";
import { moneyView } from "@/lib/engine/read";
import { SEED_CATEGORIES } from "@/lib/expense-categories";
import { todayIso } from "@/lib/dates";
import { answerMoneyLine, closeMonthFromMoney } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Money: the month, as the engine left it.
 *
 * Six numbers from month_status; the bank's lines as the matcher placed them, each with why and, where nothing
 * could place it, the answers; the month's proofs and the close; the four weeks ahead. Lookups only
 * (engine/read.ts): the computing happened when the data arrived.
 */

const money = (c: number | null | undefined, signed = false) => (c === null || c === undefined ? "—" : `${signed && c < 0 ? "−" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const monthWord = (m: string) => new Date(Date.parse(`${m}-01T00:00:00Z`)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const dayWord = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

const TABS = [
  ["bank", "Bank"],
  ["cash", "Cash ahead"],
  ["close", "Close"],
] as const;

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{value}</div>
      {sub ? <div className="mt-0.5 text-[12px] text-ink-3">{sub}</div> : null}
    </div>
  );
}

const STATE: Record<string, string> = {
  needs_you: "bg-warn-soft text-warn",
  confirmed: "bg-ground text-ink-3",
  booked: "bg-accent-soft text-accent-strong",
};
const STATE_WORD: Record<string, string> = { needs_you: "open", confirmed: "confirmed", booked: "booked" };

function Answer({ line, month, tab, standing }: { line: { id: string; description: string; amountCents: number }; month: string; tab: string; standing: { name: string; amountCents: number }[] }) {
  const cheque = /^(CHECK|CHQ|CHEQUE|DRAFT)\s*#?\s*\d+$/i.test(line.description.trim());
  const credit = line.amountCents > 0;
  return (
    <form action={answerMoneyLine} className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
      <input type="hidden" name="month" value={month} />
      <input type="hidden" name="tab" value={tab} />
      <input type="hidden" name="bankLineId" value={line.id} />
      <select name="action" className="rounded-md border border-line bg-surface px-2 py-1" defaultValue={credit ? "deposit" : cheque ? "cheque" : "books_bill"}>
        {credit ? <option value="deposit">A deposit from a named payer</option> : null}
        {!credit && cheque ? <option value="cheque">A cheque to a payee, under a category</option> : null}
        {!credit && cheque ? <option value="standing">A standing cost, paid by cheque</option> : null}
        {!credit && !cheque ? <option value="books_bill">A cost, under a category</option> : null}
        <option value="before_books">Predates the books</option>
        {!credit ? <option value="noted">Note it and stop asking</option> : null}
      </select>
      {!credit ? (
        <>
          <select name="category" className="rounded-md border border-line bg-surface px-2 py-1" defaultValue="">
            <option value="">category…</option>
            {SEED_CATEGORIES.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <input name="vendor" placeholder="payee" className="w-40 rounded-md border border-line bg-surface px-2 py-1" />
          {cheque ? (
            <select name="standing" className="rounded-md border border-line bg-surface px-2 py-1" defaultValue="">
              <option value="">standing cost…</option>
              {standing.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} ({money(s.amountCents)})
                </option>
              ))}
            </select>
          ) : null}
        </>
      ) : (
        <input name="payer" placeholder="payer" className="w-40 rounded-md border border-line bg-surface px-2 py-1" />
      )}
      <input name="note" placeholder="why, in a few words (optional)" className="w-56 rounded-md border border-line bg-surface px-2 py-1" />
      <button type="submit" className="rounded-md bg-accent px-3 py-1 font-medium text-white hover:bg-accent-strong">
        Answer
      </button>
    </form>
  );
}

export default async function MoneyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const today = todayIso();
  const tab = (typeof sp.tab === "string" ? sp.tab : "bank") as (typeof TABS)[number][0];
  const error = typeof sp.error === "string" ? sp.error : null;
  const requested = typeof sp.month === "string" ? sp.month : null;
  const v0 = await moneyView(requested ?? today.slice(0, 7));
  /* Open on the last month with a statement unless a month was asked for: the current month has no bank lines until its statement comes. */
  const month = requested ?? (v0.month && v0.month.bankLines > 0 ? v0.month.month : v0.months.find((m) => m < today.slice(0, 7)) ?? today.slice(0, 7));
  const v = month === (requested ?? today.slice(0, 7)) ? v0 : await moneyView(month);
  const m = v.month;
  const open = v.lines.filter((l) => l.state === "needs_you");
  const next7 = v.cashAhead.filter((d) => d.day > today && d.day <= new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 864e5).toISOString().slice(0, 10));
  const due7 = next7.reduce((n, d) => n + d.outflowCents, 0);
  const lowest = v.cashAhead.length ? v.cashAhead.reduce((a, b) => (b.balanceCents < a.balanceCents ? b : a)) : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[18px] font-semibold text-ink">{monthWord(month)}</h1>
        <nav className="flex items-center gap-1 text-[13px]">
          {v.months.map((mm) => (
            <Link key={mm} href={`/v2/money?month=${mm}&tab=${tab}`} className={`rounded-md px-2 py-1 ${mm === month ? "bg-ink text-surface" : "text-ink-2 hover:bg-ground"}`}>
              {mm}
            </Link>
          ))}
        </nav>
        {m ? <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${m.closeState === "closed" ? "bg-accent-soft text-accent-strong" : m.closeState === "ready" ? "bg-warn-soft text-warn" : "bg-ground text-ink-3"}`}>{m.closeState}</span> : null}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Figure label="Opening" value={money(m?.bankOpeningCents)} sub="the statement's own" />
        <Figure label="In" value={money(m?.bankInCents)} sub={`${m?.bankLines ?? 0} lines`} />
        <Figure label="Out" value={money(m?.bankOutCents)} sub={open.length ? `${open.length} open` : "all placed"} />
        <Figure label="Closing" value={money(m?.bankClosingCents)} sub={m?.bankClosingCents !== null && m?.bankOpeningCents !== null && m ? (m.bankOpeningCents + (m.bankInCents ?? 0) - (m.bankOutCents ?? 0) === m.bankClosingCents ? "proven to the cent" : "does not prove") : "no statement"} />
        <Figure label="Receipts to bank" value={money(m?.receiptsGapCents, true)} sub={m?.receiptsGapSays ? "every dollar named" : "—"} />
        <Figure label="Due in 7 days" value={money(due7)} sub={lowest ? `lowest ahead ${money(lowest.balanceCents, true)} on ${lowest.day}` : "no projection"} />
      </div>

      <nav className="flex items-center gap-1 border-b border-line text-[14px]">
        {TABS.map(([key, label]) => (
          <Link key={key} href={`/v2/money?month=${month}&tab=${key}`} className={`-mb-px border-b-2 px-3 py-2 ${tab === key ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}>
            {label}
          </Link>
        ))}
        <span className="ml-auto flex items-center gap-2 text-[13px] text-ink-3">
          <Link href="/inventory/invoices" className="hover:text-ink">Suppliers</Link>·<Link href="/remits" className="hover:text-ink">Remits</Link>·<Link href="/expenses" className="hover:text-ink">Spending</Link>·<Link href="/deliveries" className="hover:text-ink">Deliveries</Link>
        </span>
      </nav>

      {error ? <p className="rounded-md bg-crit-soft px-3 py-2 text-[13px] text-crit">{error}</p> : null}

      {tab === "bank" ? (
        <section className="rounded-lg border border-line bg-surface px-4 py-2">
          {v.lines.length === 0 ? (
            <p className="py-4 text-[14px] text-ink-2">No bank statement is on file for {monthWord(month)}. When it is forwarded, every line is placed and proven here.</p>
          ) : (
            <ul>
              {[...v.lines].sort((a, b) => (a.state === b.state ? a.on.localeCompare(b.on) : a.state === "needs_you" ? -1 : b.state === "needs_you" ? 1 : 0)).map((l) => (
                <li key={l.id} className="border-b border-line py-2.5 last:border-b-0">
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${STATE[l.state]}`}>{STATE_WORD[l.state]}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] text-ink">
                        <span className="tabular-nums text-ink-3">{l.on}</span> · {l.description.replace(/\s+/g, " ").trim().slice(0, 70)}
                      </div>
                      {l.why ? <div className="mt-0.5 text-[12.5px] text-ink-2">{l.why.length > 260 ? `${l.why.slice(0, 257)}…` : l.why}</div> : null}
                      {l.state === "needs_you" ? <Answer line={l} month={month} tab={tab} standing={v.standing} /> : null}
                    </div>
                    <div className={`shrink-0 text-[14px] tabular-nums ${l.amountCents < 0 ? "text-ink" : "text-accent-strong"}`}>{money(l.amountCents, true)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {tab === "cash" ? (
        <section className="space-y-3">
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            {v.cashAhead.length === 0 ? (
              <p className="py-4 text-[14px] text-ink-2">Nothing to project yet: a bank statement has to be placed first.</p>
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-ink-3">
                    <th className="py-2 font-medium">Day</th>
                    <th className="py-2 text-right font-medium">In</th>
                    <th className="py-2 text-right font-medium">Out</th>
                    <th className="py-2 text-right font-medium">Balance</th>
                    <th className="py-2 pl-4 font-medium">What moves it</th>
                  </tr>
                </thead>
                <tbody>
                  {v.cashAhead.map((d) => {
                    const items = (d.items ? (JSON.parse(d.items) as { kind: string; cents: number; label: string }[]) : []).filter((i) => i.cents >= 50_000).slice(0, 4);
                    const low = lowest && d.day === lowest.day;
                    return (
                      <tr key={d.day} className={`border-t border-line ${d.day <= today ? "text-ink-3" : "text-ink"} ${low ? "bg-warn-soft" : ""}`}>
                        <td className="py-1.5 tabular-nums">{dayWord(d.day)}{d.day <= today ? " (no statement yet)" : ""}</td>
                        <td className="py-1.5 text-right tabular-nums">{d.inflowCents ? money(d.inflowCents) : ""}</td>
                        <td className="py-1.5 text-right tabular-nums">{d.outflowCents ? money(d.outflowCents) : ""}</td>
                        <td className={`py-1.5 text-right tabular-nums font-medium ${d.balanceCents < 0 ? "text-crit" : ""}`}>{money(d.balanceCents, true)}</td>
                        <td className="py-1.5 pl-4 text-[12px] text-ink-2">{items.map((i) => `${i.kind === "in" ? "+" : "−"}${money(i.cents)} ${i.label}`).join(" · ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          {v.cashAssumptions ? (
            <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[12.5px] text-ink-2">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">How this is projected</div>
              <ul className="list-disc space-y-0.5 pl-5">
                {v.cashAssumptions.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {tab === "close" ? (
        <section className="space-y-3">
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            <h2 className="py-2 text-[13px] font-medium uppercase tracking-wide text-ink-3">The month's proofs</h2>
            {v.proofs.length === 0 ? (
              <p className="py-3 text-[13px] text-ink-2">Not run yet for this month.</p>
            ) : (
              <ul className="text-[13px]">
                {v.proofs.map((p) => (
                  <li key={p.proof} className="flex items-start gap-2 border-b border-line py-2 last:border-b-0">
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${p.passed ? "bg-accent-soft text-accent-strong" : "bg-crit-soft text-crit"}`}>{p.passed ? "proven" : "not yet"}</span>
                    <span className="text-ink">{p.says}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            <h2 className="py-2 text-[13px] font-medium uppercase tracking-wide text-ink-3">What still needs you</h2>
            {open.length === 0 ? (
              <p className="py-3 text-[13px] text-ink-2">Nothing. Every line is placed.</p>
            ) : (
              <ul>
                {open.map((l) => (
                  <li key={l.id} className="border-b border-line py-2.5 last:border-b-0">
                    <div className="text-[14px] text-ink">
                      <span className="tabular-nums text-ink-3">{l.on}</span> · {l.description.replace(/\s+/g, " ").trim().slice(0, 70)} · <span className="tabular-nums">{money(l.amountCents, true)}</span>
                    </div>
                    <Answer line={l} month={month} tab={tab} standing={v.standing} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <form action={closeMonthFromMoney} className="flex items-center gap-3">
            <input type="hidden" name="month" value={month} />
            <button type="submit" disabled={m?.closeState !== "ready"} className="rounded-md bg-accent px-4 py-2 text-[14px] font-medium text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40">
              {m?.closeState === "closed" ? `Closed ${m.closedAt?.slice(0, 10) ?? ""}` : `Close ${monthWord(month)}`}
            </button>
            <span className="text-[13px] text-ink-3">{m?.closeState === "ready" ? "Every line placed, every proof passed." : m?.closeState === "closed" ? "" : "Closes when every line is placed and the month has ended."}</span>
          </form>
        </section>
      ) : null}
    </div>
  );
}
