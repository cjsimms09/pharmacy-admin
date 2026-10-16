import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { fmt } from "@/lib/dates";
import { returnsDueNow, worthOf, actNow, type ReturnCandidate } from "@/lib/returns-due";
import { PageHeader, Card, Notice, Empty, Figure } from "@/components/ui";
import { ExportData } from "@/components/export-data";

export const dynamic = "force-dynamic";
export const metadata = { title: "What to send back" };

/**
 * What has to go back, to whom, by when, and for how much.
 *
 * The question a pharmacist actually has is "is there anything sitting on the shelf I am about to
 * lose money on", and it has never had an answer here. Every part of it was already in the site —
 * the invoice says who sold it and when, the policy says how long the full credit lasts, the
 * claims say whether it has moved — and none of them was joined to the others, so the answer
 * existed nowhere.
 *
 * The clock is the invoice date. Not expiry: a bottle bought last week with eighteen months of
 * shelf life on it still has a deadline, and it is the one that matters, because after it the
 * supplier pays three quarters instead of all of it. A page that counted down to expiry would have
 * been silent about exactly the returns worth making.
 *
 * Where no policy is on file for a supplier, nothing about their stock appears — and the page says
 * whose policy is missing rather than quietly showing a shorter list. A return raised outside a
 * window this site invented is a return refused, with the pharmacy holding the stock.
 */
export default async function ReturnsPage() {
  await requireUser();
  const { rows, suppliersWithoutPolicy, linesConsidered } = await returnsDueNow();
  const urgent = actNow(rows);
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <>
      <PageHeader
        back={{ href: "/inventory", label: "Inventory" }}
        title="What to send back"
        subtitle="Counted from the invoice date, which is the clock the supplier actually uses. Nothing here is about expiry — a bottle bought last week still has a deadline."
      />

      {urgent.length > 0 && (
        <Notice kind="warn">
          <b>{urgent.length} {urgent.length === 1 ? "line loses" : "lines lose"} credit within the week</b>, worth{" "}
          {money(worthOf(urgent))} between them, and none of them has been dispensed since it arrived.
        </Notice>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Figure value={rows.length} label="lines still returnable" sub={`out of ${linesConsidered.toLocaleString()} bought`} tone={rows.length ? "ok" : "muted"} />
        <Figure value={money(worthOf(rows))} label="worth at today's rates" sub="What it would credit if it all went back now" tone="muted" />
        <Figure
          value={urgent.length}
          label="need doing this week"
          sub="A deadline inside seven days, nothing dispensed"
          tone={urgent.length ? "warn" : "muted"}
        />
      </div>

      {suppliersWithoutPolicy.length > 0 && (
        <Notice kind="crit">
          Nothing is shown for {suppliersWithoutPolicy.join(", ")} — no return policy is on file, so there is no clock to
          count. Send them the policy PDF or{" "}
          <Link href="/suppliers" className="underline">open the supplier</Link> and enter the credit steps. Guessing a
          window would be worse than saying nothing: a return raised outside it is a return refused.
        </Notice>
      )}

      <Card
        className="mt-4"
        title="Still inside the window"
        count={rows.length}
        subtitle="Soonest deadline first. The money is what it would credit today, after any restocking fee."
      >
        {rows.length === 0 ? (
          <Empty>
            Nothing bought is still inside a return window with a policy on file. That is either good news or a missing
            policy — the note above says which.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Deadline</th><th>Item</th><th>From</th><th>Invoiced</th>
                  <th className="text-right">Credit now</th><th>Since it arrived</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => <Row key={`${r.invoiceId}-${r.ndc11}-${i}`} r={r} />)}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="mt-4 text-xs text-ink-3">
        Raising the return is still done in the supplier&rsquo;s own system — this says what to raise and by when.
        &ldquo;Dispensed since it arrived&rdquo; counts claims for that NDC dated on or after the invoice; it cannot know
        which bottle they came out of, so a line that has moved is flagged rather than hidden.
      </p>

      <ExportData page="returns" className="mt-6" />
    </>
  );
}

function Row({ r }: { r: ReturnCandidate }) {
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const tone =
    r.urgency === "today" ? "badge-crit" : r.urgency === "this week" ? "badge-warn" : "badge-muted";
  const deadline =
    r.dropsInDays !== null
      ? r.dropsInDays === 0
        ? "drops today"
        : `${r.dropsInDays}d → ${r.dropsToPercent}%`
      : r.closesInDays !== null
        ? `${r.closesInDays}d then closed`
        : "no deadline";
  return (
    <tr>
      <td className="whitespace-nowrap"><span className={`badge ${tone}`}>{deadline}</span></td>
      <td>
        <div className="text-sm">{r.description ?? r.ndc11}</div>
        <div className="font-mono text-[11px] text-ink-3">{r.ndc11} · {r.quantity} @ {money(Math.round(r.extendedCents / Math.max(1, r.quantity)))}</div>
      </td>
      <td className="text-sm">{r.supplier}</td>
      <td className="whitespace-nowrap text-xs">{fmt(r.invoiceDate)}<div className="text-ink-3">{r.daysSinceInvoice}d ago</div></td>
      <td className="num whitespace-nowrap">
        {money(r.creditNowCents)}
        <div className="text-[11px] font-normal text-ink-3">at {r.creditPercentNow}%</div>
      </td>
      <td className="text-xs">
        {r.dispensedSince > 0 ? (
          <span className="text-warn">{r.dispensedSince} dispensed — check what is left</span>
        ) : (
          <span className="text-ink-3">nothing dispensed</span>
        )}
      </td>
    </tr>
  );
}
