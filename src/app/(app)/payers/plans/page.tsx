import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { planCandidates, refreshProposals, confirmProposal } from "@/lib/plan-proposals-store";
import { CLASS_INFO } from "@/lib/plans";
import { PageHeader, Card, Figure, Notice, Empty } from "@/components/ui";

/**
 * Classifying the plans, one confirmation at a time, biggest first.
 *
 * Six of 1,054 fills sit on a plan anybody has classified, so the law-first rung in the profit
 * engine — Medicaid pays NADAC plus a fee, the Kansas floor binds or it does not — never fires for
 * 99% of what this pharmacy dispenses. Ninety-odd blank boxes is not a job anyone finishes.
 *
 * So the site reads what it can and offers it with the sentence behind it, and the owner confirms.
 * Two things make that safe rather than convenient:
 *
 *   - only classes that identify themselves are ever proposed. Medicare, Medicaid, workers'
 *     compensation and cards. The four that decide whether the Kansas floor reaches a plan need a
 *     Form 5500 or the plan document, and this offers none of them;
 *   - a proposal is never a classification. It sits beside the plan and nothing prices a claim on
 *     it until a person adopts it, so no figure on the site moves because a guess was written into
 *     the register.
 *
 * Ordered by fills, because a plan carrying three hundred of them decides three hundred claims'
 * worth of floor test and one carrying a single fill decides one.
 */

export const dynamic = "force-dynamic";

export default async function PlansPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const canConfirm = user.role !== "staff";
  const showAll = sp.all === "1";

  async function refresh() {
    "use server";
    const u = await requireManager();
    const r = await refreshProposals();
    await audit({ action: "plan.proposals", userId: u.id, userName: u.name, details: `${r.proposed} proposed, ${r.unproposable} need a document` });
    revalidatePath("/payers/plans");
  }

  async function confirm(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const r = await confirmProposal(id, u);
    if (r.ok) {
      await audit({ action: "plan.classified", userId: u.id, userName: u.name, entity: "plan", entityId: id, details: `confirmed as ${r.classification}` });
    }
    revalidatePath("/payers/plans");
  }

  const rows = await planCandidates({ includeClassified: showAll });
  const offered = rows.filter((r) => r.proposed !== null);
  const needDocument = rows.filter((r) => r.proposed === null && r.classification === "unknown");
  const fillsOffered = offered.reduce((n, r) => n + r.fills, 0);

  return (
    <>
      <PageHeader
        title="Plan classification"
        subtitle="Which law each plan sits under, proposed from the BIN listing and confirmed by you."
        help={
          <>
            <p>
              Whether the Kansas floor reaches a plan depends on what kind of plan it is, and almost none of them are
              classified — so the floor test, and the Medicaid rung of the profit engine, sit idle on nearly every claim.
            </p>
            <p>
              What is offered here is read from the BIN listing or from the claim&rsquo;s own routing, with the sentence
              that produced it beside the button. Only classes that identify themselves are ever proposed. A commercial
              plan is never proposed, because &ldquo;commercial&rdquo; does not say whether the employer bought insurance
              or funds the plan itself — and that is exactly the difference between the floor applying and ERISA
              preempting it. Those need a Form 5500 or the plan document, and they are listed below so you know which.
            </p>
            <p>Nothing here changes a figure until you confirm it. A proposal prices nothing.</p>
          </>
        }
        actions={
          canConfirm ? (
            <form action={refresh}>
              <button className="btn" type="submit">Look again</button>
            </form>
          ) : undefined
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Figure value={offered.length.toLocaleString("en-US")} label="Ready to confirm" sub="Read from a document" tone={offered.length ? "warn" : "ok"} />
        <Figure value={fillsOffered.toLocaleString("en-US")} label="Fills behind them" sub="What confirming these decides" />
        <Figure value={needDocument.length.toLocaleString("en-US")} label="Need a document" sub="A Form 5500 or the plan document" />
      </div>

      {offered.length === 0 && needDocument.length === 0 ? (
        <Empty>Every plan on the register is classified. Nothing is waiting.</Empty>
      ) : null}

      {offered.length > 0 && (
        <Card className="mb-4" title="Proposed, biggest first" count={offered.length} subtitle="Each one quotes what it was read from. Confirming records that sentence as the basis.">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th className="whitespace-nowrap">Fills</th>
                  <th>Proposed</th>
                  <th>Read from</th>
                  {canConfirm && <th />}
                </tr>
              </thead>
              <tbody>
                {offered.map((r) => (
                  <tr key={r.id}>
                    <td className="align-top">
                      <span className="font-mono text-xs">{r.bin ?? "no BIN"} / {r.pcn ?? "no PCN"} / {r.groupNumber ?? "no group"}</span>
                      {r.payerLabel && <p className="mt-0.5 text-xs text-ink-3">{r.payerLabel}</p>}
                    </td>
                    {/* What ordering by fills is for: this is how much the decision is worth. */}
                    <td className="whitespace-nowrap align-top tabular-nums">{r.fills.toLocaleString("en-US")}</td>
                    <td className="whitespace-nowrap align-top">
                      <span className="badge badge-muted">{CLASS_INFO[r.proposed!].label}</span>
                    </td>
                    <td className="max-w-[30rem] align-top text-xs text-ink-2">{r.proposedFrom}</td>
                    {canConfirm && (
                      <td className="whitespace-nowrap align-top">
                        <form action={confirm}>
                          <input type="hidden" name="id" value={r.id} />
                          <button className="btn btn-sm btn-primary" type="submit">Confirm</button>
                        </form>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {needDocument.length > 0 && (
        <Card
          title="Nothing can be proposed for these"
          count={needDocument.length}
          subtitle="Not a failure to read them — a statement that no document on file says what they are."
        >
          <Notice kind="warn">
            These are where the money is decided and where a guess would do the most harm. Each one needs a Form 5500,
            the plan document, or the employer&rsquo;s own answer before it can be classified.
          </Notice>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th className="whitespace-nowrap">Fills</th>
                  <th>Why not</th>
                </tr>
              </thead>
              <tbody>
                {needDocument.map((r) => (
                  <tr key={r.id}>
                    <td className="align-top">
                      <span className="font-mono text-xs">{r.bin ?? "no BIN"} / {r.pcn ?? "no PCN"} / {r.groupNumber ?? "no group"}</span>
                      {r.payerLabel && <p className="mt-0.5 text-xs text-ink-3">{r.payerLabel}</p>}
                    </td>
                    <td className="whitespace-nowrap align-top tabular-nums">{r.fills.toLocaleString("en-US")}</td>
                    <td className="max-w-[34rem] align-top text-xs text-ink-2">{r.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
