import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { planCandidates, refreshProposals, confirmProposal } from "@/lib/plan-proposals-store";
import { CLASS_INFO } from "@/lib/plans";
import { SOURCE_LABEL } from "@/lib/plan-evidence";
import { planShortlist } from "@/lib/plan-shortlist-store";
import { formatCents } from "@/lib/money";
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

export default async function PlansPage({ searchParams }: { searchParams: Promise<{ all?: string; error?: string }> }) {
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

  /*
   * Confirms every plan proposed as one class, in one press.
   *
   * Sixty-nine plans carry a live proposal — forty-two Medicare, eleven copay cards, ten discount
   * cards, five Medicaid, one workers' comp — and between them they classify 870 of the 2,523
   * claims on file and $95,072.46 of reimbursement. Every one of them was a separate press, so
   * none of them had been done, and 464 plan groups sat at "unknown" blocking the Kansas floor,
   * the payer spread and anything else that needs to know what a plan is.
   *
   * The owner: "Does each specific thing need its own alert or can the alert be more general and
   * click for specific." The same is true of the answer. A class is one decision — "these are the
   * ones PioneerRx's own plan file calls Part D" — not forty-two.
   *
   * Each plan is still confirmed individually underneath, with its own evidence sentence recorded
   * as its basis and its own audit line, so the file reads exactly as it would have done pressing
   * them one at a time. Any that refuses is counted and named rather than silently skipped.
   */
  async function confirmAll(fd: FormData) {
    "use server";
    const u = await requireManager();
    const want = String(fd.get("classification") ?? "");
    if (!want) redirect("/payers/plans?error=" + encodeURIComponent("No class was named."));

    const all = await planCandidates();
    const mine = all.filter((r) => r.proposed === want);
    let done = 0;
    const refused: string[] = [];
    for (const r of mine) {
      const res = await confirmProposal(r.id, u);
      if (!res.ok) {
        refused.push(`${r.payerLabel ?? r.bin}: ${res.why}`);
        continue;
      }
      done++;
      await audit({
        action: "plan.classified",
        userId: u.id,
        userName: u.name,
        entity: "plan",
        entityId: r.id,
        details: `confirmed as ${res.classification} (with ${mine.length - 1} others of the same class)`,
      });
    }
    revalidatePath("/payers/plans");
    redirect(
      "/payers/plans?error=" +
        encodeURIComponent(
          refused.length === 0
            ? `${done} plan${done === 1 ? "" : "s"} confirmed as ${want.replace(/_/g, " ")}.`
            : `${done} confirmed; ${refused.length} refused — ${refused.slice(0, 2).join("; ")}`,
        ),
    );
  }
  async function confirm(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const r = await confirmProposal(id, u);
    if (!r.ok) {
      /*
       * A refusal has to reach the screen.
       *
       * This used to be thrown away: the action ran, the page re-rendered unchanged, and the
       * pharmacist saw a button that did nothing and no reason why. Silence is the failure this
       * whole site is built to remove, and it is worse on a button than anywhere else, because he
       * will press it again.
       */
      redirect(`/payers/plans?error=${encodeURIComponent(r.why)}`);
    }
    await audit({ action: "plan.classified", userId: u.id, userName: u.name, entity: "plan", entityId: id, details: `confirmed as ${r.classification}` });
    revalidatePath("/payers/plans");
  }

  const [rows, list] = await Promise.all([planCandidates({ includeClassified: showAll }), planShortlist()]);
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

      {sp.error && <Notice kind="crit">{sp.error}</Notice>}

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Figure value={offered.length.toLocaleString("en-US")} label="Ready to confirm" sub="Read from a document" tone={offered.length ? "warn" : "ok"} />
        <Figure value={fillsOffered.toLocaleString("en-US")} label="Fills behind them" sub="What confirming these decides" />
        {/*
          * The money still unclassified, rather than a count of rows.
          *
          * A count says how much typing is left. This says what the Kansas floor cannot yet be run
          * against, which is the only reason any of it is being done.
          */}
        <Figure
          value={formatCents(list.totals.openCents)}
          label="Still unclassified"
          sub={`${list.totals.openClaims.toLocaleString("en-US")} claims on ${(list.totals.plans - list.settled.length).toLocaleString("en-US")} plans the floor cannot reach yet`}
          tone={list.totals.openCents ? "warn" : "ok"}
        />
      </div>

      {offered.length === 0 && needDocument.length === 0 ? (
        <Empty>Every plan on the register is classified. Nothing is waiting.</Empty>
      ) : null}

      {offered.length > 0 && (
        <Card
          className="mb-4"
          title="Proposed, biggest first"
          count={offered.length}
          subtitle="Each one quotes what it was read from. Confirming records that sentence as the basis."
          actions={
            canConfirm && offered.length > 1 ? (
              <span className="flex flex-wrap items-center gap-1">
                {[...new Set(offered.map((r) => r.proposed))].flatMap((c) => (c ? [c] : [])).map((c) => {
                  const n = offered.filter((r) => r.proposed === c).length;
                  return (
                    <form action={confirmAll} key={c}>
                      <input type="hidden" name="classification" value={c} />
                      <button
                        className="btn btn-sm"
                        title={`Confirms all ${n}, each with its own evidence recorded as its basis.`}
                      >
                        Confirm {n} {c.replace(/_/g, " ")}
                      </button>
                    </form>
                  );
                })}
              </span>
            ) : undefined
          }
        >
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th className="whitespace-nowrap">Fills</th>
                  <th>Proposed</th>
                  <th className="whitespace-nowrap">Read from</th>
                  <th>What it says</th>
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
                    {/*
                     * The source and how well it settles it, beside the offer rather than buried in
                     * the sentence. A class read out of PioneerRx's own plan file and a class read
                     * out of four letters of a PCN are not the same offer, and a register where the
                     * two look identical is a register of guesses.
                     */}
                    <td className="whitespace-nowrap align-top text-xs">
                      {r.proposedSource && (
                        <>
                          <span className={r.proposedConfidence === "stated" ? "badge badge-ok" : "badge badge-muted"}>{r.proposedConfidence}</span>
                          <p className="mt-0.5 text-ink-3">{SOURCE_LABEL[r.proposedSource]}</p>
                        </>
                      )}
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

      {/*
        * The short list, which is the part of this page that is actually a job.
        *
        * The register is keyed on BIN, PCN and group, and that is 280 rows of this pharmacy's
        * September. Nobody answers 280 questions. But the group number is the employer and almost
        * nothing turns on it — the PCN selects the line of business — so BIN and PCN together is
        * the level at which the question has one answer, and that is a list you can finish.
        *
        * Ranked by money, cut where what is left below stops mattering, and the tail counted out
        * loud underneath so that stopping the list is a decision he can see and disagree with.
        */}
      {list.open.length > 0 && (
        <Card
          title="The short list"
          count={list.open.length}
          subtitle={`${list.totals.openClaims.toLocaleString("en-US")} claims and ${formatCents(list.totals.openCents)} sit on plans nothing on file can classify. These are the questions that decide most of it.`}
        >
          <Notice kind="warn">
            Nothing here can be proposed, and that is a statement rather than a failure: no document on file says what
            these are. Each row says which document would settle it. Answer them on{" "}
            <a className="link" href="/plans">the register</a>, where the basis is recorded with the finding.
          </Notice>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th className="whitespace-nowrap">Claims</th>
                  <th className="whitespace-nowrap">Received</th>
                  <th>The question</th>
                </tr>
              </thead>
              <tbody>
                {list.open.map((o) => (
                  <tr key={`${o.bin}|${o.pcn}`}>
                    <td className="align-top">
                      <span className="font-mono text-xs">{o.bin ?? "no BIN"} / {o.pcn || "no PCN"}</span>
                      {/* The name and one drug he actually dispensed, because "003858 / A4" is not
                          a thing anybody recognises and "94 claims, alprazolam" is. */}
                      {o.planName && <p className="mt-0.5 text-xs">{o.planName}</p>}
                      <p className="mt-0.5 text-xs text-ink-3">
                        {o.pbmName ?? "unknown PBM"}
                        {o.exampleDrug ? ` · e.g. ${o.exampleDrug}` : ""}
                      </p>
                      {o.groups.length > 0 && (
                        <p className="mt-0.5 font-mono text-[0.65rem] text-ink-3">
                          {o.groups.slice(0, 3).join(", ")}{o.groups.length > 3 ? ` +${o.groups.length - 3}` : ""}
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap align-top tabular-nums">{o.claims.toLocaleString("en-US")}</td>
                    <td className="whitespace-nowrap align-top tabular-nums">{formatCents(o.receivedCents)}</td>
                    <td className="max-w-[34rem] align-top text-xs">
                      <p>{o.ask}</p>
                      <p className="mt-1 text-ink-3">{o.why}</p>
                      {/* A Government filing is the one lead that puts a plan *in* reach of the
                          floor rather than out of it, so it is never buried. */}
                      {o.governmentHint && <p className="mt-1 text-warn">{o.governmentHint}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.tail.plans > 0 && (
            <p className="mt-2 text-xs text-ink-3">
              Below the line: {list.tail.plans} more BIN and PCN pairs, {list.tail.claims.toLocaleString("en-US")} claims,{" "}
              {formatCents(list.tail.receivedCents)} between them. Worth doing one day; not worth doing first.
            </p>
          )}
        </Card>
      )}
    </>
  );
}
