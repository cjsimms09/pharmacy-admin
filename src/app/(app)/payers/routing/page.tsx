import { familyTabs } from "@/lib/families";
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
  const ready = rows.filter((r) => (r.enrollment?.status ?? "not_started") === "not_started" && r.request.ready).length;
  /* A payer nothing on file explains how to enrol with. It is a real number and it is the work. */
  const unknown = rows.filter((r) => r.request.route.how === "unknown").length;

  return (
    <>
      <PageHeader
        tabs={familyTabs("payers", "/payers/routing")}
        title="835 routing"
        subtitle="Getting each PBM's remittance delivered to this site: the request, written from what is on file, and where each one stands."
      />
      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure value={rows.length} label="payers with a payment path on file" sub="from the contracts read" tone="muted" />
        <Figure value={ready} label="ready to request" sub="identity complete and a way in" tone={ready ? "ok" : "muted"} />
        <Figure value={unknown} label="no way in on file" sub="nothing read says how they enrol" tone={unknown ? "warn" : "muted"} />
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
                    {/*
                      What to do about this payer, in one sentence, before anything else on the card.
                      Twenty payers each with a different half-finished enrolment is a list nobody
                      works through; twenty sentences saying what is next is.
                    */}
                    <p className="text-sm font-medium text-ink">{r.request.nextAction}</p>
                    <p className="mt-0.5 text-[11px] text-ink-3">
                      {r.request.route.why}
                      {r.request.route.how === "form" || r.request.route.how === "portal" ? (
                        r.request.route.target ? (
                          <> <a href={r.request.route.target} target="_blank" rel="noreferrer" className="text-accent underline">open it</a></>
                        ) : null
                      ) : null}
                    </p>

                    {r.missing.length > 0 && (
                      <ul className="mt-2 list-disc pl-4 text-xs text-warn">
                        {r.missing.map((m, i) => <li key={i}>{m}</li>)}
                      </ul>
                    )}

                    {/*
                      A portal is somebody else's website and this will not drive it. What it can do
                      is put every answer on one screen in the order a form asks for them, so the job
                      is copying rather than hunting through Settings, a contract and a bank letter.
                      A value nobody has filled in shows as missing, because a blank box on a form is
                      how a field gets skipped and the enrolment comes back rejected.
                    */}
                    {(r.request.route.how === "form" || r.request.route.how === "portal") && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-accent hover:underline">What to type into it</summary>
                        <dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
                          {r.request.fields.map((f) => (
                            <div key={f.label}>
                              <dt className="text-ink-3">{f.label}</dt>
                              <dd className="font-mono">{f.value ?? <span className="font-sans text-crit">missing</span>}</dd>
                              {f.note && <dd className="text-[11px] text-ink-3">{f.note}</dd>}
                            </div>
                          ))}
                        </dl>
                      </details>
                    )}

                    {canManage && st === "not_started" && r.missing.length === 0 && r.request.letter && (
                      <form action={request} className="mt-2">
                        <input type="hidden" name="pbm" value={r.pbmName} />
                        <SubmitButton pendingLabel="Sending…" className="btn btn-sm btn-primary">Send the enrollment request</SubmitButton>
                        <p className="mt-1 text-[11px] text-ink-3">Filed here and attached, so what was asked and when is on the record whatever comes back.</p>
                      </form>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <p className="mt-4 text-xs text-ink-3">
        How each request travels is decided by what that payer&rsquo;s contract printed: a form&rsquo;s address first, then a
        portal, then an address for a letter. Nothing the contract did not say is filled in — a request sent with a guessed
        NPI or a guessed trading-partner id is answered weeks later with a rejection nobody connects back to the guess. And
        nothing leaves this site on its own; every one of these is a person pressing a button.
      </p>
    </>
  );
}
