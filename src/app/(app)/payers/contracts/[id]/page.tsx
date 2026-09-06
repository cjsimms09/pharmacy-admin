import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { audit } from "@/lib/audit";
import { proposalsFor, acceptProposals } from "@/lib/contract-docs";
import { PageHeader, Card, Notice, Empty, BackLink } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";

/**
 * One contract's draft as a checklist.
 *
 * Every line is a proposal: a row the site would write, the contract's own sentence beside it,
 * and whether the tables already hold it, hold something different, or hold nothing. Ticked lines
 * are written when the form is sent; nothing else is. A plan match is the one line a machine must
 * never tick by itself, so none is ticked to begin with where another document prints the same BIN.
 */
export default async function ContractReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireReimbursement();
  const user = await requireUser();
  const { id } = await params;
  const { ok, error } = await searchParams;
  const got = await proposalsFor(id);
  if (!got) notFound();
  const { doc, proposals: p } = got;
  const canManage = user.role !== "staff";

  async function accept(fd: FormData) {
    "use server";
    const u = await requireManager();
    const nums = (prefix: string) => fd.getAll(prefix).map((v) => Number(v)).filter((n) => Number.isInteger(n));
    try {
      const r = await acceptProposals(id, { rates: nums("rate"), appeal: fd.get("appeal") === "1", contacts: nums("contact"), routing: fd.get("routing") === "1", plans: nums("plan") }, u);
      await audit({ action: "contracts.accept", userId: u.id, userName: u.name, details: `${id}: ${r.rates} rates, appeal ${r.appeal ? "yes" : "no"}, ${r.contacts} contacts, routing ${r.routing ? "yes" : "no"}, ${r.links} links, ${r.claims} claims re-attributed` });
      revalidatePath("/payers");
      revalidatePath("/claims");
      revalidatePath(`/payers/contracts/${id}`);
      redirect(
        `/payers/contracts/${id}?ok=` +
          encodeURIComponent(
            `Written: ${r.rates} rate${r.rates === 1 ? "" : "s"}${r.appeal ? ", the appeal terms" : ""}, ${r.contacts} contact${r.contacts === 1 ? "" : "s"}${r.routing ? ", the payment path" : ""}, ${r.links} plan link${r.links === 1 ? "" : "s"}${r.links ? ` (${r.claims} claim${r.claims === 1 ? "" : "s"} now attributed)` : ""}.`,
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/payers/contracts/${id}?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not write."));
    }
  }

  const standing = (s: string) => (s === "new" ? <span className="badge badge-ok">new</span> : s === "same" ? <span className="badge badge-muted">already on file</span> : <span className="badge badge-warn">changes what is on file</span>);
  const Quote = ({ q }: { q: string | null }) => (q ? <p className="mt-1 border-l-2 border-line pl-2 text-xs italic text-ink-2">“{q}”</p> : <p className="mt-1 text-xs text-warn">No sentence quoted.</p>);

  return (
    <>
      <BackLink href="/payers/contracts">The contracts</BackLink>
      <PageHeader
        title={doc.documentName}
        subtitle={`${p.pbmName} · read as ${doc.extractionJson ? "a draft with every figure's sentence beside it" : "nothing"}. Tick what is right and send; nothing else is written.`}
      />
      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {p.caveats.length > 0 && (
        <Card className="mt-4" tone="warn" title="What this document cannot settle on its own" count={p.caveats.length}>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">{p.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
        </Card>
      )}

      <form action={accept}>
        <Card className="mt-4" title="Rates" count={p.rates.length} subtitle="One line per vendor, network, tier and days-supply band, as the schedule prints them. A line the site cannot price is shown so you can see the words; it is still a fact worth keeping.">
          {p.rates.length === 0 ? <Empty>No rates in this document. Base agreements often carry none.</Empty> : (
            <ul className="rows">
              {p.rates.map((r, i) => (
                <li key={i} className="py-2">
                  <label className="flex items-start gap-2">
                    {canManage && <input type="checkbox" name="rate" value={i} defaultChecked={r.standing !== "same"} className="mt-1" />}
                    <span className="flex-1">
                      <span className="text-sm font-medium">{r.row.pbmName} · {r.row.lineOfBusiness} · {r.row.network}{r.row.daysSupply ? ` · ${r.row.daysSupply} days` : ""}</span> {standing(r.standing)}
                      <span className="mt-0.5 block text-sm">Brand: {r.row.brandRate ?? "—"}{!r.readable.brand && <span className="badge badge-warn ml-1">cannot price</span>} · Generic: {r.row.genericRate ?? "—"}{!r.readable.generic && <span className="badge badge-warn ml-1">cannot price</span>}</span>
                      {r.existing && <span className="block text-xs text-ink-3">On file: brand {r.existing.brandRate ?? "—"} · generic {r.existing.genericRate ?? "—"}</span>}
                      <Quote q={r.quote} />
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="mt-4" title="MAC appeals" subtitle="The window, what starts it, where the appeal goes, and what it must carry.">
          {!p.appeal ? <Empty>This document says nothing about appeals.</Empty> : (
            <label className="flex items-start gap-2">
              {canManage && <input type="checkbox" name="appeal" value="1" defaultChecked={p.appeal.standing !== "same"} className="mt-1" />}
              <span className="flex-1 text-sm">
                {standing(p.appeal.standing)}
                <span className="mt-0.5 block">{p.appeal.row.appealWindowDays !== null ? `${p.appeal.row.appealWindowDays} days from the ${(p.appeal.row.windowBasis ?? "date of fill").replace(/_/g, " ")}` : "No window stated"}{p.appeal.row.submissionChannel ? ` · via ${p.appeal.row.submissionChannel}` : ""}{p.appeal.row.submissionTarget ? ` · ${p.appeal.row.submissionTarget}` : ""}</span>
                {p.appeal.row.requiredFields && <span className="block text-xs text-ink-2">Must carry: {p.appeal.row.requiredFields}{p.appeal.row.invoiceRequired === "yes" ? "; the invoice" : ""}</span>}
                {p.appeal.row.responseSlaDays !== null && <span className="block text-xs text-ink-2">Answer within {p.appeal.row.responseSlaDays} days{p.appeal.row.adjustmentRetroactive === "yes" ? "; adjustments retroactive" : ""}</span>}
                <Quote q={p.appeal.quote} />
              </span>
            </label>
          )}
        </Card>

        <Card className="mt-4" title="People" count={p.contacts.length} subtitle="Every contact the document names, by what they are for.">
          {p.contacts.length === 0 ? <Empty>No contacts in this document.</Empty> : (
            <ul className="rows">
              {p.contacts.map((c, i) => (
                <li key={i} className="py-2">
                  <label className="flex items-start gap-2">
                    {canManage && <input type="checkbox" name="contact" value={i} defaultChecked={c.standing !== "same"} className="mt-1" />}
                    <span className="flex-1 text-sm">
                      <span className="font-medium">{c.row.contactType.replace(/_/g, " ")}</span> {standing(c.standing)}
                      <span className="block text-xs text-ink-2">{[c.row.phone, c.row.email, c.row.portalUrl, c.row.notes].filter(Boolean).join(" · ")}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="mt-4" title="How the money travels" subtitle="Who pays, how, on what cycle, whether an 835 is offered, and how enrollment is changed. This is what an ERA re-route starts from.">
          {!p.routing ? <Empty>This document says nothing about payment.</Empty> : (
            <label className="flex items-start gap-2">
              {canManage && <input type="checkbox" name="routing" value="1" defaultChecked={p.routing.standing !== "same"} className="mt-1" />}
              <span className="flex-1 text-sm">
                {standing(p.routing.standing)}
                <span className="mt-0.5 block">{[p.routing.row.paysVia && `Paid by ${p.routing.row.paysVia}`, p.routing.row.paymentMethod, p.routing.row.paymentCycle, p.routing.row.remittanceSource].filter(Boolean).join(" · ")}</span>
                {p.routing.row.notes && <span className="block text-xs text-ink-2">{p.routing.row.notes}</span>}
                <Quote q={p.routing.quote} />
              </span>
            </label>
          )}
        </Card>

        <Card className="mt-4" title="The plans this governs" count={p.plans.length} subtitle="Your plans, from the claims, whose BIN and PCN this document prints. A BIN another document also prints is left unticked: you decide which governs it.">
          {p.plans.length === 0 ? <Empty>None of the BINs and PCNs printed in this document appear on the claims held.</Empty> : (
            <ul className="rows">
              {p.plans.map((m, i) => (
                <li key={m.plan.id} className="py-2">
                  <label className="flex items-start gap-2">
                    {canManage && <input type="checkbox" name="plan" value={i} defaultChecked={m.contested.length === 0} className="mt-1" />}
                    <span className="flex-1 text-sm">
                      <span className="font-mono">{m.plan.bin} / {m.plan.pcn ?? "—"} / {m.plan.groupNumber ?? "—"}</span>
                      {m.plan.payerLabel && <span className="ml-2 text-ink-2">{m.plan.payerLabel}</span>}
                      <span className="ml-2 text-xs text-ink-3">{m.plan.claims} claim{m.plan.claims === 1 ? "" : "s"} · matched on {m.matchedOn.join(", ")}</span>
                      {m.contested.length > 0 && <span className="block text-xs text-warn">Also printed in: {m.contested.join(", ")}. Pick one.</span>}
                      <span className="block text-xs text-ink-3">{m.proposedLink.basis}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {canManage && (
          <div className="mt-4 flex items-center gap-2">
            <SubmitButton className="btn btn-primary" pendingLabel="Writing…">Accept what is ticked</SubmitButton>
            <Link href="/payers/contracts" className="btn">Back</Link>
            <span className="text-xs text-ink-3">Rates, appeal terms, contacts and the payment path go to {p.pbmName}&rsquo;s payer page; plan links attribute the claims held.</span>
          </div>
        )}
      </form>
    </>
  );
}
