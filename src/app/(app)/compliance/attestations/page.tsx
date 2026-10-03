import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { ensureObligations } from "@/lib/obligations";
import { periodLabel } from "@/lib/periods";
import { fmt, fmtLong, todayIso } from "@/lib/dates";
import { getSettings } from "@/lib/settings";
import { PrintFrame } from "@/components/print";

export const dynamic = "force-dynamic";
export const metadata = { title: "Attestations" };

/**
 * Everything the pharmacist-in-charge has signed, in their own words.
 *
 * The register answers whether a duty was done in a period. It does not show what was actually
 * attested to — and the sentence is the evidence. A grid of green ticks proves that somebody
 * clicked something; "On 3 September 2026 I signed in to K-TRACS and reviewed the submission
 * status for August 2026, all controlled substance dispensings for that period had been
 * submitted, and any error file was corrected and resubmitted" is a statement a person stands
 * behind and an inspector can read three years later.
 *
 * Those sentences were being stored and shown nowhere, which meant the strongest evidence in the
 * whole system was invisible. This is that record: every attestation ever made, newest first,
 * with the exact wording as it was agreed to, filterable to a year or a single duty, and
 * printable as one document.
 */
export default async function AttestationsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; duty?: string }>;
}) {
  const user = await requireUser();
  const { year, duty } = await searchParams;
  await ensureObligations();

  const [s, obligations, completions, documents, signatures] = await Promise.all([
    getSettings(),
    db.query.obligations.findMany(),
    db.query.obligationCompletions.findMany({ orderBy: (c, { desc }) => [desc(c.completedOn), desc(c.createdAt)] }),
    db.query.documents.findMany(),
    db.query.recordSignatures.findMany({ where: eq(schema.recordSignatures.kind, "obligation_attestation") }),
  ]);
  const signedBy = new Map(signatures.map((x) => [x.id, x]));

  const byId = new Map(obligations.map((o) => [o.id, o]));
  const years = [...new Set(completions.map((c) => c.completedOn.slice(0, 4)))].sort().reverse();
  const duties = obligations
    .filter((o) => completions.some((c) => c.obligationId === o.id))
    .sort((a, b) => a.title.localeCompare(b.title));

  const shown = completions.filter(
    (c) => (!year || c.completedOn.startsWith(year)) && (!duty || c.obligationId === duty),
  );

  const heading = [
    duty ? byId.get(duty)?.title : null,
    year ? `during ${year}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <PrintFrame
      ownDocument
      formTitle="Record of attestations"
      formNumber=""
      revised=""
      backHref="/compliance"
    >
      <div className="no-print mb-4 space-y-2">
        <div className="flex flex-wrap gap-1.5">
          <Link href="/compliance/attestations" className={`btn btn-sm ${!year && !duty ? "btn-primary" : ""}`}>
            Everything
          </Link>
          {years.map((y) => (
            <Link
              key={y}
              href={`/compliance/attestations?year=${y}${duty ? `&duty=${duty}` : ""}`}
              className={`btn btn-sm ${year === y ? "btn-primary" : ""}`}
            >
              {y}
            </Link>
          ))}
        </div>
        {duties.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {duties.map((o) => (
              <Link
                key={o.id}
                href={`/compliance/attestations?duty=${o.id}${year ? `&year=${year}` : ""}`}
                className={`btn btn-sm ${duty === o.id ? "btn-primary" : ""}`}
              >
                {o.title.length > 44 ? `${o.title.slice(0, 44)}…` : o.title}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="mb-4">
        <p className="text-lg font-bold">{s.pharmacy_name || "This pharmacy"}</p>
        {s.pharmacy_registration_number && (
          <p className="text-xs">Kansas pharmacy registration {s.pharmacy_registration_number}</p>
        )}
        <p className="mt-2 text-xs">
          Printed {fmtLong(todayIso())} by {user.name}. {shown.length}{" "}
          {shown.length === 1 ? "attestation" : "attestations"}
          {heading ? ` — ${heading}` : ""}.
        </p>
        <p className="mt-1 text-xs">
          Each entry below is the wording as it was agreed to at the time. Wording is stored per attestation and never
          regenerated, so a later change to a template cannot alter what somebody signed. Entries marked as signed
          electronically were made under the Electronic Signatures in Global and National Commerce Act (15 U.S.C. 7001)
          and the Kansas Uniform Electronic Transactions Act (K.S.A. 16-1601 et seq.): the signer ticked to confirm
          intent and typed their name, and the time and the address they signed from are held with the statement.
        </p>
      </div>

      {shown.length === 0 ? (
        <p className="border border-black p-3 text-sm">
          Nothing recorded for this selection.
        </p>
      ) : (
        <div className="space-y-2">
          {shown.map((c) => {
            const o = byId.get(c.obligationId);
            const doc = c.documentId ? documents.find((d) => d.id === c.documentId) : null;
            return (
              <article key={c.id} className="print-block border border-black">
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-black bg-neutral-100 px-2 py-1">
                  <span className="text-[11px] font-bold">{o?.title ?? "A duty since removed"}</span>
                  <span className="text-[10px]">
                    {c.periodKey ? periodLabel(c.periodKey) : "no period"} · recorded {fmt(c.completedOn)} by {c.completedBy}
                  </span>
                </div>
                <div className="px-2 py-1.5">
                  {c.statement ? (
                    <p className="text-[11px] italic leading-relaxed">&ldquo;{c.statement}&rdquo;</p>
                  ) : (
                    <p className="text-[11px] text-neutral-600">
                      No statement was recorded with this entry — it predates the wording being stored.
                    </p>
                  )}
                  {/*
                    The signature, printed with the statement.

                    An attestation is often the only evidence that a duty performed outside this
                    system was performed at all, so it has to carry more than a name in a column.
                    Entries made before attestations were signed say so plainly rather than being
                    dressed up as something they were not.
                  */}
                  {(() => {
                    const sig = c.signatureId ? signedBy.get(c.signatureId) : null;
                    if (!sig) return null;
                    return (
                      <p className="mt-1 text-[9px] leading-relaxed">
                        <b>Signed electronically</b> by {sig.signedName}
                        {sig.signedRole ? ` (${sig.signedRole})` : ""} on{" "}
                        {new Date(sig.signedAt).toLocaleString()} from {sig.signedIp ?? "an address not recorded"}.
                        {sig.revokedAt && <> Withdrawn: {sig.revokedReason}</>}
                      </p>
                    );
                  })()}
                  {c.notes && !c.statement?.includes(c.notes) && (
                    <p className="mt-1 text-[10px]">{c.notes.length > 400 ? `${c.notes.slice(0, 400)}…` : c.notes}</p>
                  )}
                  {o?.citation && <p className="mt-1 text-[10px] text-neutral-700">{o.citation}</p>}
                  {doc && (
                    <p className="mt-1 text-[10px]">
                      Evidence filed: <span className="font-mono">{doc.fileName}</span>{" "}
                      <a href={`/files/${doc.id}`} className="no-print underline" target="_blank" rel="noreferrer">open</a>
                    </p>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="print-signature mt-6">
        <p className="text-xs">
          I certify that the attestations above are a true record of what was confirmed at this pharmacy, on the dates
          shown.
        </p>
        <p className="mt-4 text-xs">
          Pharmacist-in-charge: ______________________________ Date: ______________
        </p>
      </div>
    </PrintFrame>
  );
}
