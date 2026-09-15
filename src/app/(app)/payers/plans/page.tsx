import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { planCandidates, refreshProposals, confirmProposal, confirmGroup } from "@/lib/plan-proposals-store";
import { confirmGroups } from "@/lib/plan-proposals";
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
   * Confirms every plan one document settles, in one press.
   *
   * ── What this replaced, and why ──
   *
   * There was a "confirm all 33 Medicare" button here, and it was the wrong grouping. Thirty-three
   * plans read from eleven different payer sheets is not one decision — it is eleven decisions
   * wearing one button, and nothing on the screen let him check any of them, because the sentence
   * behind each was different.
   *
   * A group is now one class, from one named document, for one BIN and PCN: "CMS's Part D BIN-PCN
   * file names BIN 610097 / PCN 9999 as Medicare Advantage" is twelve register rows and one fact,
   * because the register is keyed on the group number as well and the group number is the employer.
   * That is what turns 481 unclassified plans into a list somebody finishes. On today's data it is
   * 85 plans in 25 presses, and the top five presses are $83,166 of the $87,916.
   *
   * Each plan is still confirmed individually underneath, with its own evidence sentence recorded as
   * its basis and its own audit line, so the file reads exactly as it would pressing them one at a
   * time. Any that refuses is named rather than silently skipped.
   *
   * And it cannot decide scope. Every class that can appear in a group is out of the Kansas floor's
   * reach, so a press can only ever take plans out; the four findings that put a plan *in* reach
   * still need a Form 5500 or the plan document, one plan at a time. There is a test on that.
   */
  async function confirmOneGroup(fd: FormData) {
    "use server";
    const u = await requireManager();
    const key = String(fd.get("key") ?? "");
    if (!key) redirect("/payers/plans?error=" + encodeURIComponent("No group was named."));

    const r = await confirmGroup(key, u);
    if (r.classification === null) {
      redirect("/payers/plans?error=" + encodeURIComponent("That group is no longer on offer — the evidence behind it has moved. Press “Look again”."));
    }
    await audit({
      action: "plan.classified",
      userId: u.id,
      userName: u.name,
      entity: "plan",
      details: `confirmed ${r.confirmed} plan${r.confirmed === 1 ? "" : "s"} as ${r.classification} from one document (${key})`,
    });
    revalidatePath("/payers/plans");
    redirect(
      "/payers/plans?error=" +
        encodeURIComponent(
          r.refused.length === 0
            ? `${r.confirmed} plan${r.confirmed === 1 ? "" : "s"} confirmed as ${(r.classification ?? "").replace(/_/g, " ")} — ${r.claims.toLocaleString("en-US")} claims and ${formatCents(r.receivedCents)} now follow a class.`
            : `${r.confirmed} confirmed; ${r.refused.length} refused — ${r.refused.slice(0, 2).map((x) => `${x.plan}: ${x.why}`).join("; ")}`,
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
  /*
   * Grouped from the rows already loaded, not fetched again.
   *
   * `confirmGroups` is pure, so the page reads the register and the claims once. The press does call
   * `proposalGroups` and recompute — deliberately, for the same reason `confirmProposal` recomputes:
   * a confirmation adopts the evidence as it stands at the moment of adoption. Here it is only being
   * drawn, and drawing it twice would be two facts about one thing.
   *
   * Filtered to the undecided, because "show all" includes plans somebody has already classified and
   * a proposal must never be offered against a documented finding.
   */
  const groups = confirmGroups(rows.filter((r) => r.classification === "unknown"));
  const offered = rows.filter((r) => r.proposed !== null);
  const needDocument = rows.filter((r) => r.proposed === null && r.classification === "unknown");
  /*
   * What one evening of pressing is worth, counted once.
   *
   * A group's claims and money are the claims each of its plans GOVERNS, not the claims whose BIN,
   * PCN and group match it — those double count, because a PCN-less register row and the row for the
   * PCN both match the same claim. See PlanCandidate.claims.
   */
  const readyPlans = groups.reduce((n, g) => n + g.plans.length, 0);
  const readyClaims = groups.reduce((n, g) => n + g.claims, 0);
  const readyCents = groups.reduce((n, g) => n + g.receivedCents, 0);
  const unknownRows = rows.filter((r) => r.classification === "unknown");
  const unknownCents = unknownRows.reduce((n, r) => n + r.receivedCents, 0);
  const unknownClaims = unknownRows.reduce((n, r) => n + r.claims, 0);

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

      {/*
        * The answer first: what these presses are worth, against what is left.
        *
        * The old tiles counted rows and fills. A count of rows says how much typing is left; this
        * says how much reimbursement stops being unfollowable, which is the only reason any of it
        * is being done.
        */}
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Figure
          value={formatCents(readyCents)}
          label={`Settled by ${groups.length} press${groups.length === 1 ? "" : "es"}`}
          sub={`${readyPlans.toLocaleString("en-US")} plans, ${readyClaims.toLocaleString("en-US")} claims — each group one document`}
          tone={groups.length ? "warn" : "ok"}
        />
        <Figure
          value={formatCents(unknownCents - readyCents)}
          label="Still needs your judgement"
          sub={`${(unknownRows.length - readyPlans).toLocaleString("en-US")} plans, ${(unknownClaims - readyClaims).toLocaleString("en-US")} claims — mostly the one question no document on file answers`}
        />
        {/*
          * The money still unclassified, rather than a count of rows.
          *
          * A count says how much typing is left. This says what the Kansas floor cannot yet be run
          * against, which is the only reason any of it is being done.
          */}
        <Figure
          value={formatCents(unknownCents)}
          label="Unclassified in total"
          sub={`${unknownClaims.toLocaleString("en-US")} claims on ${unknownRows.length.toLocaleString("en-US")} plans the floor cannot reach yet`}
          tone={unknownCents ? "warn" : "ok"}
        />
      </div>

      {offered.length === 0 && needDocument.length === 0 ? (
        <Empty>Every plan on the register is classified. Nothing is waiting.</Empty>
      ) : null}

      {/*
        * One document, one press, biggest money first.
        *
        * The register is keyed on BIN, PCN and group number, and the group number is the employer —
        * so a single fact ("CMS's Part D file names BIN 610097 / PCN 9999 as Medicare Advantage")
        * arrives as nine separate rows with nine separate buttons, and nobody presses nine buttons
        * ninety times. Grouped by the document, the same 85 plans are 25 presses and the first five
        * are $83,166 of the $87,916.
        *
        * Every plan in a group is still confirmed on its own underneath, with that sentence recorded
        * as its own basis and its own audit line. And no class that can appear here is in reach of
        * the Kansas floor, so a press can only ever take plans out of scope — never put one in.
        */}
      {groups.length > 0 && (
        <Card
          className="mb-4"
          title="Settled by a document already on file"
          count={groups.length}
          subtitle={`${readyPlans.toLocaleString("en-US")} plans, ${readyClaims.toLocaleString("en-US")} claims and ${formatCents(readyCents)}. Each row is one document and one press; the sentence it was read from is recorded as the basis of every plan in it.`}
        >
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Routing</th>
                  <th>Is</th>
                  <th className="whitespace-nowrap">Claims</th>
                  <th className="whitespace-nowrap">Received</th>
                  <th>Read from</th>
                  {canConfirm && <th />}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key}>
                    <td className="align-top">
                      <span className="font-mono text-xs">{g.bin ?? "no BIN"} / {g.pcn || "no PCN"}</span>
                      {g.name && <p className="mt-0.5 text-xs">{g.name}</p>}
                      {/* The plans the press covers, folded away — the count is the decision, the
                          list is the audit, and he is usually reading this on a phone. */}
                      <details className="mt-0.5">
                        <summary className="cursor-pointer text-xs text-ink-3">
                          {g.plans.length.toLocaleString("en-US")} plan{g.plans.length === 1 ? "" : "s"} on the register
                        </summary>
                        <ul className="mt-1 space-y-0.5">
                          {g.plans.map((p) => (
                            <li key={p.id} className="font-mono text-[0.65rem] text-ink-3">
                              {p.groupNumber ?? "no group"}
                              {p.pcn ? "" : " (row predates the PCN)"}
                              {p.claims ? ` · ${p.claims} claims ${formatCents(p.receivedCents)}` : ""}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </td>
                    <td className="whitespace-nowrap align-top">
                      <span className="badge badge-muted">{CLASS_INFO[g.classification].label}</span>
                      {/*
                       * The source and how well it settles it, beside the offer rather than buried
                       * in the sentence — and for a group it is the weakest member's confidence,
                       * because a group is only as good as its worst row.
                       */}
                      <p className="mt-1">
                        <span className={g.confidence === "stated" ? "badge badge-ok" : "badge badge-muted"}>{g.confidence}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-ink-3">{SOURCE_LABEL[g.source]}</p>
                    </td>
                    <td className="whitespace-nowrap align-top tabular-nums">{g.claims.toLocaleString("en-US")}</td>
                    <td className="whitespace-nowrap align-top tabular-nums">{formatCents(g.receivedCents)}</td>
                    <td className="max-w-[28rem] align-top text-xs text-ink-2">{g.from}</td>
                    {canConfirm && (
                      <td className="whitespace-nowrap align-top">
                        <form action={confirmOneGroup}>
                          <input type="hidden" name="key" value={g.key} />
                          <button
                            className="btn btn-sm btn-primary"
                            type="submit"
                            title={`Confirms all ${g.plans.length}, each with this sentence recorded as its own basis.`}
                          >
                            Confirm {g.plans.length}
                          </button>
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
        * The same offers one row at a time, for the occasion where he wants to take one out of a
        * group rather than the whole group. Folded shut: the groups above are the job.
        */}
      {offered.length > 0 && (
        <details className="mb-4">
          <summary className="cursor-pointer text-sm text-ink-3">
            The same {offered.length.toLocaleString("en-US")} plans one at a time
          </summary>
          <Card
            className="mt-2"
            title="Proposed, biggest first"
            count={offered.length}
            subtitle="Each one quotes what it was read from. Confirming records that sentence as the basis."
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
        </details>
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
