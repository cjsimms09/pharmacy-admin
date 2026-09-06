import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager, requireUser } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { routingRows, requestEnrollment, setEnrollment, saveTin } from "@/lib/era-enrollment";
import { PageHeader, Card, Notice, Empty, Figure, Field } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "835 routing" };

/** Back to the page with a message. At module scope, so a server action references it rather than captures it. */
function back(msg: string, kind: "ok" | "error" = "ok"): never {
  redirect(`/payers/routing?${kind}=${encodeURIComponent(msg)}`);
}

/**
 * Getting each PBM's 835 delivered here.
 *
 * The contract says how a PBM pays and where its remittance lives; the change is an enrollment
 * on the PBM's side, and the site's part is to ask for it properly and keep the checklist. One
 * request per PBM, written from what is on file, sent where the contract names an address, and
 * three dates after it: requested, confirmed, first 835 received.
 */
export default async function RoutingPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireReimbursement();
  const user = await requireUser();
  const { ok, error } = await searchParams;
  const { rows, identity } = await routingRows();
  const canManage = user.role === "owner" || user.role === "pic";

  async function request(fd: FormData) {
    "use server";
    const u = await requireManager();
    try {
      const r = await requestEnrollment(String(fd.get("pbm") ?? ""), u);
      revalidatePath("/payers/routing");
      back(r.how, r.sent ? "ok" : "error");
    } catch (e) {
      if (e instanceof Error && e.message.includes("NEXT_REDIRECT")) throw e;
      back(e instanceof Error ? e.message : String(e), "error");
    }
  }
  async function status(fd: FormData) {
    "use server";
    const u = await requireManager();
    const pbm = String(fd.get("pbm") ?? "");
    const st = String(fd.get("status") ?? "") as "not_started" | "requested" | "confirmed" | "receiving" | "declined";
    if (!pbm || !["not_started", "requested", "confirmed", "receiving", "declined"].includes(st)) back("Pick a state.", "error");
    await setEnrollment(pbm, st, String(fd.get("note") ?? "").trim() || null, u);
    revalidatePath("/payers/routing");
    back("Recorded.");
  }
  async function tin(fd: FormData) {
    "use server";
    await requireManager();
    await saveTin(String(fd.get("tin") ?? ""));
    revalidatePath("/payers/routing");
    back("TIN saved.");
  }

  const receiving = rows.filter((r) => r.enrollment?.status === "receiving").length;
  const requested = rows.filter((r) => r.enrollment?.status === "requested" || r.enrollment?.status === "confirmed").length;
  const ready = rows.filter((r) => !r.enrollment && r.missing.length === 0).length;

  return (
    <>
      <PageHeader
        title="835 routing"
        subtitle="Getting each PBM's remittance delivered to this site: the request, written from what is on file, and where each one stands."
        back={{ href: "/payers", label: "Payers" }}
      />
      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure value={rows.length} label="payers with a payment path on file" sub="from the contracts read" tone="muted" />
        <Figure value={ready} label="ready to request" sub="identity complete and an address to send to" tone={ready ? "ok" : "muted"} />
        <Figure value={requested} label="requested or confirmed" sub="waiting for the first 835" tone={requested ? "warn" : "muted"} />
        <Figure value={receiving} label="delivering here" sub="first 835 received" tone={receiving ? "ok" : "muted"} />
      </div>

      <Card className="mt-4" title="What every request carries" subtitle="From Settings and the mailbox. A request with a blank in it is not sent.">
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-ink-3">Pharmacy</dt><dd>{identity.name}{identity.address ? `, ${identity.address}` : ""}</dd></div>
          <div><dt className="text-xs text-ink-3">NCPDP · NPI</dt><dd>{identity.ncpdp ?? <span className="text-crit">missing</span>} · {identity.npi ?? <span className="text-crit">missing</span>}</dd></div>
          <div><dt className="text-xs text-ink-3">Delivery point</dt><dd>{identity.mailbox ?? <span className="text-crit">no mailbox configured</span>}</dd></div>
          <div>
            <dt className="text-xs text-ink-3">TIN</dt>
            <dd>
              {canManage ? (
                <form action={tin} className="flex items-center gap-1">
                  <input name="tin" defaultValue={identity.tin ?? ""} placeholder="00-0000000" className="field w-36 px-1 py-0.5 text-sm font-mono" />
                  <button className="btn btn-sm">Save</button>
                </form>
              ) : (
                identity.tin ?? "missing"
              )}
            </dd>
          </div>
        </dl>
      </Card>

      {rows.length === 0 ? (
        <Empty>No payment routing on file yet. Read the contracts and apply what is certain; each PBM's payment path lands here.</Empty>
      ) : (
        <div className="mt-4 space-y-3">
          {rows.map((r) => {
            const st = r.enrollment?.status ?? "not_started";
            return (
              <Card key={r.pbmName} title={r.pbmName} count={st.replace(/_/g, " ")} tone={st === "receiving" ? "ok" : st === "requested" || st === "confirmed" ? "warn" : undefined}
                subtitle={[r.paysVia && `pays via ${r.paysVia}`, r.paymentMethod, r.remittanceSource && `remittance from ${r.remittanceSource}`, r.paymentCycle].filter(Boolean).join(" · ") || "no payment path read yet"}
                actions={
                  canManage && (
                    <form action={status} className="flex items-center gap-1">
                      <input type="hidden" name="pbm" value={r.pbmName} />
                      <select name="status" defaultValue={st} className="field w-auto px-1 py-0.5 text-[11px]">
                        {(["not_started", "requested", "confirmed", "receiving", "declined"] as const).map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
                      </select>
                      <input name="note" placeholder="note" className="field w-28 px-1 py-0.5 text-[11px]" />
                      <button className="btn btn-sm text-[11px]">Record</button>
                    </form>
                  )
                }
              >
                <div className="grid gap-3 text-sm lg:grid-cols-2">
                  <div>
                    <p className="text-xs text-ink-3">Contacts on file</p>
                    {r.contacts.length === 0 ? <p className="text-ink-3">none</p> : (
                      <ul className="text-xs">
                        {r.contacts.map((c, i) => <li key={i}>{c.contactType.replace(/_/g, " ")}: {[c.email, c.phone, c.portalUrl].filter(Boolean).join(" · ") || "—"}</li>)}
                      </ul>
                    )}
                    {r.enrollment && (
                      <p className="mt-2 text-xs text-ink-2">
                        {r.enrollment.requestedOn && `Requested ${r.enrollment.requestedOn}${r.enrollment.requestedTo ? ` to ${r.enrollment.requestedTo}` : ""}. `}
                        {r.enrollment.confirmedOn && `Confirmed ${r.enrollment.confirmedOn}. `}
                        {r.enrollment.firstRemitOn && `First 835 ${r.enrollment.firstRemitOn}. `}
                        {r.enrollment.notes}
                        {r.enrollment.documentId && <> <Link href={`/files/${r.enrollment.documentId}`} className="text-accent underline" prefetch={false}>the letter</Link></>}
                      </p>
                    )}
                  </div>
                  <div>
                    {r.missing.length > 0 ? (
                      <p className="text-xs text-warn">Before a request can go: {r.missing.join("; ")}.</p>
                    ) : canManage && st === "not_started" ? (
                      <form action={request}>
                        <input type="hidden" name="pbm" value={r.pbmName} />
                        <SubmitButton pendingLabel="Sending…" className="btn btn-sm btn-primary">Send the enrollment request to {r.requestEmail}</SubmitButton>
                        <p className="mt-1 text-[11px] text-ink-3">A letter with the NCPDP, NPI, TIN and the delivery point, filed here and attached.</p>
                      </form>
                    ) : (
                      <p className="text-xs text-ink-3">Request goes to {r.requestEmail}.</p>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <p className="mt-4 text-xs text-ink-3">
        Where a PBM enrols only through its portal or a form, the letter is still filed so the same facts can be pasted; record the state here when it is done.
      </p>
    </>
  );
}
