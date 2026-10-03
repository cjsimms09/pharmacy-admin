import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { returnSoonNow, RETURN_TIERS } from "@/lib/return-soon";
import { units } from "@/lib/usage";
import { fmt } from "@/lib/dates";
import { PageHeader, Card, Notice, Empty, Figure } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Return soon" };

/*
 * One list of everything that should go back, ranked by the dollars and the clock.
 *
 * The owner's words: "cant have money sitting on shelf." Three reasons share the list — a credit
 * the supplier is about to stop paying, a bottle nothing dispenses, and a line worth more than
 * its pace justifies — and each row says which, what to send, who sold it where that is known,
 * and what to do. The tiers are stated on the page so the rule is never a mystery.
 */
export default async function ReturnSoonPage() {
  await requireReimbursement();
  await requireUser();
  const view = await returnSoonNow();
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const t = view.totals;
  const whyWords: Record<(typeof view.rows)[number]["why"], string> = {
    credit: "Credit about to drop",
    window: "Return window shutting",
    idle: "Not moving",
    slow: "Slow for what it is worth",
  };
  const tierWords = RETURN_TIERS.map((x) => (x.atLeastCents > 0 ? `${money(x.atLeastCents)} or more may hold ${x.keepDays} days` : `anything less may hold ${x.keepDays}`)).join("; ");

  return (
    <>
      <PageHeader
        title="Return soon"
        subtitle="Everything the site thinks should go back: a credit about to drop, a bottle nothing dispenses, money sitting on the shelf. Ranked by the clock, then the dollars."
      />
      {view.notes.map((n) => (
        <div key={n} className="mt-3">
          <Notice kind={/^No /.test(n) ? "warn" : "ok"}>{n}</Notice>
        </div>
      ))}
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <Figure value={money(t.sittingCents)} label="sitting on the shelf" sub="the part of each line that should go back, at cost" tone={t.sittingCents > 0 ? "warn" : "ok"} />
        <Figure value={t.lines.toLocaleString()} label="lines to send back" sub={`${t.thisWeek} this week`} tone={t.thisWeek > 0 ? "crit" : "muted"} />
        <Figure value={t.withoutSupplier.toLocaleString()} label="with no invoice on file" sub="the site cannot say who sold these or what they credit" tone={t.withoutSupplier > 0 ? "warn" : "ok"} />
        <Figure value={`${RETURN_TIERS[0].keepDays} / ${RETURN_TIERS[1].keepDays} / ${RETURN_TIERS[2].keepDays}`} label="days a line may hold" sub={tierWords} tone="muted" />
      </div>

      <Card title="What to send back" subtitle="Soonest first, then the most money. Each row says why, how much, and who to ask.">
        {view.rows.length === 0 ? (
          <Empty>Nothing on the shelf is idle, slow for its value, or on a credit clock. That is the position this page exists to get to.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Drug</th>
                  <th>Why</th>
                  <th className="text-right">On hand</th>
                  <th className="text-right">Send back</th>
                  <th className="text-right">Worth</th>
                  <th>Credit</th>
                  <th>What to do</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.slice(0, 300).map((r) => (
                  <tr key={`${r.ndc11}|${r.invoiceDate ?? ""}`}>
                    <td className="text-sm">
                      <span className={r.urgency === "today" || r.urgency === "this week" ? "font-medium text-crit" : ""}>{r.urgency}</span>
                      {r.deadlineDays !== null && <div className="text-xs text-ink-3">{r.deadlineDays} days</div>}
                    </td>
                    <td>
                      <div className="font-medium">{r.name ?? "No name on file"}</div>
                      <div className="text-xs text-ink-3">{r.ndc11}</div>
                    </td>
                    <td className="text-sm">
                      <div>{whyWords[r.why]}</div>
                      <div className="text-xs text-ink-3">{r.reasons.join("; ")}</div>
                    </td>
                    <td className="text-right">{units(r.onHandThousandths)}</td>
                    <td className="text-right font-medium">{units(r.sendBackThousandths)}</td>
                    <td className="text-right">{r.sendBackWorthCents !== null ? money(r.sendBackWorthCents) : "—"}</td>
                    <td className="text-sm">
                      {r.supplier ? (
                        <>
                          <div>
                            {r.supplier}
                            {r.creditPercentNow !== null && ` credits ${r.creditPercentNow}%`}
                          </div>
                          {r.invoiceDate && <div className="text-xs text-ink-3">invoice {fmt(r.invoiceDate)}</div>}
                          {r.atRiskCents ? <div className="text-xs text-warn">−{money(r.atRiskCents)} at the next step</div> : null}
                        </>
                      ) : (
                        <span className="text-ink-3">no invoice on file</span>
                      )}
                    </td>
                    <td className="text-sm">{r.todo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {view.rows.length > 300 && <p className="mt-2 text-sm text-ink-3">Showing 300 of {view.rows.length.toLocaleString()}.</p>}
          </div>
        )}
      </Card>

      <p className="mt-4 text-sm text-ink-3">
        The credit clocks come from each supplier&apos;s own returns policy on its terms page and the invoice the line was bought on; the
        pace comes from the claims; the count from <Link href="/purchasing/shelf" className="underline">the shelf</Link>. A wholesaler whose
        invoices are not loaded cannot be timed, and the row says so.
      </p>
    </>
  );
}
