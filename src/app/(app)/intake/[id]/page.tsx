import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { CREDENTIAL_TYPES, DOCUMENT_CATEGORIES, TRAINING_TYPES } from "@/db/schema";
import { requireManager } from "@/lib/auth";
import { fmt, todayIso } from "@/lib/dates";
import { CREDENTIAL_LABEL, DOCUMENT_CATEGORY_LABEL, TRAINING_LABEL } from "@/lib/labels";
import { PageHeader, BackLink, Notice, Field } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import type { ClassifiedDocT } from "@/lib/ai";
import { applyIntake, deleteIntake, dismissIntake, retryIntake } from "../actions";
import { KindPicker } from "./kind-picker";
import { DocumentViewer } from "./viewer";
import { BusinessReview } from "./business-review";
import { BUSINESS_KINDS, type BusinessDocT } from "@/lib/business-docs";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  person_credential: "A licence, card or certificate belonging to a person",
  person_training: "Annual training for a person (FWA, HIPAA, OSHA)",
  pharmacy_credential: "A pharmacy-level registration, insurance or agreement",
  cqi_incident: "A CQI incident form",
  cqi_summary: "A CQI bimonthly summary",
  cs_inventory: "A controlled substance inventory",
  policy: "A policy or protocol",
  report: "A report",
  unknown: "Just file it in the vault",
};

export default async function IntakeReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; as?: string }> }) {
  await requireManager();
  const { id } = await params;
  const { error, as } = await searchParams;
  const item = await db.query.intakeItems.findFirst({ where: eq(schema.intakeItems.id, id) });
  if (!item) notFound();
  const [doc, people] = await Promise.all([
    db.query.documents.findFirst({ where: eq(schema.documents.id, item.documentId) }),
    db.query.people.findMany({ where: eq(schema.people.active, true), orderBy: (p, { asc }) => [asc(p.lastName)] }),
  ]);
  const business = parseBusiness(item.resultJson);
  const r = parse(item.resultJson);
  const matched = r?.personName ? matchPerson(r.personName, people) : null;
  const failed = item.status === "failed";
  const low = r ? r.confidence < 0.6 : true;
  const completedGuess = r?.issuedOn ?? todayIso();

  return (
    <>
      <BackLink href="/intake">Add documents</BackLink>
      <PageHeader
        title={r?.title || doc?.fileName || "Document"}
        subtitle={doc ? `${doc.fileName} · ${(doc.sizeBytes / 1024).toFixed(0)} KB` : undefined}
        actions={<a href="/intake" className="btn">Add another</a>}
      />
      {error && <Notice kind="crit">{error}</Notice>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
        {/* The document, kept beside the form and in view while it is scrolled. */}
        <div className="lg:sticky lg:top-6">
          {doc ? (
            <DocumentViewer src={`/files/${doc.id}`} mimeType={doc.mimeType} fileName={doc.fileName} />
          ) : (
            <Notice kind="warn">The file is missing from the vault.</Notice>
          )}
          {doc && (
            <p className="mt-2 text-xs text-ink-3">
              {doc.fileName} · {(doc.sizeBytes / 1024).toFixed(0)} KB · added {fmt(doc.uploadedAt.slice(0, 10))}
            </p>
          )}
        </div>

        <div className="min-w-0">
      {failed ? (
        <section className="card">
          <h2 className="font-semibold text-crit">Claude could not read this one</h2>
          <p className="mt-1 text-sm text-ink-2">{item.error}</p>
          <p className="mt-2 text-sm">The file is safely in the vault either way. Try again, or file it by hand from the page it belongs to.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <form action={retryIntake.bind(null, id)}><button className="btn btn-primary">Try again</button></form>
            <form action={dismissIntake.bind(null, id)}><button className="btn">Leave it in the vault</button></form>
            <form action={deleteIntake.bind(null, id)}>
              <ConfirmButton className="btn btn-danger" message="Delete this file entirely?">Delete the file</ConfirmButton>
            </form>
          </div>
        </section>
      ) : item.status === "applied" ? (
        <section className="card">
          <h2 className="font-semibold">Filed</h2>
          <p className="mt-1 text-sm text-ink-2">{appliedSummary(item.resultJson) ?? "This one has been filed."}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href="/intake" className="btn btn-primary">Back to the queue</a>
            {appliedWhere(item.resultJson) && <a href={appliedWhere(item.resultJson)!} className="btn">See it there</a>}
          </div>
        </section>
      ) : business ? (
        <BusinessReview
          id={id}
          doc={{ fileName: doc?.fileName ?? "file" }}
          read={business}
          as={as && (BUSINESS_KINDS as readonly string[]).includes(as) ? (as as (typeof BUSINESS_KINDS)[number]) : business.kind}
          suppliers={(await (await import("@/lib/suppliers-registry")).allSuppliers(true)).map((s) => ({ id: s.id, name: s.name, alsoKnownAs: s.catalogName ?? null }))}
          vendors={(await (await import("@/lib/expenses")).vendors()).map((v) => ({ id: v.id, name: v.name, categoryId: v.categoryId }))}
          categories={await (async () => {
            // The chart of accounts, seeded here if Spending has never been opened, so a bill can be filed from the first day.
            const x = await import("@/lib/expenses");
            if ((await x.categories()).length === 0) await x.seedCategories();
            return (await x.categories()).map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
          })()}
          error={error}
        />
      ) : (
        <>
          {r?.notes && <Notice kind={low ? "warn" : "ok"}>{r.notes}</Notice>}
          {low && <Notice kind="warn">Claude was not confident about this one. Check every field below before filing.</Notice>}

          <form action={applyIntake.bind(null, id)} className="space-y-5">
            <section className="card">
              <h2 className="mb-3 font-semibold">Where does it belong?</h2>
              <KindPicker
                initialKind={r?.kind ?? "unknown"}
                labels={KIND_LABEL}
                person={
                  <Field label="Whose is it?" hint={r?.personName ? `The document reads “${r.personName}”.` : undefined}>
                    <select name="personId" className="field" defaultValue={matched?.id ?? ""}>
                      <option value="">— choose a person —</option>
                      {people.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
                    </select>
                  </Field>
                }
                credential={
                  <>
                    <Field label="What kind of credential">
                      <select name="credentialType" className="field" defaultValue={r?.credentialType ?? "other"}>
                        {CREDENTIAL_TYPES.map((t) => <option key={t} value={t}>{CREDENTIAL_LABEL[t]}</option>)}
                      </select>
                    </Field>
                    <label className="flex items-start gap-2 text-sm">
                      <input type="checkbox" name="replaceExisting" defaultChecked className="mt-1" />
                      <span>
                        Update the existing record if there is one
                        <span className="block text-xs text-ink-3">A renewal replaces the old dates rather than leaving two rows on the file.</span>
                      </span>
                    </label>
                  </>
                }
                training={
                  <>
                    <Field label="Which training">
                      <select name="trainingType" className="field" defaultValue={r?.trainingType ?? "fwa_general_compliance"}>
                        {TRAINING_TYPES.map((t) => <option key={t} value={t}>{TRAINING_LABEL[t]}</option>)}
                      </select>
                    </Field>
                    <Field label="Completed on"><input name="completedOn" type="date" className="field" defaultValue={completedGuess} /></Field>
                    <Field label="Counts for which year" hint="The compliance year this satisfies.">
                      <input name="cycleYear" type="number" className="field" defaultValue={completedGuess.slice(0, 4)} />
                    </Field>
                  </>
                }
                ce={
                  <>
                    <Field label="Completed on"><input name="completedOn" type="date" className="field" defaultValue={completedGuess} /></Field>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="isBoardCourse" defaultChecked={r?.isBoardCourse ?? false} /> The Board&apos;s required 1-hour course
                    </label>
                  </>
                }
              />
            </section>

            <section className="card grid gap-3 sm:grid-cols-2">
              <h2 className="font-semibold sm:col-span-2">What is on it</h2>
              <Field label="Title" className="sm:col-span-2"><input name="title" className="field" defaultValue={r?.title ?? doc?.fileName ?? ""} required /></Field>
              <Field label="Number" hint="Licence, registration, certificate or DEA number."><input name="number" className="field" defaultValue={r?.number ?? ""} /></Field>
              <Field label="Issued by"><input name="issuer" className="field" defaultValue={r?.issuer ?? ""} /></Field>
              <Field label="Issued on"><input name="issuedOn" type="date" className="field" defaultValue={r?.issuedOn ?? ""} /></Field>
              <Field label="Expires on" hint="Drives the 90/60/30/7-day reminders.">
                <input name="expiresOn" type="date" className="field" defaultValue={r?.expiresOn ?? ""} />
              </Field>
              <Field label="Label" hint="Only needed when the kind above is “other”."><input name="label" className="field" /></Field>
              <Field label="Filed under">
                <select name="category" className="field" defaultValue={r?.category ?? "other"}>
                  {DOCUMENT_CATEGORIES.map((c) => <option key={c} value={c}>{DOCUMENT_CATEGORY_LABEL[c]}</option>)}
                </select>
              </Field>
              <Field label="Notes" className="sm:col-span-2"><input name="notes" className="field" defaultValue={r?.notes ?? ""} /></Field>
            </section>

            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary" type="submit">File it</button>
              <span className="grow" />
              <form action={dismissIntake.bind(null, id)}><button className="btn" formNoValidate>Leave it in the vault</button></form>
              <form action={deleteIntake.bind(null, id)}>
                <ConfirmButton className="btn btn-danger" message="Delete this file entirely?">Delete</ConfirmButton>
              </form>
            </div>
          </form>
        </>
      )}

        </div>
      </div>

      <p className="mt-6 text-xs text-ink-3">
        The file is already stored safely. Filing it only decides where it appears and what dates it drives.
      </p>
    </>
  );
}

/** What a filed item did, for the card: the report's summary, or the business filing's outcome. */
function appliedSummary(json: string): string | null {
  try {
    const v = JSON.parse(json) as { summary?: string; outcome?: string; routedAs?: string };
    return v.outcome ?? v.summary ?? (v.routedAs ? `Loaded as ${v.routedAs.replace(/_/g, " ")}.` : null);
  } catch {
    return null;
  }
}
function appliedWhere(json: string): string | null {
  try {
    const v = JSON.parse(json) as { filedAs?: string; routedAs?: string };
    const k = v.filedAs ?? v.routedAs;
    if (!k) return null;
    return { remittance: "/claims", bill: "/expenses", wholesaler_invoice: "/inventory/invoices", rebate_statement: "/expenses", claims: "/claims", rx_transactions: "/claims", accrual_sales: "/money", on_hand: "/purchasing/shelf", rebate_report: "/suppliers", purchase_drilldown: "/suppliers", nadac: "/nadac", supplier_catalog: "/purchasing", pioneer_catalog: "/purchasing" }[k] ?? null;
  } catch {
    return null;
  }
}

function parseBusiness(json: string): BusinessDocT | null {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && v.kind === "business" && v.doc ? (v.doc as BusinessDocT) : null;
  } catch {
    return null;
  }
}

function parse(json: string): ClassifiedDocT | null {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && "kind" in v ? (v as ClassifiedDocT) : null;
  } catch {
    return null;
  }
}

function matchPerson(name: string, people: { id: string; firstName: string; lastName: string }[]) {
  const n = name.trim().toLowerCase();
  return (
    people.find((p) => `${p.firstName} ${p.lastName}`.toLowerCase() === n) ??
    people.find((p) => n.includes(p.lastName.toLowerCase()) && n.includes(p.firstName.toLowerCase())) ??
    people.find((p) => n.includes(p.lastName.toLowerCase())) ??
    null
  );
}
