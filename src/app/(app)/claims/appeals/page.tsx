import { familyTabs } from "@/lib/families";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager, requireUser } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { appealQueue, appealsList, appealsScore, prepareAppeal, prepareAllReady, sendAppeal, recordOutcome, prepareFloorComplaint, floorComplaintCandidates, type AppealRow } from "@/lib/appeals";
import { formatCents } from "@/lib/money";
import { todayIso } from "@/lib/dates";
import { PageHeader, Card, Notice, Empty, Figure } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Appeals" };

/** Back to the page with a message. At module scope, so a server action references it rather than captures it. */
function back(msg: string, kind: "ok" | "error" = "ok"): never {
  redirect(`/claims/appeals?${kind}=${encodeURIComponent(msg)}`);
}

/**
 * Appeals and complaints, from the claims to the PBM and back.
 *
 * The queue is what the claims say is owed under the contracts on file, packet by packet, with
 * the deadline on each. Prepare keeps the packet and files its PDF; Send goes through the
 * pharmacy's mailbox where the contract names an address, and hands over the fields where it
 * names a portal or a fax. What could not be sent is grouped by the one fix that would free it,
 * because "read that contract" or "load that invoice" is a job and a list of blocked claims is not.
 */
export default async function AppealsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireReimbursement();
  const user = await requireUser();
  const { ok, error } = await searchParams;
  const today = todayIso();
  const [queue, list, score, floor] = await Promise.all([appealQueue(today), appealsList(), appealsScore(today), floorComplaintCandidates().catch(() => [])]);
  const canManage = user.role === "owner" || user.role === "pic";

  async function prepareOne(fd: FormData) {
    "use server";
    const u = await requireManager();
    try {
      const r = await prepareAppeal(String(fd.get("claimId") ?? ""), u);
      revalidatePath("/claims/appeals");
      back(r.ok ? "Packet prepared and filed. Send it below." : `Prepared, but held: ${r.blockers.join(" ")}`);
    } catch (e) {
      if (e instanceof Error && e.message.includes("NEXT_REDIRECT")) throw e;
      back(e instanceof Error ? e.message : String(e), "error");
    }
  }
  async function prepareAll() {
    "use server";
    const u = await requireManager();
    const r = await prepareAllReady(u);
    revalidatePath("/claims/appeals");
    back(`${r.prepared} packet${r.prepared === 1 ? "" : "s"} prepared, ${formatCents(r.cents)} in all. Send them below.`);
  }
  async function send(fd: FormData) {
    "use server";
    const u = await requireManager();
    try {
      const r = await sendAppeal(String(fd.get("id") ?? ""), u);
      revalidatePath("/claims/appeals");
      back(r.how, r.sent ? "ok" : "error");
    } catch (e) {
      if (e instanceof Error && e.message.includes("NEXT_REDIRECT")) throw e;
      back(e instanceof Error ? e.message : String(e), "error");
    }
  }
  async function outcome(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const status = String(fd.get("status") ?? "") as AppealRow["status"];
    const cents = Math.round(Number(String(fd.get("dollars") ?? "").replace(/[^0-9.-]/g, "")) * 100);
    const note = String(fd.get("note") ?? "").trim() || null;
    if (!id || !["sent", "answered", "won", "lost", "withdrawn"].includes(status)) back("Pick an outcome.", "error");
    await recordOutcome(id, status, Number.isFinite(cents) && cents !== 0 ? cents : null, note, u);
    revalidatePath("/claims/appeals");
    back("Recorded.");
  }
  async function complaint(fd: FormData) {
    "use server";
    const u = await requireManager();
    try {
      const r = await prepareFloorComplaint(String(fd.get("payer") ?? ""), u);
      revalidatePath("/claims/appeals");
      back(`Complaint packet prepared: ${r.claims} claims, ${formatCents(r.cents)}. Download it below and file it on the Insurance Department's portal.`);
    } catch (e) {
      if (e instanceof Error && e.message.includes("NEXT_REDIRECT")) throw e;
      back(e instanceof Error ? e.message : String(e), "error");
    }
  }

  const prepared = list.filter((a) => a.status === "prepared");
  const open = list.filter((a) => a.status === "sent" || a.status === "answered");
  const closed = list.filter((a) => a.status === "won" || a.status === "lost" || a.status === "withdrawn");

  return (
    <>
      <PageHeader
        tabs={familyTabs("floor", "/claims/appeals")}
        title="Appeals"
        subtitle="What the contracts say is owed on the claims, packet by packet, with the deadline on each; sent by the PBM's own route and scored by the next remittance."
        help={
          <>
            <p><b>What is appealed.</b> A paid third-party claim of the last 120 days whose PBM has a rate row on file, priced under that row&rsquo;s formula by more than $3.00, with NADAC in force on the fill date and the claim&rsquo;s own AWP as the benchmarks. Where the claim names a network id, that row; where the PBM has one row, that; where it has several and the claim names none, no guess.</p>
            <p><b>What the packet carries.</b> The claim, what it paid, what the contract yields, the shortfall, the invoice line nearest the fill priced per unit from the catalogue&rsquo;s pack size, the deadline from the contract&rsquo;s own window, and the route.</p>
            <p><b>Sending.</b> Email goes through the pharmacy&rsquo;s mailbox with the PDF attached. A portal or a fax is handed over with the packet to download; mark it sent here. The outcome is recorded when the reprocessed claim comes in.</p>
            <p><b>Floor complaints.</b> One packet per plan from the Kansas floor review, for the Insurance Department&rsquo;s portal.</p>
          </>
        }
        actions={canManage && queue.ready.length > 0 ? <form action={prepareAll}><SubmitButton pendingLabel="Preparing…" className="btn btn-primary">Prepare all {queue.ready.length} ready</SubmitButton></form> : undefined}
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Figure size="sm" value={formatCents(queue.readyCents)} label="ready to send" sub={`${queue.ready.length} claims since ${queue.since}`} tone={queue.ready.length ? "ok" : "muted"} />
        <Figure size="sm" value={formatCents(queue.heldCents)} label="held back" sub={`${queue.held.length} claims, one fix each`} tone={queue.held.length ? "warn" : "muted"} />
        <Figure size="sm" value={formatCents(score.sentCents)} label="sent, awaiting an answer" sub={`${score.sent} appeals${score.overdue ? ` · ${score.overdue} past the answer date` : ""}`} tone={score.overdue ? "warn" : "muted"} />
        <Figure size="sm" value={formatCents(score.wonCents)} label="won" sub={`${score.won} won · ${score.lost} lost`} tone={score.won ? "ok" : "muted"} />
        <Figure size="sm" value={queue.paidToRate.toLocaleString()} label="paid to rate" sub={`${queue.unpriced} could not be priced against a contract`} tone="muted" />
      </div>

      {/* The queue: what can go today, deadline first. */}
      <Card className="mt-4" title="Ready to send" count={queue.ready.length} subtitle="Paid under the contract figure, inside the window, with the invoice where the PBM wants it. Soonest deadline first.">
        {queue.ready.length === 0 ? (
          <p className="text-sm text-ink-3">Nothing is ready. {queue.held.length > 0 ? "See what holds the rest back, below." : queue.unpriced > 0 ? "Read the contracts so the claims can be priced against them." : "Every priced claim was paid to rate."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table text-sm">
              <thead>
                <tr><th>Claim</th><th>PBM · route</th><th className="num">Paid</th><th className="num">Contract</th><th className="num">Short</th><th className="num">Days left</th><th></th></tr>
              </thead>
              <tbody>
                {queue.ready.slice(0, 100).map((r) => (
                  <tr key={r.claim.claimId}>
                    <td>
                      <span className="block">Rx {r.claim.rxNumber}{r.claim.fillNumber != null ? `-${r.claim.fillNumber}` : ""} · {r.claim.dateFilled}</span>
                      <span className="block text-xs text-ink-3">{r.claim.drugName ?? r.claim.ndc11} · {r.claim.ndc11}</span>
                    </td>
                    <td className="text-xs">{r.claim.pbmName}<span className="block text-ink-3">{r.packet.sendVia.channel ?? "route not stated"}{r.rateNetwork ? ` · ${r.rateNetwork}` : ""}</span></td>
                    <td className="num">{formatCents(r.claim.paidCents)}</td>
                    <td className="num">{formatCents(r.claim.paidCents + r.packet.shortfallCents)}{r.packet.againstCeiling ? "*" : ""}</td>
                    <td className="num font-semibold text-accent">{formatCents(r.packet.shortfallCents)}</td>
                    <td className={`num ${r.packet.daysLeft !== null && r.packet.daysLeft <= 3 ? "text-crit" : ""}`}>{r.packet.daysLeft ?? "—"}</td>
                    <td>
                      {canManage && (
                        <form action={prepareOne}><input type="hidden" name="claimId" value={r.claim.claimId} /><button className="btn btn-sm">Prepare</button></form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {queue.ready.some((r) => r.packet.againstCeiling) && <p className="mt-1 text-[11px] text-ink-3">* a ceiling: the contract's lesser-of includes a MAC the site does not hold, so the figure is the most the claim could have paid.</p>}
          </div>
        )}
      </Card>

      {queue.reasons.length > 0 && (
        <Card className="mt-4" tone="warn" title="What holds the rest back" subtitle="Each reason with the claims and the money behind it. One fix per row.">
          <ul className="rows">
            {queue.reasons.map((r) => (
              <li key={r.reason} className="row">
                <div className="min-w-0"><div className="row-title">{r.reason}</div></div>
                <div className="whitespace-nowrap text-right text-sm tabular-nums">{r.claims} claims · {formatCents(r.cents)}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Prepared and open appeals, with the send and the outcome. */}
      {(prepared.length > 0 || open.length > 0) && (
        <Card className="mt-4" title="Prepared and sent" count={prepared.length + open.length} subtitle="Send goes by the PBM's route; a portal or fax is handed over with the packet to download.">
          <ul className="rows">
            {[...prepared, ...open].map((a) => (
              <li key={a.id} className="row">
                <div className="min-w-0">
                  <div className="row-title">
                    {a.kind === "floor_complaint" ? "Kansas floor complaint" : "MAC appeal"} · {a.pbmName}{a.rxNumber ? ` · Rx ${a.rxNumber}${a.fillNumber != null ? `-${a.fillNumber}` : ""} · ${a.dateFilled}` : ""}
                    <span className={`badge ml-2 ${a.status === "sent" ? "badge-ok" : "badge-muted"}`}>{a.status}</span>
                  </div>
                  <p className="row-why">
                    {formatCents(a.shortfallCents)} short{a.deadline ? ` · window closes ${a.deadline}` : ""}{a.sentAt ? ` · sent ${a.sentAt.slice(0, 10)} by ${a.sentBy}` : ""}{a.responseDueOn ? ` · answer due ${a.responseDueOn}` : ""}
                    {a.sendResult ? ` · ${a.sendResult}` : ""}
                    {a.channel && a.channel !== "email" ? ` · ${a.channel}: ${a.target ?? ""}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {a.documentId && <Link href={`/files/${a.documentId}`} className="btn btn-sm" prefetch={false}>Packet PDF</Link>}
                  {canManage && a.status === "prepared" && a.channel === "email" && (
                    <form action={send}><input type="hidden" name="id" value={a.id} /><SubmitButton pendingLabel="Sending…" className="btn btn-sm btn-primary">Send</SubmitButton></form>
                  )}
                  {canManage && (
                    <form action={outcome} className="flex items-center gap-1">
                      <input type="hidden" name="id" value={a.id} />
                      <select name="status" className="field w-auto px-1 py-0.5 text-[11px]" defaultValue={a.status === "prepared" ? "sent" : "won"}>
                        {a.status === "prepared" && <option value="sent">sent by hand</option>}
                        <option value="answered">answered</option>
                        <option value="won">won</option>
                        <option value="lost">lost</option>
                        <option value="withdrawn">withdrawn</option>
                      </select>
                      <input name="dollars" placeholder="$ back" className="field w-20 px-1 py-0.5 text-[11px]" />
                      <input name="note" placeholder="note" className="field w-28 px-1 py-0.5 text-[11px]" />
                      <button className="btn btn-sm text-[11px]">Record</button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Kansas floor complaints, per plan. */}
      <Card className="mt-4" title="Kansas floor complaints" subtitle="Claims the floor reaches and that paid under it, per plan, as one packet for the Insurance Department's portal.">
        {floor.length === 0 ? (
          <p className="text-sm text-ink-3">No filable floor claims. The <Link href="/claims/floor" className="text-accent underline">Kansas floor</Link> page says what would make some.</p>
        ) : (
          <ul className="rows">
            {floor.map((f) => (
              <li key={f.payer} className="row">
                <div className="min-w-0"><div className="row-title">{f.payer}</div><p className="row-why">{f.claims} claims · {formatCents(f.cents)} under the floor</p></div>
                {canManage && <form action={complaint}><input type="hidden" name="payer" value={f.payer} /><SubmitButton pendingLabel="Preparing…" className="btn btn-sm">Prepare packet</SubmitButton></form>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {closed.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-ink-3 hover:text-accent">{closed.length} closed</summary>
          <ul className="rows mt-2">
            {closed.map((a) => (
              <li key={a.id} className="row">
                <div className="min-w-0"><div className="row-title">{a.pbmName}{a.rxNumber ? ` · Rx ${a.rxNumber}` : ""} <span className="badge badge-muted ml-2">{a.status}</span></div><p className="row-why">{formatCents(a.shortfallCents)} asked{a.outcomeCents != null ? ` · ${formatCents(a.outcomeCents)} back` : ""}{a.outcomeNote ? ` · ${a.outcomeNote}` : ""}</p></div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {list.length === 0 && queue.ready.length === 0 && queue.held.length === 0 && (
        <Empty>Nothing to appeal yet. Read the contracts so each PBM has a rate and an appeal route on file; the queue fills from the claims.</Empty>
      )}
    </>
  );
}
