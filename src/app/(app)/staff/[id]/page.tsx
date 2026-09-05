import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { daysUntil, fmt, todayIso } from "@/lib/dates";
import {
  CREDENTIAL_HINT,
  CREDENTIAL_LABEL,
  CREDENTIAL_TYPES_FOR_PERSON,
  PERSON_ROLE_LABEL,
  TRAINING_LABEL,
  requiredCredentials,
} from "@/lib/labels";
import { PageHeader, Card, Figure, Notice, StatusBadge, Field, History } from "@/components/ui";
import { splitSuperseded } from "@/lib/superseded";
import { DocumentList, UploadForm } from "@/components/documents";
import { retentionFor } from "@/lib/offboarding";
import { openRequestsFor } from "@/lib/credential-requests";
import { requestCredentialAction } from "../../_actions/compliance";
import { PersonForm } from "../person-form";
import {
  addCredential,
  deleteCredential,
  updateCredential,
  updatePerson,
  endEmploymentAction,
  reinstateAction,
  markSighted,
} from "../actions";
import type { CredentialType } from "@/db/schema";

// Live compliance status — never serve a cached copy after an action changes it.
export const dynamic = "force-dynamic";

/**
 * One person's file.
 *
 * Organised around the question actually being asked of it, which is never "list this person's
 * credentials" — it is "is this person allowed to be working, and what is missing". So the page
 * opens with what they are required to hold, whether or not anything has been recorded, and a
 * missing requirement is a row with an Add button on it rather than an absence you have to
 * notice. The previous version listed only what existed, which meant the one state that matters
 * most — nothing on file — was invisible on the very page you would go to fix it.
 */
export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; edit?: string; add?: string; fix?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { error, saved, edit, add, fix } = await searchParams;
  if (user.role === "staff" && user.personId !== id) redirect("/staff");
  const canManage = user.role !== "staff";

  const person = await db.query.people.findFirst({ where: eq(schema.people.id, id) });
  if (!person) notFound();

  const [creds, docs, retention, trainings, assignments, asked] = await Promise.all([
    db.query.credentials.findMany({ where: eq(schema.credentials.personId, id), orderBy: (c, { asc }) => [asc(c.expiresOn)] }),
    db.query.documents.findMany({ where: eq(schema.documents.personId, id), orderBy: (d, { desc }) => [desc(d.uploadedAt)] }),
    retentionFor(id),
    db.query.trainings.findMany({ where: eq(schema.trainings.personId, id), orderBy: (t, { desc }) => [desc(t.completedOn)] }),
    db.query.trainingAssignments.findMany({ where: eq(schema.trainingAssignments.personId, id) }),
    openRequestsFor(id),
  ]);

  const here = `/staff/${id}`;
  const credDocs = (credentialId: string) => docs.filter((d) => d.credentialId === credentialId);
  const required = requiredCredentials(person.role, person.administersVaccines);

  /** The best record held for a requirement — the one with the furthest expiry. */
  const heldFor = (type: CredentialType) =>
    creds.filter((c) => c.type === type).sort((a, b) => (b.expiresOn ?? "9999").localeCompare(a.expiresOn ?? "9999"))[0];

  const gaps = required.filter((t) => {
    const h = heldFor(t);
    if (!h) return true;
    if (h.noExpiry) return false;
    if (!h.expiresOn) return t !== "immunization_training";
    return daysUntil(h.expiresOn)! < 0;
  }).length;

  const extras = creds.filter((c) => !required.includes(c.type) || creds.filter((x) => x.type === c.type).length > 1);

  /*
   * Replaced records, folded away — not expired ones.
   *
   * Every renewal leaves the previous certificate behind, and after a few years the page is mostly
   * history. It all has to be kept and has to be findable; it does not have to be at eye level.
   *
   * The line is drawn at replacement rather than expiry, deliberately. A licence that ran out and
   * was renewed is history. A licence that ran out and was never renewed is the most important
   * thing on this page and stays exactly where it is.
   */
  const today = todayIso();
  const extraSplit = splitSuperseded(extras, today, {
    key: (c) => `${c.type}:${c.label ?? ""}`,
    endsOn: (c) => (c.noExpiry ? null : (c.expiresOn ?? null)),
  });
  const trainingSplit = splitSuperseded(trainings, today, {
    key: (t) => t.type,
    endsOn: (t) => t.expiresOn ?? null,
  });
  const fixing = fix ? creds.find((c) => c.id === fix) : undefined;

  const license = heldFor(person.role === "pharmacist" ? "pharmacist_license" : "technician_registration");

  /*
   * Counted on the current record, not on the history behind it.
   *
   * Annual training means somebody who is perfectly up to date still has four expired HIPAA rows
   * on file. Counting those as lapsed made a compliant person look overdue, and a figure that
   * cries wolf every year is one nobody reads.
   */
  const trainingDue = trainingSplit.current.filter((t) => t.expiresOn && daysUntil(t.expiresOn)! < 0).length;

  return (
    <>
      <PageHeader
        back={{ href: "/staff", label: "Staff" }}
        title={`${person.firstName} ${person.lastName}`}
        subtitle={[
          PERSON_ROLE_LABEL[person.role],
          person.title,
          person.isPic ? "Pharmacist-in-Charge" : null,
          person.administersVaccines ? "administers vaccines" : null,
          person.active ? null : `inactive since ${fmt(person.endedOn)}`,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          canManage && !edit ? (
            <>
              <Link href="/compliance/training" className="btn">Send training</Link>
              {/*
                Offered for everybody, not only people already ticked as immunizers.
                
                It was gated on that checkbox, which meant the one person most likely to want it —
                somebody about to be authorised for the first time, whose record does not say
                immunizer yet — was the one person who could not see the button. The page itself
                says if they are not marked as one; a hidden control cannot say anything.
              */}
              <Link href={`${here}/protocol`} className="btn btn-primary">Immunization protocol</Link>
              <Link href={`${here}?edit=1`} className="btn">Edit details</Link>
            </>
          ) : undefined
        }
      />

      {error && <Notice kind="crit">{error}</Notice>}
      {saved && <Notice>{saved === "1" ? "Saved." : saved}</Notice>}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          value={gaps}
          label="Credential gaps"
          sub={gaps === 0 ? "Everything required is on file and current" : "Missing or lapsed"}
          tone={gaps === 0 ? "ok" : "crit"}
        />
        <Figure
          value={trainings.length === 0 ? "none" : String(trainingSplit.current.length)}
          label="Trainings recorded"
          sub={
            trainingDue > 0
              ? `${trainingDue} lapsed`
              : trainings.length === 0
                ? "Nothing recorded yet"
                : trainingSplit.history.length > 0
                  ? `All current · ${trainingSplit.history.length} earlier on file`
                  : "All current"
          }
          tone={trainings.length === 0 || trainingDue > 0 ? "warn" : "ok"}
        />
        <Figure value={docs.length} label="Documents on file" tone="muted" />
        <Figure
          value={person.email ? "yes" : "no"}
          label="Email on file"
          sub={person.email ?? "Training links cannot be sent without one"}
          tone={person.email ? "ok" : "crit"}
        />
      </div>

      {edit && canManage && (
        <Card title="Edit details" className="mb-6 max-w-2xl">
          <PersonForm action={updatePerson.bind(null, id)} person={person} submitLabel="Save" />
        </Card>
      )}

      {/* ── What they must hold ─────────────────────────────────────── */}
      <Card
        id="credentials"
        title="Required credentials"
        count={`${required.length - gaps} of ${required.length} in order`}
        subtitle={
          (person.administersVaccines
            ? "This person administers vaccines, so CPR, immunization training and a signed protocol are required as well as their licence. "
            : "Turn on “administers vaccines” under Edit details if that changes — CPR, immunization training and a signed protocol are then required too. ") +
          "Put in the expiry date and press “I have seen it” to record a card you have physically checked; the record says it was sighted and that no document is attached, which an inspector can tell apart from a scan."
        }
        className="mb-6"
      >
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr><th>Requirement</th><th>Number</th><th>Expires</th><th>Status</th><th>Document</th><th></th></tr>
            </thead>
            <tbody>
              {required.map((type) => {
                const held = heldFor(type);
                return (
                  <tr key={type}>
                    <td>
                      <div className="font-medium">{CREDENTIAL_LABEL[type]}</div>
                      {CREDENTIAL_HINT[type] && <div className="mt-0.5 text-xs text-ink-3">{CREDENTIAL_HINT[type]}</div>}
                    </td>
                    <td className="font-mono text-xs">{held?.number ?? "—"}</td>
                    <td className="whitespace-nowrap text-xs">
                      {held?.noExpiry ? "does not expire" : held?.expiresOn ? fmt(held.expiresOn) : "—"}
                    </td>
                    <td>
                      {!held ? (
                        <span className="badge badge-crit">nothing on file</span>
                      ) : held.noExpiry ? (
                        <span className="badge badge-ok">no expiry</span>
                      ) : !held.expiresOn ? (
                        <span className="badge badge-warn">no date</span>
                      ) : (
                        <StatusBadge days={daysUntil(held.expiresOn)} iso={held.expiresOn} />
                      )}
                    </td>
                    <td className="text-xs">
                      {held && credDocs(held.id).length > 0 ? (
                        credDocs(held.id).map((d) => (
                          <div key={d.id}>
                            <a href={`/files/${d.id}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">{d.fileName}</a>
                          </div>
                        ))
                      ) : (
                        <span className="text-ink-3">none attached</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap align-top">
                      {canManage &&
                        (held ? (
                          <>
                            {/* Two different jobs. Editing corrects what is already on file — a
                                mistyped number, a missing expiry date, the document nobody
                                attached. Renewing files the new card and keeps the old one, which
                                is what an inspector asking "and before that?" wants to see. */}
                            <Link href={`${here}?fix=${held.id}#credential-form`} className="btn btn-sm">Edit</Link>
                            <Link href={`${here}?add=${type}#credential-form`} className="btn btn-sm ml-1">Renew</Link>
                          </>
                        ) : (
                          <div className="space-y-1.5">
                            <Link href={`${here}?add=${type}#credential-form`} className="btn btn-sm btn-primary block text-center">
                              Add with document
                            </Link>
                            {/*
                              The third way, for the card nobody has and nobody has brought in.
                              
                              Both of the other options assume the certificate is in the building.
                              When it is not, the whole job was: email them, wait, remember, then
                              file what came back against the right person and the right
                              requirement — four steps, each one a place it stopped happening. This
                              is that, as one button, and the reply files itself.
                            */}
                            {person.email ? (
                              (() => {
                                const out = asked.find((r) => r.type === type);
                                return out ? (
                                  <div className="rounded-md border border-line bg-ground px-2 py-1.5 text-[11px] leading-tight text-ink-2">
                                    Asked {out.sentAt ? fmt(out.sentAt.slice(0, 10)) : "but not sent"}
                                    {out.sendError ? <span className="block text-crit">{out.sendError}</span> : null}
                                    <span className="block text-ink-3">
                                      They reply with a photo and the code {out.replyCode}, and it files itself here.
                                    </span>
                                    <form action={requestCredentialAction} className="mt-1">
                                      <input type="hidden" name="personId" value={id} />
                                      <input type="hidden" name="credentialType" value={type} />
                                      <input type="hidden" name="back" value={here} />
                                      <button className="btn btn-sm w-full">Ask again</button>
                                    </form>
                                  </div>
                                ) : (
                                  <form action={requestCredentialAction}>
                                    <input type="hidden" name="personId" value={id} />
                                    <input type="hidden" name="credentialType" value={type} />
                                    <input type="hidden" name="back" value={here} />
                                    <button className="btn btn-sm w-full">Ask them for it</button>
                                  </form>
                                );
                              })()
                            ) : (
                              <p className="text-[11px] text-ink-3">
                                No email address on file, so there is nowhere to send a request.
                              </p>
                            )}
                            {/* The short path, for the card that was put on the counter and was
                                current. The alternative to this is not a fuller record — it is no
                                record, which is the state this whole page exists to prevent. */}
                            <form action={markSighted} className="flex flex-wrap items-center gap-1">
                              <input type="hidden" name="personId" value={id} />
                              <input type="hidden" name="type" value={type} />
                              <input
                                name="expiresOn"
                                type="date"
                                className="field w-auto px-1.5 py-1 text-xs"
                                aria-label={`Expiry date for ${CREDENTIAL_LABEL[type]}`}
                              />
                              <button className="btn btn-sm">I have seen it</button>
                              <label className="flex items-center gap-1 text-[11px] text-ink-3">
                                <input type="checkbox" name="noExpiry" /> no expiry
                              </label>
                            </form>
                          </div>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {canManage && (
          <div id="credential-form" className="mt-4 scroll-mt-4 border-t border-line pt-4">
            {fixing ? (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3>Edit {CREDENTIAL_LABEL[fixing.type]}</h3>
                  <Link href={here} className="text-sm text-ink-2 hover:text-ink">Cancel</Link>
                </div>
                <p className="mt-1 text-xs text-ink-3">
                  Changes the record that is already here. To file a renewal without losing the old one, use Renew
                  instead — the history is what answers &ldquo;and before that?&rdquo;.
                </p>
                <CredentialForm action={updateCredential.bind(null, fixing.id)} redirectTo={here} cred={fixing} />
                <form action={deleteCredential.bind(null, fixing.id, here)} className="mt-2">
                  <button className="text-xs text-crit hover:underline">Delete this record entirely</button>
                </form>
              </>
            ) : add ? (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3>Add {CREDENTIAL_LABEL[add as CredentialType] ?? "credential"}</h3>
                  <Link href={here} className="text-sm text-ink-2 hover:text-ink">Cancel</Link>
                </div>
                <CredentialForm action={addCredential} redirectTo={here} personId={id} defaultType={add as CredentialType} />
              </>
            ) : (
              <details>
                <summary className="cursor-pointer text-sm font-medium text-accent">Add something else</summary>
                <CredentialForm action={addCredential} redirectTo={here} personId={id} />
              </details>
            )}
          </div>
        )}
      </Card>

      {/* ── Anything else on file ───────────────────────────────────── */}
      {extras.length > 0 && (
        <Card title="Other credentials on file" count={extraSplit.current.length} className="mb-6">
          {extraSplit.current.length > 0 ? (
            <CredentialTable rows={extraSplit.current} here={here} canManage={canManage} />
          ) : (
            <p className="text-sm text-ink-3">Everything else on file has been replaced by a newer version.</p>
          )}
          <History label="Replaced by a newer one" count={extraSplit.history.length}>
            <CredentialTable rows={extraSplit.history} here={here} canManage={canManage} />
          </History>
        </Card>
      )}

      {/* ── Training and certificates ───────────────────────────────── */}
      <Card
        id="training"
        title="Training"
        count={trainingSplit.current.length}
        actions={<Link href="/compliance/training" className="btn btn-sm">Send training</Link>}
        subtitle="Every completion here has a certificate behind it, generated from the record itself."
        className="mb-6"
      >
        {trainings.length === 0 ? (
          <p className="text-sm text-ink-3">Nothing recorded yet. Send them their required training and it lands here signed.</p>
        ) : (
          <div>
            <TrainingTable rows={trainingSplit.current} assignments={assignments} />
            {/*
              Last year's training, folded away.

              Annual training means a person accumulates one superseded record a year, per course.
              After three years the page is mostly records nobody needs to look at — but every one
              of them has to be kept: HIPAA training documentation for six years (45 CFR 164.530(j))
              and bloodborne records for three (29 CFR 1910.1030(h)(2)(ii)).

              A training that has lapsed with nothing after it is not in here. That is an overdue
              training, and it stays on the page in red where it belongs.
            */}
            <History label="Earlier years, superseded by a later completion" count={trainingSplit.history.length}>
              <TrainingTable rows={trainingSplit.history} assignments={assignments} />
            </History>
          </div>
        )}
      </Card>

      {/* ── Documents ──────────────────────────────────────────────── */}
      <Card
        title="Documents"
        count={docs.length}
        subtitle="Everything scanned or photographed for this person. Attaching a document to a credential above is usually better than filing it loose here."
        className="mb-6"
      >
        <DocumentList docs={docs} redirectTo={here} canManage={canManage} />
        {canManage && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium text-accent">Upload document</summary>
            <div className="mt-3">
              <UploadForm
                redirectTo={here}
                hidden={{ personId: id }}
                categories={["license", "cpr_card", "immunization_training", "immunization_protocol", "training_record", "controlled_substance_poa", "other"]}
                defaultCategory="license"
              />
            </div>
          </details>
        )}
      </Card>

      {/* ── Employment ─────────────────────────────────────────────── */}
      {canManage && (
        <Card title={person.active ? "Employment — make inactive" : "Employment — inactive"} className="mb-6">
          {person.active ? (
            <>
              <p className="text-sm text-ink-2">
                {person.hiredOn ? `Started ${fmt(person.hiredOn)}. ` : ""}
                Recording someone as having left keeps everything on this page — {retention.credentials} credential
                {retention.credentials === 1 ? "" : "s"}, {retention.trainings} training record
                {retention.trainings === 1 ? "" : "s"}, {retention.signedAttestations} signed attestation
                {retention.signedAttestations === 1 ? "" : "s"} and {retention.documents} document
                {retention.documents === 1 ? "" : "s"} — exactly where it is. Nothing is deleted. What changes is that
                they stop counting as staff who owe training, and the site stops emailing them.
              </p>
              {/*
                Not hidden behind a disclosure any more.
                
                It sat collapsed under the words "record that they have left", at the foot of a long
                page — so somebody looking for how to make an employee inactive found nothing,
                because that is neither what it was called nor where anybody would look for it.
              */}
              <form action={endEmploymentAction} className="mt-3 grid max-w-2xl gap-3 sm:grid-cols-2">
                  <input type="hidden" name="personId" value={id} />
                  <Field label="Last day worked" hint="Retention is counted from this date.">
                    <input name="endedOn" type="date" className="field" defaultValue={new Date().toISOString().slice(0, 10)} />
                  </Field>
                  <Field label="Reason" hint="Optional, and kept on the record.">
                    <input name="reason" className="field" placeholder="Resigned, moved out of state, end of contract" />
                  </Field>
                <div className="sm:col-span-2">
                  <button className="btn">Make {person.firstName} inactive</button>
                </div>
              </form>
            </>
          ) : (
            <>
              <p className="text-sm">
                Inactive since {fmt(person.endedOn)}{person.endedReason ? ` — ${person.endedReason}` : ""}
                {person.endedBy ? ` · recorded by ${person.endedBy}` : ""}.
              </p>
              <p className="mt-2 text-sm text-ink-2">
                The whole file is kept and this page stays exactly as it is. Keep it until at least{" "}
                <b>{fmt(retention.keepUntil)}</b>, the latest date any of these rules allows.
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-3">
                {retention.reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
              <form action={reinstateAction} className="mt-3">
                <input type="hidden" name="personId" value={id} />
                <button className="btn btn-primary">Reactivate {person.firstName}</button>
              </form>
            </>
          )}
        </Card>
      )}
    </>
  );
}

function CredentialForm({
  action,
  redirectTo,
  personId,
  cred,
  defaultType,
}: {
  action: (fd: FormData) => Promise<void>;
  redirectTo: string;
  personId?: string;
  defaultType?: CredentialType;
  cred?: {
    type: string;
    label: string | null;
    number: string | null;
    issuer: string | null;
    issuedOn: string | null;
    expiresOn: string | null;
    noExpiry: boolean;
    notes: string | null;
  };
}) {
  const type = (cred?.type ?? defaultType ?? "pharmacist_license") as CredentialType;
  return (
    <form action={action} className="mt-3 grid gap-3 sm:grid-cols-3" encType="multipart/form-data">
      <input type="hidden" name="redirectTo" value={redirectTo} />
      {personId && <input type="hidden" name="personId" value={personId} />}
      <Field label="Type" hint={CREDENTIAL_HINT[type]}>
        <select name="type" className="field" defaultValue={type}>
          {CREDENTIAL_TYPES_FOR_PERSON.map((t) => <option key={t} value={t}>{CREDENTIAL_LABEL[t]}</option>)}
        </select>
      </Field>
      <Field label="Number"><input name="number" className="field" defaultValue={cred?.number ?? ""} /></Field>
      <Field label="Issuer"><input name="issuer" className="field" placeholder="Kansas Board of Pharmacy, AHA, the collaborating physician" defaultValue={cred?.issuer ?? ""} /></Field>
      <Field label="Issued on"><input name="issuedOn" type="date" className="field" defaultValue={cred?.issuedOn ?? ""} /></Field>
      <Field label="Expires on" hint="Leave blank and tick below if it genuinely does not expire.">
        <input name="expiresOn" type="date" className="field" defaultValue={cred?.expiresOn ?? ""} />
        <label className="mt-1.5 flex items-center gap-2 text-xs">
          <input type="checkbox" name="noExpiry" defaultChecked={cred?.noExpiry ?? false} />
          This does not expire
        </label>
      </Field>
      <Field label="Label (for “other”)"><input name="label" className="field" defaultValue={cred?.label ?? ""} /></Field>
      <Field
        label={cred ? "Attach or replace the document" : "The document itself"}
        className="sm:col-span-2"
        hint="The licence card, CPR card, training certificate or signed protocol. PDF, photo or Word file."
      >
        <input name="file" type="file" className="field" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.gif,.bmp,.tif,.tiff,.doc,.docx,.rtf,image/*" />
      </Field>
      <Field label="Notes"><input name="notes" className="field" defaultValue={cred?.notes ?? ""} /></Field>
      <div className="sm:col-span-3"><button className="btn btn-primary">{cred ? "Save" : "Add it"}</button></div>
    </form>
  );
}

/**
 * One credential row, written once.
 *
 * Used for the records on the page and for the ones folded away behind them. Two copies of this
 * markup would have diverged the first time a column was added, and the version nobody looks at
 * is the one that would have been left behind.
 */
function CredentialTable({
  rows,
  here,
  canManage,
}: {
  rows: typeof schema.credentials.$inferSelect[];
  here: string;
  canManage: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead><tr><th>Credential</th><th>Number</th><th>Issued</th><th>Expires</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td>
                <div className="font-medium">{c.type === "other" && c.label ? c.label : CREDENTIAL_LABEL[c.type]}</div>
                {c.issuer && <div className="text-xs text-ink-3">{c.issuer}</div>}
              </td>
              <td className="font-mono text-xs">{c.number ?? "—"}</td>
              <td className="whitespace-nowrap text-xs">{fmt(c.issuedOn)}</td>
              <td className="whitespace-nowrap text-xs">{c.noExpiry ? "does not expire" : fmt(c.expiresOn)}</td>
              <td>{c.noExpiry ? <span className="badge badge-ok">no expiry</span> : <StatusBadge days={daysUntil(c.expiresOn)} iso={c.expiresOn} />}</td>
              <td className="whitespace-nowrap">
                {canManage && <Link href={`${here}?fix=${c.id}#credential-form`} className="btn btn-sm">Edit</Link>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One training row, for the same reason. */
function TrainingTable({
  rows,
  assignments,
}: {
  rows: typeof schema.trainings.$inferSelect[];
  assignments: typeof schema.trainingAssignments.$inferSelect[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead><tr><th>Training</th><th>Completed</th><th>Next due</th><th>How</th><th>Certificate</th></tr></thead>
        <tbody>
          {rows.map((t) => {
            const a = assignments.find((x) => x.trainingId === t.id);
            return (
              <tr key={t.id}>
                <td className="font-medium">{TRAINING_LABEL[t.type]}</td>
                <td className="whitespace-nowrap text-xs">{fmt(t.completedOn)}</td>
                <td className="whitespace-nowrap">
                  {t.expiresOn ? (
                    <span className="flex items-center gap-2">
                      <StatusBadge days={daysUntil(t.expiresOn)} iso={t.expiresOn} />
                      <span className="text-xs text-ink-2">{fmt(t.expiresOn)}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-ink-3">does not repeat</span>
                  )}
                </td>
                <td className="text-xs text-ink-2">
                  {a?.completedVia === "email_reply"
                    ? `Email reply${a.replyFromAddress ? ` from ${a.replyFromAddress}` : ""}`
                    : a?.completedVia === "pic_recorded"
                      ? "Recorded by the PIC"
                      : a?.completedVia === "signed"
                        ? `Signed${a.quizTotal ? ` · ${a.quizCorrect}/${a.quizTotal} correct` : ""}`
                        : t.provider ?? "—"}
                </td>
                <td className="whitespace-nowrap text-xs">
                  <Link href={`/certificates/${t.id}`} className="btn btn-sm">Certificate</Link>
                  {t.documentId && (
                    <a href={`/files/${t.documentId}`} target="_blank" rel="noreferrer" className="btn btn-sm ml-1">Evidence</a>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
