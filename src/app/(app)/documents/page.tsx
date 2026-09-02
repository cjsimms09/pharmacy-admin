import { isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { daysUntil, fmt } from "@/lib/dates";
import { CREDENTIAL_LABEL, CREDENTIAL_TYPES_FOR_PHARMACY, CREDENTIAL_HINT } from "@/lib/labels";
import { PageHeader, Notice, StatusBadge, Field } from "@/components/ui";
import { DocumentList, UploadForm } from "@/components/documents";
import { addCredential, deleteCredential, updateCredential } from "../staff/actions";

export const metadata = { title: "Documents" };

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requireManager();
  const { error, saved } = await searchParams;
  const [docs, creds] = await Promise.all([
    db.query.documents.findMany({ where: isNull(schema.documents.personId), orderBy: (d, { desc }) => [desc(d.uploadedAt)] }),
    db.query.credentials.findMany({ where: isNull(schema.credentials.personId), orderBy: (c, { asc }) => [asc(c.expiresOn)] }),
  ]);
  const credDocs = (credentialId: string) => docs.filter((d) => d.credentialId === credentialId);
  const here = "/documents";
  const protocols = docs.filter((d) => d.category === "immunization_protocol");
  const others = docs.filter((d) => d.category !== "immunization_protocol" && !d.csInventoryId && !d.credentialId);

  return (
    <>
      <PageHeader title="Pharmacy documents" subtitle="Pharmacy-level registrations, protocols, policies, and inventories. Staff documents live on each person's page." />
      {error && <Notice kind="crit">{error}</Notice>}
      {saved && <Notice>Saved.</Notice>}

      <section className="card mb-6">
        <h2 className="mb-1 font-semibold">Registrations, licenses & insurance</h2>
        <p className="mb-3 text-xs text-ink-3">Anything with an expiration date: pharmacy registration, DEA, CSOS, KMAP, professional liability and property insurance, business license, PSAO and wholesaler agreements. Attach the document itself and the dashboard will warn you 90, 60, 30 and 7 days before it expires.</p>
        {creds.length === 0 ? <p className="text-sm text-ink-3">Nothing on file yet. Add your first one below.</p> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Item</th><th>Number</th><th>Issued</th><th>Expires</th><th>Status</th><th>Document</th><th></th></tr></thead>
              <tbody>
                {creds.map((c) => (
                  <tr key={c.id}>
                    <td><div className="font-medium">{c.type === "other" && c.label ? c.label : CREDENTIAL_LABEL[c.type]}</div>{c.notes && <div className="text-xs text-ink-2">{c.notes}</div>}</td>
                    <td className="font-mono text-xs">{c.number ?? "—"}</td>
                    <td>{fmt(c.issuedOn)}</td>
                    <td>{fmt(c.expiresOn)}</td>
                    <td><StatusBadge days={daysUntil(c.expiresOn)} /></td>
                    <td className="text-xs">
                      {credDocs(c.id).length === 0 ? <span className="text-warn">none attached</span> : credDocs(c.id).map((d) => <div key={d.id}><a href={`/files/${d.id}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">{d.fileName}</a></div>)}
                    </td>
                    <td>
                      <details>
                        <summary className="cursor-pointer text-xs text-accent">Edit</summary>
                        <form action={updateCredential.bind(null, c.id)} className="mt-2 grid gap-2" encType="multipart/form-data">
                          <input type="hidden" name="redirectTo" value={here} />
                          <input type="hidden" name="type" value={c.type} />
                          <input type="hidden" name="label" value={c.label ?? ""} />
                          <input name="number" className="field" defaultValue={c.number ?? ""} placeholder="Number" />
                          <input name="issuer" className="field" defaultValue={c.issuer ?? ""} placeholder="Issuer / carrier" />
                          <label className="text-xs text-ink-2">Issued<input name="issuedOn" type="date" className="field" defaultValue={c.issuedOn ?? ""} /></label>
                          <label className="text-xs text-ink-2">Expires<input name="expiresOn" type="date" className="field" defaultValue={c.expiresOn ?? ""} /></label>
                          <input name="notes" className="field" defaultValue={c.notes ?? ""} placeholder="Notes" />
                          <label className="text-xs text-ink-2">Attach / replace document<input name="file" type="file" className="field" accept=".pdf,.jpg,.jpeg,.png,.heic,.webp,.doc,.docx" /></label>
                          <button className="btn btn-primary">Save</button>
                        </form>
                        <form action={deleteCredential.bind(null, c.id, here)} className="mt-2"><button className="text-xs text-crit hover:underline">Delete</button></form>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <details className="mt-4" open={creds.length === 0}>
          <summary className="cursor-pointer text-sm font-medium text-accent">Add registration, license, insurance policy or agreement</summary>
          <form action={addCredential} className="mt-3 grid gap-3 sm:grid-cols-3" encType="multipart/form-data">
            <input type="hidden" name="redirectTo" value={here} />
            <Field label="Type">
              <select name="type" className="field" defaultValue="pharmacy_registration">
                {CREDENTIAL_TYPES_FOR_PHARMACY.map((t) => <option key={t} value={t}>{CREDENTIAL_LABEL[t]}</option>)}
              </select>
              <p className="hint">{CREDENTIAL_HINT.pharmacy_registration} {CREDENTIAL_HINT.dea_registration}</p>
            </Field>
            <Field label="Name / label" hint="Used as the document title, e.g. “General liability 2026–27”"><input name="label" className="field" /></Field>
            <Field label="Number" hint="Registration, policy or account number"><input name="number" className="field" /></Field>
            <Field label="Issuer / carrier"><input name="issuer" className="field" /></Field>
            <Field label="Issued / effective on"><input name="issuedOn" type="date" className="field" /></Field>
            <Field label="Expires on" hint="What the dashboard counts down to"><input name="expiresOn" type="date" className="field" /></Field>
            <Field label="Document" className="sm:col-span-2" hint="PDF, photo or Word file, up to 20 MB"><input name="file" type="file" className="field" accept=".pdf,.jpg,.jpeg,.png,.heic,.webp,.doc,.docx" /></Field>
            <Field label="Notes"><input name="notes" className="field" /></Field>
            <div className="sm:col-span-3"><button className="btn btn-primary">Add</button></div>
          </form>
        </details>
      </section>

      <section className="card mb-6">
        <h2 className="mb-1 font-semibold">Immunization protocols</h2>
        <p className="mb-3 text-xs text-ink-3">Physician-signed protocols under K.S.A. 65-1635a. Keep each version; set the effective date and, if the protocol has a review date, its expiration.</p>
        <DocumentList docs={protocols} redirectTo={here} canManage />
      </section>

      <section className="card mb-6">
        <h2 className="mb-3 font-semibold">All other pharmacy documents</h2>
        <DocumentList docs={others} redirectTo={here} canManage />
      </section>

      <section className="card">
        <h2 className="mb-3 font-semibold">Upload a pharmacy document</h2>
        <p className="mb-3 text-xs text-ink-3">For anything without an expiration date to track. Items that expire belong in the section above so the dashboard can warn you.</p>
        <UploadForm redirectTo={here} categories={["immunization_protocol", "policy", "agreement", "insurance", "pharmacy_registration", "dea_registration", "controlled_substance_poa", "cs_inventory", "other"]} defaultCategory="immunization_protocol" />
      </section>
    </>
  );
}
