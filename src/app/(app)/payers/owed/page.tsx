import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { familyTabs } from "@/lib/families";
import { formatCents } from "@/lib/money";
import { fmt } from "@/lib/dates";
import { owedNow } from "@/lib/payer-owed-store";
import type { PayerState } from "@/lib/payer-owed";
import { PageHeader, Card, Notice, Empty, Figure } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "What payers owe" };

/**
 * What each payer owes against what it has actually sent.
 *
 * The owner asked for it in as many words — "it should be easy to know how much a payer owes us for
 * a claim" — and every ingredient was already on file while nothing put them in the same room.
 *
 * ── Why this page is mostly words ──
 *
 * On the day it was written, $131,743.31 had been billed and nothing at all had been received. A
 * table of five-figure sums beside a column of $0.00 is indistinguishable from a broken page, and a
 * page believed to be broken gets ignored on the day it stops being wrong. So each row says in a
 * sentence what its two figures mean together, and the difference the page exists to hold is
 * between three things that all render as nought:
 *
 *   a cash plan, which never sends money and never will;
 *   a real payer that has not remitted yet, which is unpaid and not late;
 *   a payer that has paid before and still owes, which is the only one worth chasing.
 *
 * Nothing here calls anything overdue. No remittance cycle is on file for any payer, so a deadline
 * would be one this pharmacy invented and then believed.
 */

const TONE: Record<PayerState, { badge: string; label: string }> = {
  owes: { badge: "badge-crit", label: "owes" },
  waiting: { badge: "badge-warn", label: "nothing received yet" },
  settled: { badge: "badge-ok", label: "square" },
  overpaid: { badge: "badge-warn", label: "paid more than billed" },
  cashPlan: { badge: "badge-muted", label: "bills through, never pays" },
};

export default async function OwedPage() {
  await requireReimbursement();
  await requireUser();
  const owed = await owedNow();
  const real = owed.lines.filter((l) => l.state !== "cashPlan");
  const chase = owed.lines.filter((l) => l.state === "owes");

  return (
    <>
      <PageHeader
        tabs={familyTabs("payers", "/payers/owed")}
        title="What payers owe"
        subtitle={owed.says}
      />

      {owed.lines.length === 0 ? (
        <Empty>No claims have been billed to any payer yet, so nobody owes anything.</Empty>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Figure value={formatCents(owed.billedCents)} label="Billed" sub={`Filled ${fmt(owed.from)} onwards`} />
            <Figure value={formatCents(owed.receivedCents)} label="Received" sub={owed.nothingHasArrived ? "Nothing paid against these claims yet" : `Across ${real.length} payer${real.length === 1 ? "" : "s"}`} />
            <Figure value={formatCents(owed.outstandingCents)} label="Outstanding" sub={chase.length ? `${chase.length} from a payer that has paid before` : "None of it from a payer that has ever paid"} />
          </div>

          {/*
            The state the page had to be built for. Said once, at the top, so nobody reads the
            table as a fault report.
          */}
          {owed.nothingHasArrived && (
            <Notice>
              Every figure in the received column is a true nought rather than a missing one. Nothing has
              yet been paid against any claim on this page, so there is nothing here to have gone wrong.
              The first payment against one of them will land on this page.{" "}
              <Link href="/payers/routing" className="text-accent underline">Where 835s are routed</Link>.
            </Notice>
          )}

          {/*
            Payments tied to no claim sit outside every total above, and they are not all one thing: some are for fills from
            before the claims feed, and some fit several claims on file and can leave those claims showing a balance without
            them. Said group by group, in the words the Claims page uses (untied-payments.ts), so the two cannot disagree.
          */}
          {owed.unattached.count > 0 && (
            <Card title="Payments tied to no claim">
              <p className="text-sm text-ink-2">{owed.unattachedSays}</p>
              <p className="mt-2 text-sm text-ink-2">
                What each group is, and what it needs from you if anything, is on{" "}
                <Link href="/claims/no-claim" className="text-accent underline">Payments with no claim</Link>.
              </p>
            </Card>
          )}

          {/*
            The top-off, kept out of both the balance and the overpaid count.

            The RxRescue claim adjudicates for the copay assistance and the credit memo pays that plus a top-off the
            claim never states, so the money arrives beyond anything anybody billed. Read as an overpayment it would put
            every one of these fills on a list of payers to query, with nothing to query.
          */}
          {owed.topOff.count > 0 && (
            <Card title="Top-off money nobody billed for">
              <p className="text-sm text-ink-2">
                {owed.topOff.count} payment{owed.topOff.count === 1 ? "" : "s"} brought{" "}
                <span className="font-medium text-ink">{formatCents(owed.topOff.cents)}</span> more than the claims they
                settled were billed. That is the Aytu / IPD top-off, which arrives on a credit memo weeks after the
                fill: the claim adjudicates for the copay assistance alone and never says how much top-off is coming. It
                is revenue, it is not an overpayment, and there is nothing to query.
              </p>
            </Card>
          )}

          {/*
            The Medicare Transaction Facilitator's refunds, kept out of every payer's received figure and out of the
            overpaid count.

            The facilitator pays the manufacturer's refund on a negotiated-price drug on top of what the plan paid, and it
            owes that money itself. Settling the plan's share with it made each of those fills read as overpaid by the
            refund, and a plan that had paid nothing as paid.
          */}
          {owed.facilitator.count > 0 && (
            <Card title="Money from the Medicare Transaction Facilitator">
              <p className="text-sm text-ink-2">
                {owed.facilitator.count} payment{owed.facilitator.count === 1 ? "" : "s"} from the facilitator,{" "}
                <span className="font-medium text-ink">{formatCents(owed.facilitator.cents)}</span> in all,{" "}
                {owed.facilitator.count === 1 ? "is" : "are"} tied to claims. The facilitator pays the manufacturer&apos;s refund on a
                negotiated-price drug on top of what the plan paid, and it owes that money itself, so it is in no payer&apos;s
                received figure and cannot make a plan look overpaid. What it has paid after each claim, and what is still
                awaited, is on{" "}
                <Link href="/remits/mtf" className="text-accent underline">Facilitator payments</Link>.
              </p>
            </Card>
          )}

          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="table">
              <thead>
                <tr>
                  <th>Payer</th>
                  <th className="text-right">Claims</th>
                  <th className="text-right">Billed</th>
                  <th className="text-right">Received</th>
                  <th className="text-right">Outstanding</th>
                  <th>Where it stands</th>
                </tr>
              </thead>
              <tbody>
                {owed.lines.map((l) => (
                  <tr key={`${l.bin ?? ""}|${l.name}`}>
                    <td>
                      <div className="font-medium">{l.name}</div>
                      {l.bin && <div className="font-mono text-xs text-ink-3">BIN {l.bin}</div>}
                    </td>
                    <td className="text-right tabular-nums">{l.claims.toLocaleString()}</td>
                    <td className="text-right tabular-nums">{formatCents(l.billedCents)}</td>
                    <td className="text-right tabular-nums">{formatCents(l.receivedCents)}</td>
                    <td className={`text-right tabular-nums ${l.state === "owes" ? "font-medium text-crit" : ""}`}>
                      {/* A cash plan's balance is not a balance, and the dash says so before the sentence does. */}
                      {l.state === "cashPlan" ? <span className="text-ink-3">—</span> : formatCents(l.outstandingCents)}
                    </td>
                    <td className="max-w-lg">
                      <span className={`badge ${TONE[l.state].badge}`}>{TONE[l.state].label}</span>
                      <div className="mt-1 text-xs leading-snug text-ink-2">{l.says}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/*
            Which date the period means. The site now counts revenue when the patient collects, and
            this page deliberately does not — so saying which basis it is on is the difference
            between two figures that disagree and two figures somebody thinks are wrong.
          */}
          <p className="text-xs leading-snug text-ink-3">
            Scoped on the date each prescription was <span className="font-medium">filled</span>, not the date it
            was collected. A payer owes what it adjudicated from the moment it adjudicated, whether or not the
            patient has been in — so this figure and the month&rsquo;s revenue, which counts a fill when it is
            sold, will not agree, and both are right. Nothing on this page is called overdue: no remittance
            cycle is on file for any payer, and a deadline nobody imposed is not one this site will invent.
          </p>
        </>
      )}
    </>
  );
}
