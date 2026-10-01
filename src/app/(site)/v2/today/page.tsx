import Link from "next/link";
import { todayView, type TodayLine } from "@/lib/engine/read";
import { RANK_WORDS, type Rank } from "@/lib/engine/rank";
import { SEED_CATEGORIES } from "@/lib/expense-categories";
import { todayIso } from "@/lib/dates";
import { answerBankLine, rereadDocument, acknowledgeLine, closeMonthAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Today: six numbers and the one list.
 *
 * Four reads, all against the engine's tables (src/lib/engine/read.ts). Nothing on this page computes; the figures
 * were written when the data arrived and proven overnight, and each links to the rows behind it. A line is one
 * sentence and the answers that fit it. docs/REBUILD.md.
 */

const money = (c: number | null | undefined) => (c === null || c === undefined ? "—" : `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const monthWord = (m: string) => new Date(Date.parse(`${m}-01T00:00:00Z`)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never");

const CHIP: Record<Rank, string> = {
  1: "bg-crit-soft text-crit",
  2: "bg-warn-soft text-warn",
  3: "bg-accent-soft text-accent-strong",
  4: "bg-ground text-ink-2",
  5: "bg-ground text-ink-3",
};

function Figure({ label, value, sub, href }: { label: string; value: string; sub?: string; href?: string }) {
  const body = (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{value}</div>
      {sub ? <div className="mt-0.5 text-[12px] text-ink-3">{sub}</div> : null}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function BankAnswer({ line }: { line: TodayLine }) {
  const rows = (line.rows ?? {}) as { bankLineId?: string };
  const actions = line.answers.map((a) => a.action);
  const categories = SEED_CATEGORIES.map((c) => c.name);
  return (
    <form action={answerBankLine} className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
      <input type="hidden" name="lineId" value={line.id} />
      <input type="hidden" name="bankLineId" value={rows.bankLineId ?? ""} />
      <select name="action" className="rounded-md border border-line bg-surface px-2 py-1" defaultValue={actions[0]}>
        {line.answers.map((a) => (
          <option key={a.action} value={a.action}>
            {a.label}
          </option>
        ))}
      </select>
      {actions.includes("books_bill") || actions.includes("cheque") ? (
        <>
          <select name="category" className="rounded-md border border-line bg-surface px-2 py-1" defaultValue="">
            <option value="">category…</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input name="vendor" placeholder="payee" className="w-40 rounded-md border border-line bg-surface px-2 py-1" />
        </>
      ) : null}
      {actions.includes("deposit") ? <input name="payer" placeholder="payer" className="w-40 rounded-md border border-line bg-surface px-2 py-1" /> : null}
      <input name="note" placeholder="why, in a few words (optional)" className="w-64 rounded-md border border-line bg-surface px-2 py-1" />
      <button type="submit" className="rounded-md bg-accent px-3 py-1 font-medium text-white hover:bg-accent-strong">
        Answer
      </button>
    </form>
  );
}

function Line({ line }: { line: TodayLine }) {
  const rank = line.rank as Rank;
  const rows = (line.rows ?? {}) as { inboxItemId?: string; month?: string };
  /* "Looked, leave it" is offered where leaving it is a legitimate answer: never on a patient or board matter. */
  const ack = line.kind === "feed_overdue" || line.kind === "claims_unmeasured" || line.kind === "claims_due" || line.kind === "proof_failed" || (line.kind === "alert" && rank >= 3);
  return (
    <li className="border-b border-line py-3 last:border-b-0">
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${CHIP[rank]}`}>{RANK_WORDS[rank]}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] text-ink">{line.href ? <Link href={line.href} className="hover:underline">{line.title}</Link> : line.title}</div>
          {line.detail ? <div className="mt-0.5 text-[13px] text-ink-2">{line.detail}</div> : null}
          {line.kind === "bank_line" ? <BankAnswer line={line} /> : null}
          {line.kind === "document_held" ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
              <form action={rereadDocument}>
                <input type="hidden" name="itemId" value={rows.inboxItemId ?? ""} />
                <button type="submit" className="rounded-md border border-line bg-surface px-3 py-1 hover:bg-ground">
                  Read it again
                </button>
              </form>
              <Link href={line.href ?? "/inbox"} className="rounded-md border border-line bg-surface px-3 py-1 hover:bg-ground">
                Say what it is
              </Link>
            </div>
          ) : null}
          {line.kind === "close" && line.answers.some((a) => a.action === "close_month") ? (
            <form action={closeMonthAction} className="mt-2">
              <input type="hidden" name="lineId" value={line.id} />
              <input type="hidden" name="month" value={rows.month ?? ""} />
              <button type="submit" className="rounded-md bg-accent px-3 py-1 text-[13px] font-medium text-white hover:bg-accent-strong">
                Close {rows.month}
              </button>
            </form>
          ) : null}
          {ack ? (
            <form action={acknowledgeLine} className="mt-2 flex items-center gap-2 text-[13px]">
              <input type="hidden" name="lineId" value={line.id} />
              <input type="hidden" name="what" value={line.title} />
              {line.href ? (
                <Link href={line.href} className="rounded-md border border-line bg-surface px-3 py-1 hover:bg-ground">
                  {line.answers[0]?.label ?? "Open"}
                </Link>
              ) : null}
              <button type="submit" className="rounded-md border border-line bg-surface px-3 py-1 text-ink-2 hover:bg-ground">
                Looked, leave it
              </button>
            </form>
          ) : null}
        </div>
        {line.amountCents ? <div className="shrink-0 text-[14px] tabular-nums text-ink-2">{money(line.amountCents)}</div> : null}
      </div>
    </li>
  );
}

export default async function TodayPage() {
  const v = await todayView();
  const today = todayIso();
  const thisMonth = v.months.find((m) => m.month === today.slice(0, 7));
  const proven = [...v.months].sort((a, b) => b.month.localeCompare(a.month)).find((m) => m.bankClosingCents !== null && m.bankLines > 0);
  const arDue = v.months.reduce((n, m) => n + (m.arDueCents ?? 0), 0);
  const feedsLate = v.feeds.filter((f) => f.state === "overdue" || f.state === "never_arrived");
  const compliance = v.lines.filter((l) => l.rank <= 2).length;
  const notArriving = v.feeds.filter((f) => f.state !== "arriving" && f.state !== "not_expected" && f.state !== "not_yet_due");

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Figure label="Needs you" value={String(v.lines.length)} sub={v.lines.length === 0 ? "nothing" : `${compliance} compliance`} />
        <Figure label="Cash in bank" value={money(proven?.bankClosingCents)} sub={proven ? `proven ${proven.month}` : "no statement yet"} href={proven ? `/money/bank-review?month=${proven.month}` : "/money"} />
        <Figure label={`Revenue, ${thisMonth ? monthWord(thisMonth.month) : "this month"}`} value={money(thisMonth?.accrualRevenueCents)} sub="at pickup, accrual" href="/claims" />
        <Figure label="AR due" value={money(arDue)} sub="past the payer's own cycle" href="/payers/waiting" />
        <Figure label="Feeds overdue" value={String(feedsLate.length)} sub={`${v.feeds.length} watched`} href="/expected" />
        <Figure label="Compliance due" value={String(compliance)} sub="board, DEA, patients" href="/compliance" />
      </div>

      <section className="rounded-lg border border-line bg-surface px-4 py-2">
        <h2 className="py-2 text-[13px] font-medium uppercase tracking-wide text-ink-3">Needs you</h2>
        {v.lines.length === 0 ? (
          <p className="py-4 text-[14px] text-ink-2">Nothing. Every line is placed, every feed has arrived, every duty is inside its date.</p>
        ) : (
          <ul>
            {v.lines.map((l) => (
              <Line key={l.id} line={l} />
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-line bg-surface px-4 py-2">
          <h2 className="py-2 text-[13px] font-medium uppercase tracking-wide text-ink-3">Running</h2>
          {notArriving.length === 0 ? (
            <p className="py-3 text-[13px] text-ink-2">Every feed is arriving on its own calendar.</p>
          ) : (
            <ul className="text-[13px]">
              {notArriving.map((f) => (
                <li key={f.key} className="flex items-start gap-2 border-b border-line py-2 last:border-b-0">
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${f.state === "overdue" ? "bg-warn-soft text-warn" : "bg-ground text-ink-3"}`}>{f.state.replace("_", " ")}</span>
                  <span className="text-ink">
                    {f.name}
                    {f.says ? <span className="text-ink-3"> — {f.says}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="rounded-lg border border-line bg-surface px-4 py-2">
          <h2 className="py-2 text-[13px] font-medium uppercase tracking-wide text-ink-3">Proofs</h2>
          {v.proofs.length === 0 ? (
            <p className="py-3 text-[13px] text-ink-2">Not run yet. The engine proves the books every night after two.</p>
          ) : (
            <ul className="text-[13px]">
              {v.proofs.map((p) => (
                <li key={`${p.proof}|${p.scope ?? ""}`} className="flex items-start gap-2 border-b border-line py-2 last:border-b-0">
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${p.passed ? "bg-accent-soft text-accent-strong" : "bg-crit-soft text-crit"}`}>{p.passed ? "proven" : "not yet"}</span>
                  <span className="text-ink">{p.says}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="py-2 text-[12px] text-ink-3">
            Engine last ran {when(v.engine.lastRun)}; last full proof {when(v.engine.lastRebuild)}.{v.engine.error ? ` Last error: ${v.engine.error}` : ""}
          </p>
        </section>
      </div>
    </div>
  );
}
