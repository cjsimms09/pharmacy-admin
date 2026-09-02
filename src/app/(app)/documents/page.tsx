import { isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { daysUntil, fmt } from "@/lib/dates";
import { CREDENTIAL_LABEL, CREDENTIAL_TYPES_FOR_PHARMACY, CREDENTIAL_HINT } from "@/lib/labels";
import { PageHeader, Notice, StatusBadge, Field } from "@/components/ui";
import { DocumentList, UploadForm } from "@/components/documents";
import { addCredential, deleteCredential } from "../staff/actions";

export const metadata = { title: "Documents" };

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requireManager();
  const { error, saved } = await searchParams;
  const [docs, creds] = await Promise.all([
    db.query.documents.findMany({ where: isNull(schema.documents.personId), orderBy: (d, { desc }) => [desc(d.uploadedAt)] }),
    db.query.credentials.findMany({ where: isNull(schema.credentials.personId), orderBy: (c, { asc }) => [asc(c.expiresOn)] }),
  ]);
  const here = "/documents";
  const protocols = docs.filter((d) => d.category === "immunization_protocol");
  const others = docs.filter((d) => d.category !== "immunization_protocol" && !d.csInventoryId);

  return (
    <>
      <PageHeader title="Pharmacy documents" subtitle="Pharmacy-level registrations, protocols, policies, and inventories. Staff documents live on each person's page." />
      {error && <Notice kind="crit">{error}</Notice>}
      {saved && <Notice>Saved.</Notice>}

      <section className="card mb-6">
        <h2 className="mb-3 font-semibold">Pharmacy registrations</h2>
        {creds.length === 0 ? <p className="text-sm text-ink-3">Add the pharmacy registration, DEA registration, CSOS certificate, and KMAP enrollment so their renewals are tracked.</p> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Registration</th><th>Number</th><th>Issued</th><th>Expires</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {creds.map((c) => (
                  <tr key={c.id}>
                    <td><div className="font-medium">{c.type === "other" && c.label ? c.label : CREDENTIAL_LABEL[c.type]}</div>{c.notes && <div className="text-xs text-ink-2">{c.notes}</div>}</td>
                    <td className="font-mono text-xs">{c.number ?? "—"}</td>
                    <td>{fmt(c.issuedOn)}</td>
                    <td>{fmt(c.expiresOn)}</td>
                    <td><StatusBadge days={daysUntil(c.expiresOn)} /></td>
                    <td><form action={deleteCredential.bind(null, c.id, here)}><button className="text-xs text-crit hover:underline">Delete</button></form></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-accent">Add registration</summary>
          <form action={addCredential} className="mt-3 grid gap-3 sm:grid-cols-3">
            <input type="hidden" name="redirectTo" value={here} />
            <Field label="Type">
              <select name="type" className="field" defaultValue="pharmacy_registration">
                {CREDENTIAL_TYPES_FOR_PHARMACY.map((t) => <option key={t} value={t}>{CREDENTIAL_LABEL[t]}</option>)}
              </select>
              <p className="hint">{CREDENTIAL_HINT.pharmacy_registration} {CREDENTIAL_HINT.dea_registration}</p>
            </Field>
            <Field label="Label (for 'other')"><input name="label" className="field" /></Field>
            <Field label="Number"><input name="number" className="field" /></Field>
            <Field label="Issuer"><input name="issuer" className="field" /></Field>
            <Field label="Issued on"><input name="issuedOn" type="date" className="field" /></Field>
            <Field label="Expires on"><input name="expiresOn" type="date" className="field" /></Field>
            <Field label="Notes" className="sm:col-span-3"><input name="notes" className="field" /></Field>
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
        <UploadForm redirectTo={here} categories={["immunization_protocol", "pharmacy_registration", "dea_registration", "controlled_substance_poa", "cs_inventory", "policy", "other"]} defaultCategory="immunization_protocol" />
      </section>
    </>
  );
}
