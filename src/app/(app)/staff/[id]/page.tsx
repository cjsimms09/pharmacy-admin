import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { daysUntil, fmt } from "@/lib/dates";
import { CREDENTIAL_HINT, CREDENTIAL_LABEL, CREDENTIAL_TYPES_FOR_PERSON, PERSON_ROLE_LABEL } from "@/lib/labels";
import { PageHeader, BackLink, Notice, StatusBadge, Field } from "@/components/ui";
import { DocumentList, UploadForm } from "@/components/documents";
import { PersonForm } from "../person-form";
import { addCe, addCredential, deleteCe, deleteCredential, updateCredential, updatePerson } from "../actions";

// Live compliance status — never serve a cached copy after an action changes it.
export const dynamic = "force-dynamic";

export default async function PersonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string; edit?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { error, saved, edit } = await searchParams;
  if (user.role === "staff" && user.personId !== id) redirect("/staff");
  const canManage = user.role !== "staff";

  const person = await db.query.people.findFirst({ where: eq(schema.people.id, id) });
  if (!person) notFound();
  const [creds, docs, ce] = await Promise.all([
    db.query.credentials.findMany({ where: eq(schema.credentials.personId, id), orderBy: (c, { asc }) => [asc(c.expiresOn)] }),
    db.query.documents.findMany({ where: eq(schema.documents.personId, id), orderBy: (d, { desc }) => [desc(d.uploadedAt)] }),
    db.query.ceEntries.findMany({ where: eq(schema.ceEntries.personId, id), orderBy: (c, { desc }) => [desc(c.completedOn)] }),
  ]);
  const here = `/staff/${id}`;
  const credDocs = (credentialId: string) => docs.filter((d) => d.credentialId === credentialId);
  const license = creds.find((c) => c.type === "pharmacist_license" || c.type === "technician_registration");
  const ceRequired = person.role === "pharmacist" ? 30 : person.role === "technician" ? 20 : 0;
  // CE in the current cycle: entries after the license issue date (or last two years if unknown)
  const cycleStart = license?.issuedOn ?? null;
  const ceInCycle = ce.filter((e) => !cycleStart || e.completedOn >= cycleStart);
  const ceHours = ceInCycle.reduce((s, e) => s + e.hours, 0) / 10;
  const boardCourseDone = ceInCycle.some((e) => e.isBoardCourse);

  return (
    <>
      <BackLink href="/staff">Staff</BackLink>
      <PageHeader
        title={`${person.firstName} ${person.lastName}`}
        subtitle={`${PERSON_ROLE_LABEL[person.role]}${person.title ? ` · ${person.title}` : ""}${person.isPic ? " · Pharmacist-in-Charge" : ""}${person.active ? "" : " · inactive"}`}
        actions={canManage && !edit ? <a href={`${here}?edit=1`} className="btn">Edit details</a> : undefined}
      />
      {error && <Notice kind="crit">{error}</Notice>}
      {saved && <Notice>Saved.</Notice>}

      {edit && canManage && (
        <section className="card mb-6 max-w-2xl">
          <h2 className="mb-3 font-semibold">Edit details</h2>
          <PersonForm action={updatePerson.bind(null, id)} person={person} submitLabel="Save" />
        </section>
      )}

      <section className="card mb-6">
        <h2 className="mb-1 font-semibold">Licenses, registrations & certifications</h2>
        <p className="mb-3 text-xs text-ink-3">Add the license, CPR card, immunization training certificate or DEA power of attorney with its expiration date and attach the document itself. Expirations appear on the dashboard 90, 60, 30 and 7 days ahead.</p>
        {creds.length === 0 ? <p className="text-sm text-ink-3">Nothing on file yet.</p> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Credential</th><th>Number</th><th>Issued</th><th>Expires</th><th>Status</th><th>Document</th><th></th></tr></thead>
              <tbody>
                {creds.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="font-medium">{c.type === "other" && c.label ? c.label : CREDENTIAL_LABEL[c.type]}</div>
                      {c.issuer && <div className="text-xs text-ink-3">{c.issuer}</div>}
                      {c.notes && <div className="text-xs text-ink-2">{c.notes}</div>}
                    </td>
                    <td className="font-mono text-xs">{c.number ?? "—"}</td>
                    <td>{fmt(c.issuedOn)}</td>
                    <td>{fmt(c.expiresOn)}</td>
                    <td><StatusBadge days={daysUntil(c.expiresOn)} /></td>
                    <td className="text-xs">
                      {credDocs(c.id).length === 0 ? <span className="text-warn">none attached</span> : credDocs(c.id).map((d) => <div key={d.id}><a href={`/files/${d.id}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">{d.fileName}</a></div>)}
                    </td>
                    <td>
                      {canManage && (
                        <details>
                          <summary className="cursor-pointer text-xs text-accent">Edit</summary>
                          <CredentialForm action={updateCredential.bind(null, c.id)} redirectTo={here} cred={c} />
                          <form action={deleteCredential.bind(null, c.id, here)} className="mt-2"><button className="text-xs text-crit hover:underline">Delete</button></form>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canManage && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium text-accent">Add credential</summary>
            <CredentialForm action={addCredential} redirectTo={here} personId={id} />
          </details>
        )}
      </section>

      {ceRequired > 0 && (
        <section className="card mb-6">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold">Continuing education</h2>
            <div className="text-sm">
              <span className={ceHours >= ceRequired ? "badge badge-ok" : "badge badge-warn"}>{ceHours.toFixed(1)} / {ceRequired} hours</span>
              {person.role === "pharmacist" && <span className={`badge ml-2 ${boardCourseDone ? "badge-ok" : "badge-warn"}`}>{boardCourseDone ? "Board course done" : "Board course needed"}</span>}
            </div>
          </div>
          <p className="mb-3 text-xs text-ink-3">
            {person.role === "pharmacist" ? "30 clock hours per biennium including the 1-hour Board-provided course; no carryover (K.A.R. 68-1-1b)." : "20 hours per two-year period ending October 31; non-ACPE certificates submitted within 30 days (K.A.R. 68-5-18)."}
            {cycleStart ? ` Counting entries since ${fmt(cycleStart)} (license issue date).` : " Set the license issue date to count only the current cycle."}
          </p>
          {ce.length > 0 && (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>Date</th><th>Course</th><th>Provider / ACPE #</th><th>Hours</th><th></th></tr></thead>
                <tbody>
                  {ce.map((e) => (
                    <tr key={e.id} className={cycleStart && e.completedOn < cycleStart ? "opacity-60" : ""}>
                      <td>{fmt(e.completedOn)}</td>
                      <td>{e.title}{e.isBoardCourse && <span className="badge badge-ok ml-2">Board course</span>}{e.isLive && <span className="badge badge-muted ml-2">live</span>}</td>
                      <td className="text-xs text-ink-2">{e.provider ?? ""}{e.acpeNumber ? ` · ${e.acpeNumber}` : ""}</td>
                      <td>{(e.hours / 10).toFixed(1)}</td>
                      <td>{canManage && <form action={deleteCe.bind(null, e.id, id)}><button className="text-xs text-crit hover:underline">Delete</button></form>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canManage && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium text-accent">Add CE entry</summary>
              <form action={addCe} className="mt-3 grid gap-3 sm:grid-cols-3">
                <input type="hidden" name="personId" value={id} />
                <Field label="Completed on"><input name="completedOn" type="date" className="field" required /></Field>
                <Field label="Hours"><input name="hours" type="number" step="0.1" min="0.1" className="field" required /></Field>
                <Field label="Course title" className="sm:col-span-3"><input name="title" className="field" required /></Field>
                <Field label="Provider"><input name="provider" className="field" /></Field>
                <Field label="ACPE / UAN number"><input name="acpeNumber" className="field" /></Field>
                <div className="flex flex-col justify-end gap-1 text-sm">
                  <label className="flex items-center gap-2"><input type="checkbox" name="isBoardCourse" /> Board-provided 1-hour course</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="isLive" /> Live</label>
                </div>
                <div className="sm:col-span-3"><button className="btn btn-primary">Add</button></div>
              </form>
            </details>
          )}
        </section>
      )}

      <section className="card">
        <h2 className="mb-3 font-semibold">Documents</h2>
        <p className="mb-3 text-xs text-ink-3">License and registration cards, CPR card, immunization training certificate, CE certificates.</p>
        <DocumentList docs={docs} redirectTo={here} canManage={canManage} />
        {canManage && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium text-accent">Upload document</summary>
            <div className="mt-3">
              <UploadForm redirectTo={here} hidden={{ personId: id }} categories={["license", "cpr_card", "immunization_training", "ce_certificate", "controlled_substance_poa", "other"]} defaultCategory="license" />
            </div>
          </details>
        )}
      </section>
    </>
  );
}

function CredentialForm({ action, redirectTo, personId, cred }: { action: (fd: FormData) => Promise<void>; redirectTo: string; personId?: string; cred?: { type: string; label: string | null; number: string | null; issuer: string | null; issuedOn: string | null; expiresOn: string | null; notes: string | null } }) {
  return (
    <form action={action} className="mt-3 grid gap-3 sm:grid-cols-3" encType="multipart/form-data">
      <input type="hidden" name="redirectTo" value={redirectTo} />
      {personId && <input type="hidden" name="personId" value={personId} />}
      <Field label="Type">
        <select name="type" className="field" defaultValue={cred?.type ?? "pharmacist_license"}>
          {CREDENTIAL_TYPES_FOR_PERSON.map((t) => <option key={t} value={t}>{CREDENTIAL_LABEL[t]}</option>)}
        </select>
        <p className="hint">{Object.values(CREDENTIAL_HINT).length ? "Kansas cycles: pharmacist Jun 30 biennial · technician Oct 31 biennial · intern 6 years · CPR per card" : ""}</p>
      </Field>
      <Field label="Label (for 'other')"><input name="label" className="field" defaultValue={cred?.label ?? ""} /></Field>
      <Field label="Number"><input name="number" className="field" defaultValue={cred?.number ?? ""} /></Field>
      <Field label="Issuer"><input name="issuer" className="field" placeholder="Kansas Board of Pharmacy, AHA, …" defaultValue={cred?.issuer ?? ""} /></Field>
      <Field label="Issued on"><input name="issuedOn" type="date" className="field" defaultValue={cred?.issuedOn ?? ""} /></Field>
      <Field label="Expires on"><input name="expiresOn" type="date" className="field" defaultValue={cred?.expiresOn ?? ""} /></Field>
      <Field label={cred ? "Attach / replace document" : "Document"} className="sm:col-span-2" hint="The license card, CPR card, training certificate or protocol. PDF, photo or Word file.">
        <input name="file" type="file" className="field" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.gif,.bmp,.tif,.tiff,.doc,.docx,.rtf,image/*" />
      </Field>
      <Field label="Notes"><input name="notes" className="field" defaultValue={cred?.notes ?? ""} /></Field>
      <div className="sm:col-span-3"><button className="btn btn-primary">{cred ? "Save" : "Add"}</button></div>
    </form>
  );
}
