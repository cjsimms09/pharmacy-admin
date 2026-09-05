import Link from "next/link";
import { isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { splitSuperseded } from "@/lib/superseded";
import { daysUntil, fmt, todayIso } from "@/lib/dates";
import { CREDENTIAL_LABEL, CREDENTIAL_TYPES_FOR_PHARMACY, CREDENTIAL_HINT } from "@/lib/labels";
import { PageHeader, Notice, StatusBadge, Field, Figure, Card, Empty, History } from "@/components/ui";
import { addCredential, deleteCredential, updateCredential } from "../staff/actions";

export const metadata = { title: "Licences and registrations" };
export const dynamic = "force-dynamic";

/**
 * Everything the pharmacy holds that expires.
 *
 * It used to be the first block on a page called Documents, underneath a heading, above the
 * immunization protocols and a general upload box. That is filing by file type rather than by
 * consequence: the DEA registration and a scanned policy are not the same kind of object, because
 * only one of them closes the pharmacy when it lapses.
 *
 * So they live here, sorted by what expires soonest, with a countdown on each and the document
 * itself attached. The question this page answers from the doorway is "is anything about to
 * run out", and it answers it in the first line.
 */
export default async function LicensesPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requireManager();
  const { error, saved } = await searchParams;
  const [creds, docs, s] = await Promise.all([
    db.query.credentials.findMany({ where: isNull(schema.credentials.personId), orderBy: (c, { asc }) => [asc(c.expiresOn)] }),
    db.query.documents.findMany({ where: isNull(schema.documents.personId) }),
    getSettings(),
  ]);
  const here = "/licenses";
  const credDocs = (credentialId: string) => docs.filter((d) => d.credentialId === credentialId);

  /*
   * Replaced registrations, folded away.
   *
   * Every renewal leaves last year's certificate behind, and after a few years this page is mostly
   * expired paper — which is exactly the state in which the one that was never renewed stops being
   * visible.
   *
   * So the fold is drawn at replacement, not at expiry. A registration that ran out and was
   * renewed goes behind it; one that ran out with nothing after it stays at the top in red,
   * because that is the row this page exists for.
   */
  const split = splitSuperseded(creds, todayIso(), {
    key: (c) => `${c.type}:${c.label ?? ""}`,
    endsOn: (c) => (c.noExpiry ? null : (c.expiresOn ?? null)),
  });

  // Counted on what is in force, never on the history behind it: a renewed registration must not
  // add to "Lapsed", or the figure that is supposed to mean "go and fix this" means nothing.
  const live = split.current;
  const dated = live.filter((c) => c.expiresOn);
  const lapsed = dated.filter((c) => (daysUntil(c.expiresOn) ?? 1) < 0);
  const soon = dated.filter((c) => { const d = daysUntil(c.expiresOn); return d !== null && d >= 0 && d <= 90; });
  const noDate = live.filter((c) => !c.expiresOn);
  const noDoc = live.filter((c) => credDocs(c.id).length === 0);

  // The two the pharmacy cannot open without. Worth naming rather than leaving in a list.
  const critical = [
    { type: "pharmacy_registration" as const, label: "Kansas pharmacy registration", number: s.pharmacy_registration_number },
    { type: "dea_registration" as const, label: "DEA registration", number: s.pharmacy_dea },
  ].map((k) => ({ ...k, cred: creds.find((c) => c.type === k.type) }));

  const credRow = (c: (typeof creds)[number]) => (
                <tr key={c.id}>
                  <td>
                    <div className="font-medium">{c.type === "other" && c.label ? c.label : CREDENTIAL_LABEL[c.type]}</div>
                    {c.issuer && <div className="text-xs text-ink-3">{c.issuer}</div>}
                    {c.notes && <div className="text-xs text-ink-2">{c.notes}</div>}
                  </td>
                  <td className="font-mono text-xs">{c.number ?? "—"}</td>
                  <td className="text-xs">{fmt(c.issuedOn)}</td>
                  <td className="text-xs">{c.expiresOn ? fmt(c.expiresOn) : <span className="text-warn">none</span>}</td>
                  <td>{c.expiresOn ? <StatusBadge days={daysUntil(c.expiresOn)} /> : <span className="badge badge-warn">no date</span>}</td>
                  <td className="text-xs">
                    {credDocs(c.id).length === 0 ? <span className="text-warn">none attached</span> : credDocs(c.id).map((d) => (
                      <div key={d.id}><a href={`/files/${d.id}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">{d.fileName}</a></div>
                    ))}
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
  );

  return (
    <>
      <PageHeader
        title="Licences and registrations"
        subtitle="Everything this pharmacy holds that has an expiry date, soonest first. The dashboard counts down from 90, 60, 30 and 7 days before each one."
        actions={
          <>
            <Link href="/documents" className="btn">Pharmacy documents</Link>
            <Link href="/staff" className="btn">Individual licences</Link>
          </>
        }
      />
      {error && <Notice kind="crit">{error}</Notice>}
      {saved && <Notice kind="ok">Saved.</Notice>}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure value={lapsed.length} label="Lapsed" sub={lapsed.length ? "Expired and not replaced" : "Nothing has run out"} tone={lapsed.length ? "crit" : "ok"} />
        <Figure value={soon.length} label="Within 90 days" sub="Renew before it is urgent" tone={soon.length ? "warn" : "ok"} />
        <Figure value={noDoc.length} label="No document attached" sub="A number without the certificate behind it" tone={noDoc.length ? "warn" : "ok"} />
        <Figure value={noDate.length} label="No expiry recorded" sub={noDate.length ? "Nothing can warn you about these" : "Every item has a date"} tone={noDate.length ? "warn" : "ok"} />
      </div>

      <Card title="The two that close the pharmacy" subtitle="Everything else is a problem. These two are a closed door, so they get their own line." className="mb-6">
        <ul className="rows">
          {critical.map((k) => (
            <li key={k.type} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-sm font-medium">{k.label}</span>
              <span className="flex items-center gap-3 text-xs text-ink-3">
                <span className="font-mono">{k.cred?.number || k.number || "no number recorded"}</span>
                {k.cred?.expiresOn ? (
                  <>
                    <span>expires {fmt(k.cred.expiresOn)}</span>
                    <StatusBadge days={daysUntil(k.cred.expiresOn)} />
                  </>
                ) : (
                  <span className="badge badge-crit">not on file here</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Everything with an expiry date" count={split.current.length} subtitle="Pharmacy registration, DEA, CSOS, KMAP, professional liability and property insurance, business licence, PSAO and wholesaler agreements.">
        {creds.length === 0 ? (
          <Empty>Nothing on file yet. Add the first one below.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Item</th><th>Number</th><th>Issued</th><th>Expires</th><th>Status</th><th>Document</th><th></th></tr></thead>
              <tbody>
                {split.current.map(credRow)}
              </tbody>
            </table>
            <History label="Replaced by a newer registration" count={split.history.length}>
              <table className="table">
                <thead><tr><th>Item</th><th>Number</th><th>Issued</th><th>Expires</th><th>Status</th><th>Document</th><th></th></tr></thead>
                <tbody>{split.history.map(credRow)}</tbody>
              </table>
            </History>
          </div>
        )}

        <details className="mt-4" open={creds.length === 0}>
          <summary className="cursor-pointer text-sm font-medium text-accent">Add a registration, licence, insurance policy or agreement</summary>
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
      </Card>
    </>
  );
}
