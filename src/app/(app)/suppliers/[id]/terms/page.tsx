import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fmt, todayIso } from "@/lib/dates";
import {
  parseTierLines,
  parseCreditLines,
  parseList,
  describeRebate,
  describeReturns,
  readRebateTerms,
  readReturnTerms,
  rebateTierFor,
  type RebateTermsT,
  type ReturnTermsT,
} from "@/lib/supplier-terms";
import { rebateProgramsFor, returnPoliciesFor, saveRebateProgram, saveReturnPolicy } from "@/lib/supplier-terms-store";
import { lastRebateStatement } from "@/lib/rebate-report-store";
import { PageHeader, Card, Notice, Field } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { getSettings, setSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const metadata = { title: "Supplier terms" };

/**
 * A supplier's rebate schedule and return policy, typed in from the agreement.
 *
 * Neither is on any feed. The catalogue says what an item costs; only the rebate schedule says
 * what it costs after the tier comes off, and only the return policy says what a bottle on the
 * shelf is still worth. Both are entered here against the supplier, with the date they took
 * effect, and every earlier version is kept below — a rebate paid last quarter was earned under
 * last quarter's ladder.
 *
 * Tiers and credit steps are typed one per line rather than in a grid, because that is how they
 * are printed on the schedule and how somebody reads them down the phone. Every line has to
 * parse; a line that does not is quoted back, and nothing is saved until it does.
 */
export default async function SupplierTermsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { ok, error } = await searchParams;
  const supplier = await db.query.suppliers.findFirst({ where: eq(schema.suppliers.id, id) });
  if (!supplier) notFound();
  const canManage = user.role !== "staff";

  const [rebates, returns, settings] = await Promise.all([rebateProgramsFor(id), returnPoliciesFor(id), getSettings()]);
  // The proof, where this supplier's ladder was read from a report rather than typed.
  const filed = await lastRebateStatement();
  // A policy read but not yet confirmed. It fills the form; it is not stored terms.
  const draft = (() => {
    const raw = settings.returns_policy_draft;
    if (!raw) return null;
    try {
      const d = JSON.parse(raw) as import("@/lib/ai").ReadReturnPolicyT & { supplierId: string; fileName: string; readAt: string };
      // A draft belongs to the supplier it was read for. Showing another's would fill this form
      // with somebody else's terms.
      return d.supplierId === id ? d : null;
    } catch {
      return null;
    }
  })();
  const statement = filed && /mckesson/i.test(supplier.name) ? filed : null;
  const today = todayIso();
  const currentRebate = rebates.find((r) => r.effectiveFrom <= today && (r.effectiveTo === null || r.effectiveTo >= today)) ?? rebates[0] ?? null;
  const currentReturn = returns.find((r) => r.effectiveFrom <= today && (r.effectiveTo === null || r.effectiveTo >= today)) ?? returns[0] ?? null;
  const rebateTerms = currentRebate ? readRebateTerms(currentRebate.termsJson) : null;
  const returnTerms = currentReturn ? readReturnTerms(currentReturn.termsJson) : null;

  async function saveRebate(fd: FormData) {
    "use server";
    const u = await requireManager();
    const supplierId = String(fd.get("supplierId") ?? "");
    const tiers = parseTierLines(String(fd.get("tiers") ?? ""));
    if (tiers.problems.length) redirect(`/suppliers/${supplierId}/terms?error=` + encodeURIComponent(tiers.problems.join(" ")));
    const terms = {
      kind: tiers.tiers.length > 1 ? "tiered_ratio" : "flat_percent",
      period: String(fd.get("period") ?? "quarter"),
      eligibility: String(fd.get("eligibility") ?? "catalog_rebate_flag"),
      ratioDefinition: String(fd.get("ratioDefinition") ?? "").trim() || null,
      tiers: tiers.tiers,
      paidAs: String(fd.get("paidAs") ?? "").trim() || null,
      notes: String(fd.get("termNotes") ?? "").trim() || null,
    };
    try {
      await saveRebateProgram(
        supplierId,
        { name: String(fd.get("name") ?? ""), effectiveFrom: String(fd.get("effectiveFrom") ?? ""), notes: String(fd.get("notes") ?? "") },
        terms,
        u,
      );
      await audit({ action: "supplier.rebate.save", userId: u.id, userName: u.name, entity: "supplier", entityId: supplierId, details: String(fd.get("name") ?? "") });
      revalidatePath(`/suppliers/${supplierId}/terms`);
      revalidatePath("/suppliers");
      redirect(`/suppliers/${supplierId}/terms?ok=` + encodeURIComponent("Rebate schedule saved. Anything current before it is closed the day before this one starts."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/suppliers/${supplierId}/terms?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not save that."));
    }
  }

  /**
   * Reads a returned-goods policy PDF and fills the form below from it.
   *
   * A rebate breakdown is a grid of figures that checks itself, so it is read by rule. A returns
   * policy is paragraphs of conditions, and two real ones — McKesson's and IPC's — yield almost no
   * readable text at all: twenty-seven characters of fragments from one of them. So the document
   * goes to the model as a document.
   *
   * What comes back is a proposal, never a saved fact. Every figure is quoted back to the sentence
   * it came from, so it can be checked against the page rather than believed; nothing is stored
   * until the form below is submitted. A returns policy decides whether a bottle is worth sending
   * back or throwing away, and a figure nobody checked is not worth having.
   */
  async function readPolicy(fd: FormData) {
    "use server";
    const u = await requireManager();
    const file = fd.get("policy");
    if (!(file instanceof File) || file.size === 0) {
      redirect(`/suppliers/${id}/terms?error=` + encodeURIComponent("Choose the policy PDF first."));
    }
    try {
      const { readReturnPolicy } = await import("@/lib/ai");
      const read = await readReturnPolicy(Buffer.from(await file.arrayBuffer()), supplier!.name, { userId: u.id, userName: u.name });
      await audit({ action: "supplier.returns.read", userId: u.id, userName: u.name, entity: "supplier", entityId: id, details: file.name });
      await setSetting("returns_policy_draft", JSON.stringify({ ...read, supplierId: id, fileName: file.name, readAt: new Date().toISOString() }));
      revalidatePath(`/suppliers/${id}/terms`);
      redirect(
        `/suppliers/${id}/terms?ok=` +
          encodeURIComponent(
            `Read ${file.name}. Check each figure against the quote beside it, then save — nothing is stored until you do.` +
              (read.unclear.length ? ` ${read.unclear.length} thing${read.unclear.length === 1 ? " was" : "s were"} left unsettled.` : ""),
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/suppliers/${id}/terms?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not read that policy."));
    }
  }

  async function saveReturns(fd: FormData) {
    "use server";
    const u = await requireManager();
    const supplierId = String(fd.get("supplierId") ?? "");
    const steps = parseCreditLines(String(fd.get("creditSteps") ?? ""));
    if (steps.problems.length) redirect(`/suppliers/${supplierId}/terms?error=` + encodeURIComponent(steps.problems.join(" ")));
    const num = (k: string) => {
      const s = String(fd.get(k) ?? "").trim();
      if (!s) return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : NaN;
    };
    const terms = {
      windowMonthsBeforeExpiry: num("windowBefore"),
      windowMonthsAfterExpiry: num("windowAfter"),
      creditSteps: steps.steps,
      restockingFeePercent: num("restockingFee"),
      nonReturnable: parseList(String(fd.get("nonReturnable") ?? "")),
      reverseDistributor: String(fd.get("reverseDistributor") ?? "").trim() || null,
      notes: String(fd.get("termNotes") ?? "").trim() || null,
    };
    try {
      await saveReturnPolicy(
        supplierId,
        { name: String(fd.get("name") ?? ""), effectiveFrom: String(fd.get("effectiveFrom") ?? ""), notes: String(fd.get("notes") ?? "") },
        terms,
        u,
      );
      await audit({ action: "supplier.returns.save", userId: u.id, userName: u.name, entity: "supplier", entityId: supplierId });
      revalidatePath(`/suppliers/${supplierId}/terms`);
      revalidatePath("/suppliers");
      await setSetting("returns_policy_draft", "");
      redirect(`/suppliers/${supplierId}/terms?ok=` + encodeURIComponent("Return policy saved."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(`/suppliers/${supplierId}/terms?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not save that."));
    }
  }

  return (
    <>
      <PageHeader
        back={{ href: "/suppliers", label: "Suppliers" }}
        title={`${supplier.name} — rebate and return terms`}
        subtitle="From the agreement, or read off the supplier's own rebate report, with the date each took effect. Earlier versions are kept: a rebate paid last quarter was earned under last quarter's schedule."
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {/*
        Where the ladder came from, and the arithmetic that says it was read correctly.
        "How do I know it did it right" is a fair question about eleven bands nobody typed, and an
        answer nobody can see is not an answer. So the checks the report passed are shown, with the
        document beside them: the achieved rate must land in a band paying what the statement says
        it paid, and that rate on those purchases must be the money at the bottom of the page.
      */}
      {statement && (
        <Card
          className="mb-4"
          title="Read from the supplier's own rebate report"
          subtitle={
            statement.periodFrom
              ? `The breakdown for ${fmt(statement.periodFrom)}${statement.filedAt ? `, filed ${fmt(statement.filedAt.slice(0, 10))}` : ""}. Nothing here was typed.`
              : "Nothing here was typed."
          }
        >
          <ul className="space-y-1 text-sm">
            {(statement.checks ?? []).map((c) => (
              <li key={c.what} className="flex gap-2">
                <span className={`badge ${c.ok ? "badge-ok" : "badge-crit"}`}>{c.ok ? "agrees" : "does not agree"}</span>
                <span className="text-ink-2">{c.detail}</span>
              </li>
            ))}
          </ul>
          {(statement.standing ?? []).length > 0 && (
            <div className="mt-3 rounded-md border border-line bg-ground p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">Where this leaves you</p>
              <ul className="mt-1 space-y-1 text-sm text-ink-2">
                {(statement.standing ?? []).map((l) => <li key={l}>{l}</li>)}
              </ul>
            </div>
          )}
          <p className="mt-3 text-xs text-ink-3">
            {statement.tierCount ? `${statement.tierCount} bands were read off it. ` : ""}
            {statement.documentId ? (
              <a href={`/files/${statement.documentId}`} target="_blank" rel="noreferrer" className="text-accent underline">
                Open the report this came from
              </a>
            ) : (
              "The report itself was not kept as a document — it arrived before that was recorded."
            )}
          </p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Rebate schedule" subtitle={rebateTerms ? `${currentRebate!.name}, in force from ${fmt(currentRebate!.effectiveFrom)}.` : "Nothing recorded yet, so a comparison cannot take any rebate off this supplier's prices."}>
          {rebateTerms && <RebateSummary terms={rebateTerms} />}
          {rebates.length > 1 && (
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-ink-3">Earlier schedules ({rebates.length - 1})</summary>
              <ul className="mt-1 space-y-1">
                {rebates.filter((r) => r.id !== currentRebate?.id).map((r) => {
                  const t = readRebateTerms(r.termsJson);
                  return (
                    <li key={r.id}>
                      <b>{r.name}</b> · {fmt(r.effectiveFrom)} to {r.effectiveTo ? fmt(r.effectiveTo) : "open"} · {t ? describeRebate(t) : "terms no longer readable"}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
          {canManage && (
            <form action={saveRebate} className="mt-4 grid gap-3">
              <input type="hidden" name="supplierId" value={supplier.id} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Programme name" hint="As the supplier calls it.">
                  <input name="name" required className="field" defaultValue={currentRebate?.name ?? ""} placeholder="OneStop generics" />
                </Field>
                <Field label="Takes effect on">
                  <input name="effectiveFrom" type="date" required className="field" defaultValue={today} />
                </Field>
                <Field label="Measured and paid">
                  <select name="period" className="field" defaultValue={rebateTerms?.period ?? "quarter"}>
                    <option value="month">Monthly</option>
                    <option value="quarter">Quarterly</option>
                    <option value="year">Annually</option>
                  </select>
                </Field>
                <Field label="What earns it">
                  <select name="eligibility" className="field" defaultValue={rebateTerms?.eligibility ?? "catalog_rebate_flag"}>
                    <option value="catalog_rebate_flag">Items the catalogue marks rebated (McKesson OneStop)</option>
                    <option value="all_generics">All generics</option>
                    <option value="all_purchases">All purchases</option>
                  </select>
                </Field>
              </div>
              <Field
                label="Tiers, one per line — ratio threshold then rebate"
                hint='e.g. "0% -> 1%", "14% -> 2.5%", "16% -> 3.5%". Not cumulative: the ratio lands in a tier and every eligible purchase earns that tier. A flat programme is one line: "0 -> 2".'
              >
                <textarea
                  name="tiers"
                  rows={5}
                  required
                  className="field font-mono text-xs"
                  defaultValue={rebateTerms ? rebateTerms.tiers.map((t) => `${t.thresholdPercent}% -> ${t.rebatePercent}%`).join("\n") : ""}
                  placeholder={"0% -> 1%\n14% -> 2.5%\n16% -> 3.5%"}
                />
              </Field>
              <Field label="How the supplier defines the ratio" hint="Their words: what is in the numerator, what is in the denominator, what is excluded.">
                <input name="ratioDefinition" className="field" defaultValue={rebateTerms?.ratioDefinition ?? ""} placeholder="OneStop generic purchases ÷ total Rx purchases, excluding drop-ship and returns" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Paid as">
                  <input name="paidAs" className="field" defaultValue={rebateTerms?.paidAs ?? ""} placeholder="Credit memo the month after quarter end" />
                </Field>
                <Field label="Anything else that changes the money">
                  <input name="termNotes" className="field" defaultValue={rebateTerms?.notes ?? ""} placeholder="Minimum commitments, promotional windows, exclusions" />
                </Field>
              </div>
              <Field label="Where these numbers came from" hint="The document name in the private folder, or who confirmed them. Never the numbers' source document itself.">
                <input name="notes" className="field" defaultValue={currentRebate?.notes ?? ""} />
              </Field>
              <div>
                <button className="btn btn-primary">Save rebate schedule</button>
              </div>
            </form>
          )}
        </Card>

        <Card title="Return policy" subtitle={returnTerms ? `${currentReturn!.name}, in force from ${fmt(currentReturn!.effectiveFrom)}.` : "Nothing recorded yet, so nothing can say what a return to this supplier is worth."}>
          {/*
            The policy as a document, read for you.

            These arrive as prose, and often as PDFs whose text cannot be pulled out at all, so
            this is the one place here where a model reads a supplier document. It proposes; the
            form below is what stores anything.
          */}
          <form action={readPolicy} className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-line bg-ground p-3">
            <span className="text-xs text-ink-2">Have the policy as a PDF? Read it and fill the form in.</span>
            <input type="file" name="policy" accept=".pdf" className="text-xs" />
            <SubmitButton className="btn btn-sm" pendingLabel="Reading…">Read the policy</SubmitButton>
          </form>
          {draft && (
            <div className="mb-3 rounded-md border border-accent bg-accent-soft p-3 text-xs">
              <p className="font-semibold text-accent">Read from {draft.fileName} — check each figure against its quote, then save below.</p>
              <ul className="mt-1 space-y-1 text-ink-2">
                {draft.quotes.map((q) => (
                  <li key={q.field + q.sentence}><b>{q.field}:</b> &ldquo;{q.sentence}&rdquo;</li>
                ))}
              </ul>
              {draft.unclear.length > 0 && (
                <p className="mt-2 text-warn">
                  Not settled by the policy: {draft.unclear.join("; ")}. Those are left empty rather than guessed.
                </p>
              )}
            </div>
          )}
          {returnTerms && <p className="text-sm">{describeReturns(returnTerms)}</p>}
          {returnTerms?.reverseDistributor && <p className="mt-1 text-xs text-ink-3">Outside the window: {returnTerms.reverseDistributor}.</p>}
          {returns.length > 1 && (
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-ink-3">Earlier policies ({returns.length - 1})</summary>
              <ul className="mt-1 space-y-1">
                {returns.filter((r) => r.id !== currentReturn?.id).map((r) => {
                  const t = readReturnTerms(r.termsJson);
                  return (
                    <li key={r.id}>
                      <b>{r.name}</b> · {fmt(r.effectiveFrom)} to {r.effectiveTo ? fmt(r.effectiveTo) : "open"} · {t ? describeReturns(t) : "terms no longer readable"}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
          {canManage && (
            <form action={saveReturns} className="mt-4 grid gap-3">
              <input type="hidden" name="supplierId" value={supplier.id} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Policy name">
                  <input name="name" className="field" defaultValue={currentReturn?.name ?? "Return policy"} />
                </Field>
                <Field label="Takes effect on">
                  <input name="effectiveFrom" type="date" required className="field" defaultValue={today} />
                </Field>
                <Field label="Earliest: months before expiry" hint="Leave blank if the policy does not say.">
                  <input name="windowBefore" type="number" step="0.5" min="0" className="field" defaultValue={returnTerms?.windowMonthsBeforeExpiry ?? ""} placeholder="6" />
                </Field>
                <Field label="Latest: months after expiry" hint="0 means nothing after expiry.">
                  <input name="windowAfter" type="number" step="0.5" min="0" className="field" defaultValue={returnTerms?.windowMonthsAfterExpiry ?? ""} placeholder="6" />
                </Field>
              </div>
              <Field
                label="Credit steps, one per line — months to expiry then credit"
                hint='e.g. "6 -> 100%", "0 -> 50%", "-6 -> 25%": at least that many months left earns that credit. Negative months are after expiry.'
              >
                <textarea
                  name="creditSteps"
                  rows={4}
                  className="field font-mono text-xs"
                  defaultValue={returnTerms ? returnTerms.creditSteps.map((s) => `${s.monthsToExpiryMin} -> ${s.creditPercent}%`).join("\n") : ""}
                  placeholder={"6 -> 100%\n0 -> 50%"}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Restocking fee, percent">
                  <input name="restockingFee" type="number" step="0.5" min="0" max="100" className="field" defaultValue={returnTerms?.restockingFeePercent ?? ""} />
                </Field>
                <Field label="Reverse distributor" hint="Who takes what the supplier will not.">
                  <input name="reverseDistributor" className="field" defaultValue={returnTerms?.reverseDistributor ?? ""} />
                </Field>
              </div>
              <Field label="Never returnable" hint="In the policy's words, separated by commas or lines.">
                <textarea name="nonReturnable" rows={2} className="field text-xs" defaultValue={returnTerms?.nonReturnable.join("\n") ?? ""} placeholder={"refrigerated\ncontrolled Schedule II\npartial bottles\nshort-dated at purchase"} />
              </Field>
              <Field label="Anything else">
                <input name="termNotes" className="field" defaultValue={returnTerms?.notes ?? ""} />
              </Field>
              <Field label="Where this came from">
                <input name="notes" className="field" defaultValue={currentReturn?.notes ?? ""} />
              </Field>
              <div>
                <button className="btn btn-primary">Save return policy</button>
              </div>
            </form>
          )}
        </Card>
      </div>

      <p className="mt-4 text-xs text-ink-3">
        Prices, invoices and these terms all hang off this supplier. If a catalogue arrives under a different spelling,{" "}
        <Link href={`/suppliers?edit=${supplier.id}#edit`} className="text-accent hover:underline">
          record that spelling as the catalogue name
        </Link>{" "}
        so it is filed here too.
      </p>
    </>
  );
}

function RebateSummary({ terms }: { terms: RebateTermsT }) {
  const example = rebateTierFor(terms, 15);
  return (
    <div className="text-sm">
      <p>{describeRebate(terms)}</p>
      {terms.ratioDefinition && <p className="mt-1 text-xs text-ink-3">Ratio: {terms.ratioDefinition}</p>}
      {terms.paidAs && <p className="mt-1 text-xs text-ink-3">Paid as {terms.paidAs}.</p>}
      {terms.kind === "tiered_ratio" && example && (
        <p className="mt-1 text-xs text-ink-3">
          Check: a ratio of 15% would earn {example.rebatePercent}% on every eligible purchase in the period.
        </p>
      )}
    </div>
  );
}

// Keeps the type import used, for the summary of a return policy in the card header.
export type { ReturnTermsT };
