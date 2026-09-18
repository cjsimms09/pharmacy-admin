import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { moneyWaitingNow } from "@/lib/money-waiting-store";
import { formatCents } from "@/lib/money";
import { fmt } from "@/lib/dates";
import { PageHeader, Notice } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Money waiting on somebody: the pots, largest first, each with the one thing that would settle it.
 *
 * The owner asks one question about receivables and it is not "what does each payer owe" — the payer table answers that
 * and it is forty lines long. It is "what is my money doing, and who do I chase this morning". So this is built as a
 * list of jobs on a phone: the figure large enough to read at arm's length, one sentence saying what it is, and one
 * saying what settles it. The quiet ones — a payer that bills and has never sent anything the site reads — are marked,
 * because those are the ones nobody would notice the absence of.
 *
 * Nothing here is called late. A cycle the site does not hold cannot make a deadline, and an invented one is how a red
 * flag stops meaning anything (`payer-owed.ts`, since 9 September).
 */
export default async function MoneyWaitingPage() {
  await requireUser();
  const waiting = await moneyWaitingNow();
  const quiet = waiting.rows.filter((r) => r.neverAnything);

  return (
    <>
      <PageHeader
        title="Money waiting"
        subtitle="Earned and not yet paid, largest first, with the document that would settle each one."
        actions={
          <>
            <Link href="/payers/ar" className="btn">Aged receivables</Link>
            <Link href="/payers/owed" className="btn hidden sm:inline-flex">Every payer</Link>
          </>
        }
      />

      <Notice kind={waiting.neverAnythingCents > 0 ? "warn" : "ok"}>{waiting.says}</Notice>

      {waiting.rows.length === 0 ? (
        <p className="mt-4 text-sm text-ink-2">Nothing is waiting on anybody.</p>
      ) : (
        <ol className="mt-4 grid gap-3">
          {waiting.rows.map((r, i) => (
            <li key={r.key} className="card">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="flex items-baseline gap-2 text-base font-semibold">
                  <span className="text-xs font-normal text-ink-3">{i + 1}.</span>
                  {r.name}
                  {r.bin && <span className="text-xs font-normal text-ink-3">BIN {r.bin}</span>}
                  {r.kind === "programme" && <span className="badge">voucher programme</span>}
                  {r.kind === "unbanked" && <span className="badge badge-warn">taken, not banked</span>}
                </span>
                <span className="text-right">
                  <span className="block text-2xl font-semibold tabular-nums text-ink">{formatCents(r.cents)}</span>
                  <span className="block text-[11px] text-ink-3">
                    {r.waitingDays === null ? "no date on it" : `waiting ${r.waitingDays} day${r.waitingDays === 1 ? "" : "s"}`}
                  </span>
                </span>
              </div>
              <p className="mt-1 text-sm text-ink-2">{r.what}</p>
              <p className={`mt-1 text-sm ${r.neverAnything ? "text-ink" : "text-ink-2"}`}>{r.settles}</p>
              <div className="mt-2">
                <Link href={r.href} className="btn btn-sm">Open it</Link>
              </div>
            </li>
          ))}
        </ol>
      )}

      {quiet.length > 0 && (
        <p className="mt-4 text-xs text-ink-3">
          {quiet.length} of these have never sent anything the site reads, {formatCents(waiting.neverAnythingCents)} between them.
          A payer with no settling document is not a missing payment — it is a payment nobody would notice the absence of.
          The register of who settles what is <code>docs/registers/payer-routing.md</code>.
        </p>
      )}
      <p className="mt-2 text-xs text-ink-3">Measured {fmt(new Date().toISOString().slice(0, 10))}, from the claims and the payments on file.</p>
    </>
  );
}
