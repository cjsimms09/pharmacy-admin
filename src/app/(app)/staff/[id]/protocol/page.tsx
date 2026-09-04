import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { protocolFor, protocolGaps, PROTOCOL_VACCINES, EMERGENCY_STEPS } from "@/lib/immunization-protocol";
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

        <p>
          The Pharmacist, Pharmacy Intern, or Pharmacy Technician acting as an agent for the undersigned physician,
          according to and in compliance with Statute 65-1635a of the Kansas State Pharmacy Practice Act and all
          revisions thereof, may administer the immunizations (vaccines) listed below.
        </p>

        <p className="mt-3 text-[10px]">
          <b>
            65-1635a. Administration of vaccine; education and reporting requirements; delegation of authority
            prohibited; &ldquo;pharmacist&rdquo; defined.
          </b>{" "}
          (a) A pharmacist or a pharmacy student, intern or pharmacy technician who is 18 years of age or older and
          working under the direct supervision and control of a pharmacist may administer influenza vaccine to a person
          six years of age or older and may administer vaccine, other than influenza vaccine, to a person 12 years of
          age or older pursuant to a vaccination protocol if the pharmacist, pharmacy student, intern or pharmacy
          technician has successfully completed a course of study and training, approved by the accreditation council
          for pharmacy or the board, in vaccination storage, protocols, injection technique, emergency procedures and
          recordkeeping and has taken a course in cardiopulmonary resuscitation (CPR) and has a current CPR certificate
          when administering vaccines. A pharmacist, pharmacy student, intern or pharmacy technician who successfully
          completes such a course of study and training shall maintain proof of completion and, upon request, provide a
          copy of such proof to the board.
        </p>

        <p className="mt-3">
          The pharmacist, pharmacy intern, or pharmacy technician, possessing a certificate of training in Pharmacy
          Based Immunization Delivery, current BLS Healthcare CPR Certification, and, if applicable, pharmacist
          professional liability insurance coverage may administer <i>influenza vaccine to persons 6 years of age or
          older</i> and the following immunizations (vaccines) to persons <i>12 years of age or older</i>, consistent
          with the FDA approved indications and contraindications and/or recommended in current guideline from the
          Advisory Committee on Immunizations Practices (ACIP) of the U.S Centers for Disease Control &amp; Prevention
          (CDC), and other competent authorities:
        </p>

        <table className="mt-3 w-full text-[10px] font-semibold">
          <tbody>
            {PROTOCOL_VACCINES.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => <td key={j} className="py-0.5 pr-4 align-top">{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>

        <p className="mt-3">
          Pursuant to statute 65-1635a, pharmacy technician or interns certified in Pharmacy Based Immunization
          Delivery carrying liability insurance coverage and current CPR certification may administer vaccinations
          under the direct supervision of the afore mentioned licensed pharmacist.
        </p>

        <p className="mt-3">
          {c.pharmacy} will maintain records of all immunizations administered, immunization training, and CPR
          Certifications for a minimum of 5 years and shall be made available at the request of the board of pharmacy.
          Before immunization, vaccine candidates will be screened regarding previous adverse events following
          immunizations, food or drug allergies, current health, immunosuppression status, pregnancy, and underlying
          diseases. All vaccine candidates will be provided with a current Vaccine Information Statement (VIS). If a
          primary care provider (PCP) is provided to {c.pharmacy} by the vaccinated patient, {c.pharmacy} will notify
          or make an attempt to notify the PCP of the vaccine(s) administered. If no PCP is provided by the patient the
          administration record will be sent to the protocol physician. The pharmacist shall report administration of
          all vaccinations to the Kansas Immunization Registry in compliance with K.S.A 65-1635a for reporting
          vaccinations. Any clinically significant adverse events following an immunization shall be reported to the
          Vaccine Adverse Events Reporting System (VAERS), even if unclear whether the event was caused by the vaccine.
        </p>

        <p className="mt-3 font-semibold underline">Emergency Protocol:</p>
        <p>If an allergic reaction to a vaccine occurs, this pharmacist is authorized to;</p>
        <ol className="ml-5 list-decimal">
          {EMERGENCY_STEPS.map((s) => <li key={s} className="mt-0.5">{s}</li>)}
        </ol>

        <p className="print-page-break mt-6">
          As the authorizing physician, I will maintain a valid Yellow-Fever stamp registered to {c.pharmacy} and
          review the activities of the pharmacist administering vaccines under this protocol on a yearly basis. This
          protocol shall be valid for {c.termYears} years or such time preceding {c.termYears} years that it is revoked
          in writing. I, the authorizing physician, hereby authorize the pharmacist, pharmacy intern, or pharmacy
          technician to administer vaccinations in accordance with this protocol.
        </p>

        {/* The qualifications the statute conditions the authority on, stated on the document itself. */}
        <dl className="mt-5 grid grid-cols-2 gap-x-8 gap-y-1 border border-black p-3 text-[10px]">
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
