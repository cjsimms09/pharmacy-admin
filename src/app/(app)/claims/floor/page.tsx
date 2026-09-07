import { familyTabs } from "@/lib/families";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { floorReview } from "@/lib/floor-review";
import { formatCents } from "@/lib/money";
import { fmt } from "@/lib/dates";
import { SB20_EFFECTIVE_FROM } from "@/lib/reimbursement-rules";
import { PageHeader, Card, Figure, Notice, Empty, BackLink } from "@/components/ui";

export const metadata = { title: "Paid under the floor" };
export const dynamic = "force-dynamic";

/**
 * Where the pharmacy stands against the Kansas floor, and what to do next.
 *
 * The engine that decides this was written and tested months ago and never called by anything, so
 * the pharmacy has never been told a single fact about its own claims. This is the screen that
 * calls it.
 *
 * It is laid out around one distinction, because everything else follows from it. A claim that
 * produces no filing is either out of scope — the floor does not reach it, nothing to do — or
 * blocked, meaning it might well be recoverable and something is stopping us knowing. The second
 * group is the only one worth a morning, so it is the one carrying the money and the buttons.
 */
export default async function FloorPage() {
  await requireReimbursement();
  await requireUser();
  const r = await floorReview();

  return (
    <>
      <BackLink href="/claims">Claims</BackLink>
      <PageHeader
        tabs={familyTabs("floor", "/claims/floor")}
        title="Paid under the floor"
        subtitle={`Kansas SB 20 sets a floor of NADAC plus the greater of $10.50 or the state Medicaid dispensing fee, for commercial plans the state can reach, on claims filled from ${SB20_EFFECTIVE_FROM}.`}
        actions={<Link href="/plans" className="btn">Plan register</Link>}
      />

      {r.examined === 0 ? (
        <Empty>
          No claims loaded yet. <Link href="/claims" className="text-accent underline">Load a PioneerRx export</Link> and
          this fills in.
        </Empty>
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Figure
              value={formatCents(r.filableCents)}
              label="Recoverable now"
              sub={`${r.filable.length} claim${r.filable.length === 1 ? "" : "s"} paid below the floor`}
              tone={r.filable.length ? "warn" : "ok"}
            />
            <Figure
              value={formatCents(r.blockers.reduce((n, b) => n + b.onlyThisCents, 0))}
              label="Behind one blocker"
              sub="Clear the thing in the way and these become filable"
              tone={r.blocked.length ? "warn" : "ok"}
            />
            <Figure value={r.paidAtOrAbove} label="Paid correctly" sub="At or above the floor" tone="ok" />
            <Figure
              value={r.outOfScope}
              label="Out of scope"
              sub="The floor does not reach these. Nothing to do."
            />
          </div>

          {/* ── What is in the way, and what each is worth ── */}
          <Card
            title="What is stopping the rest"
            count={r.blockers.length}
            subtitle="Ranked by what clearing it is worth, which is often not the one holding back the most claims."
            className="mb-6"
          >
            {r.blockers.length === 0 ? (
              <p className="text-sm text-ink-2">Nothing. Every claim on file has been decided one way or the other.</p>
            ) : (
              <ul className="rows">
                {r.blockers.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                    <div className="min-w-[18rem] flex-1">
                      <p className="text-sm font-medium">{b.label}</p>
                      <p className="mt-1 text-sm text-ink-2">{b.action}</p>
                      <p className="mt-1 text-xs text-ink-3">
                        {b.claims} claim{b.claims === 1 ? "" : "s"} affected
                        {b.onlyThis > 0 && ` · ${b.onlyThis} would become filable if this alone were cleared`}
                      </p>
                    </div>
                    <div className="text-right">
                      {b.onlyThisCents > 0 && (
                        <p className="text-lg font-semibold text-warn">{formatCents(b.onlyThisCents)}</p>
                      )}
                      <Link href={b.href} className="btn btn-sm mt-1">Go and fix it</Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* ── The claims themselves ── */}
          <Card
            title="Paid below the floor"
            count={r.filable.length}
            subtitle="Every check passed. These are the ones that can go in front of the Insurance Department."
            className="mb-6"
          >
            {r.filable.length === 0 ? (
              <p className="text-sm text-ink-2">
                Nothing filable yet. That is either good news or a blocker above — the figures at the top say which.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Filled</th><th>Rx</th><th>Drug</th><th>Plan</th>
                      <th className="text-right">Floor</th><th className="text-right">Received</th><th className="text-right">Short by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.filable.slice(0, 200).map((c) => (
                      <tr key={c.claimId}>
                        <td className="whitespace-nowrap text-xs">{fmt(c.dateFilled)}</td>
                        <td className="whitespace-nowrap font-mono text-xs">{c.rxNumber}</td>
                        <td className="text-sm">{c.itemName ?? c.ndc11}</td>
                        <td className="text-xs text-ink-2">{c.payer ?? "—"}</td>
                        <td className="whitespace-nowrap text-right text-xs">{formatCents(c.floorCents ?? 0)}</td>
                        <td className="whitespace-nowrap text-right text-xs">{formatCents(c.receivedCents ?? 0)}</td>
                        <td className="whitespace-nowrap text-right text-sm font-semibold text-warn">
                          {formatCents(c.shortfallCents ?? 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {r.filable.length > 200 && (
                  <p className="mt-2 text-xs text-ink-3">Showing the first 200 of {r.filable.length}.</p>
                )}
              </div>
            )}
          </Card>

          {/*
            The assumptions, printed rather than buried.

            Everything above is only as good as what the export carries, and three things it does
            not carry are assumed in the pharmacy's favour. Saying so here is the difference
            between a report somebody can stand behind and one that falls over the first time a
            PBM asks a question about a reversal.
          */}
          <Card title="What this is assuming" tone="warn" className="mb-6">
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
              {r.caveats.map((c) => <li key={c}>{c}</li>)}
            </ul>
            <p className="mt-3 text-xs text-ink-3">
              The dispensing fee used is {formatCents(r.settings.dispensingFeeUsedCents)}
              {r.settings.ksMedicaidDispensingFeeCents === null
                ? " — the statutory minimum, because no Kansas Medicaid professional dispensing fee has been entered. If the state fee is higher, the floor is higher and these figures understate it."
                : " — the Kansas Medicaid professional dispensing fee on file, which is higher than the statutory minimum."}{" "}
              Shortfalls under {formatCents(r.settings.materialityCents)} are not listed.
            </p>
          </Card>
        </>
      )}
    </>
  );
}
