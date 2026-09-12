import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { protocolFor, protocolGaps, protocolBody } from "@/lib/immunization-protocol";
import { ProtocolBody } from "@/components/protocol-body";
import { fmt, fmtLong, todayIso } from "@/lib/dates";
import { PrintFrame } from "@/components/print";
import { Notice } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Immunization protocol" };

/**
 * The protocol, filled in and ready for two signatures.
 *
 * Kansas does not let a pharmacist immunize on their own authority — K.S.A. 65-1635a has them act
 * as the agent of an authorising physician under a written protocol that physician signs. Without
 * a current one there is no authority to give a single dose, and producing one meant finding last
 * year's Word file on somebody's desktop and retyping a name into it.
 *
 * The wording is the pharmacy's existing protocol reproduced faithfully, because it is a document
 * a physician has already read and signed and rewriting it would mean asking them to read a new
 * one. What is new is that the pharmacy, the immunizer and their qualifications come from the
 * record, so the copy taken to the physician cannot disagree with the copy the site is tracking.
 */
export default async function ProtocolPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const c = await protocolFor(id);
  if (!c) notFound();
  const gaps = protocolGaps(c);

  return (
    <PrintFrame
      ownDocument
      formTitle="Pharmacist Immunization & Emergency Anaphylaxis Treatment Protocol"
      formNumber=""
      revised={todayIso()}
      backHref={`/staff/${id}`}
      pageLabel={`${c.pharmacy} · ${c.subject.name}`}
    >
      <div className="no-print mb-4 space-y-3">
        {gaps.length > 0 && (
          <Notice kind="warn">
            <b>Worth fixing before this is signed.</b> The statute conditions the authority on training and a current
            CPR certificate, so a protocol signed for somebody who holds neither authorises nothing.
            <ul className="ml-5 mt-1 list-disc">
              {gaps.map((g) => <li key={g}>{g}</li>)}
            </ul>
          </Notice>
        )}
        {c.subject.existing?.expiresOn && (
          <Notice kind="ok">
            A protocol is already on file for {c.subject.name}
            {c.subject.existing.signedOn ? `, signed ${fmt(c.subject.existing.signedOn)}` : ""} and running to{" "}
            {fmt(c.subject.existing.expiresOn)}. This replaces it once signed.
          </Notice>
        )}
        <p className="text-xs text-ink-3">
          Print two copies, take them to the physician, and file the signed original. Then record it on{" "}
          <Link href={`/staff/${id}#credential-form`} className="underline">{c.subject.name}&rsquo;s page</Link> as an
          immunization protocol, with the date signed and the date it runs to — that is what stops the dashboard
          chasing it.
        </p>
      </div>

      <div className="text-[11px] leading-relaxed">
        <div className="mb-3">
          <div className="text-sm font-bold">{c.pharmacy}</div>
          {c.address && <div className="text-[10px]">{c.address}</div>}
        </div>

        {/*
          The wording comes from the library, not from here.
          
          It was written out in this file, and the same document is also read on screen by the
          person working to it and attached to the email that asks them to read it. Three copies of
          one protocol is three chances for the copy somebody signed for having read to stop being
          the copy they were sent.
        */}
        <ProtocolBody blocks={protocolBody(c)} dense />

        {/* The qualifications the statute conditions the authority on, stated on the document itself. */}
        <dl className="print-page-break mt-5 grid grid-cols-2 gap-x-8 gap-y-1 border border-black p-3 text-[10px]">
          <dt className="font-semibold">Authorized individual</dt>
          <dd>{c.subject.name} — {c.subject.role}</dd>
          <dt className="font-semibold">Licence / registration</dt>
          <dd>{c.subject.licence ?? "________________________"}</dd>
          <dt className="font-semibold">Immunization training</dt>
          <dd>{c.subject.immunizationTraining ?? "________________________"}</dd>
          <dt className="font-semibold">CPR certification</dt>
          <dd>
            {c.subject.cpr?.number ?? "________________"}
            {c.subject.cpr?.expiresOn ? ` · current to ${fmt(c.subject.cpr.expiresOn)}` : ""}
          </dd>
        </dl>

        <div className="print-signature mt-10 grid grid-cols-2 gap-x-12 gap-y-8 text-[9px]">
          <div>
            <div className="border-b border-black pb-0.5 text-[11px]">{c.physician ?? ""}</div>
            <div className="pt-1">Authorizing Physician Name</div>
          </div>
          <div>
            <div className="border-b border-black pb-0.5 text-[11px]">{c.subject.name}</div>
            <div className="pt-1">Pharmacist, Intern, Technician Name</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Physician Signature</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Signature</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Date</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Date</div>
          </div>
        </div>

        <p className="mt-6 text-[10px]">Prepared {fmtLong(todayIso())} by {user.name}.</p>
      </div>
    </PrintFrame>
  );
}
