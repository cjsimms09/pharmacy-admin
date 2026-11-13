import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { allSections, outline } from "@/lib/manual-store";
import { revisionOf } from "@/lib/manual-version";
import { todayIso } from "@/lib/dates";
import { PrintFrame } from "@/components/print";

export const dynamic = "force-dynamic";
export const metadata = { title: "Policy manual acknowledgement" };

/**
 * The paper acknowledgement, for the person who will not do it on a phone.
 *
 * No regulation says in those words "collect a signature for the policy manual". Four say things
 * that this signature, and nothing else the pharmacy holds, evidences: the workforce must be
 * trained on the privacy policies and that training documented (45 CFR 164.530(b)(1) and
 * (j)(1)(ii)); there must be sanctions for failing to follow them, which cannot stand against
 * somebody never shown the rule (164.530(e)(1)); the exposure control plan must be explained and
 * the explanation recorded (29 CFR 1910.1030(g)(2)); and pharmacy personnel must participate in
 * the quality improvement programme, which begins with having read it (K.A.R. 68-19-1).
 *
 * The revision is printed on the form, and it is the whole point of the form. "I have read the
 * manual" says nothing once the manual has been edited — and it is edited here. A signature that
 * names its version is a record; one that does not is a date on a piece of paper.
 *
 * The chapter list is on it for the same reason. Somebody signing for a document they were handed
 * should be able to see what was in it, and the pharmacy should be able to show, years later,
 * what that was.
 */
export default async function PolicyAcknowledgementFormPage() {
  await requireUser();
  const [s, rows] = await Promise.all([getSettings(), allSections()]);
  const pharmacy = s.pharmacy_name || "This pharmacy";
  const revision = revisionOf(rows);
  const chapters = outline(rows).filter((x) => x.depth === 0);

  return (
    <PrintFrame
      ownDocument
      formTitle="Policy and Procedure Manual — Acknowledgement"
      formNumber=""
      revised={todayIso()}
      backHref="/forms"
      pageLabel={pharmacy}
    >
      <div className="text-[11px] leading-relaxed">
        <div className="mb-4">
          <div className="text-sm font-bold">{pharmacy}</div>
          {s.pharmacy_address && <div className="text-[10px]">{s.pharmacy_address}</div>}
        </div>

        {/*
          The version, at the top, in a box.

          It is the difference between a record and a date on a piece of paper, and it has to be
          filled in from the manual as it stands on the day — which is what this page does, so
          nobody has to know what a revision is or where to find one.
        */}
        <section className="border border-black p-2 text-[10px]">
          <div className="flex flex-wrap justify-between gap-2">
            <span><b>Manual revision</b> <span className="font-mono">{revision.fingerprint}</span></span>
            <span>{revision.sections} sections</span>
            <span>{revision.words.toLocaleString("en-US")} words</span>
            <span>Last edited {revision.changedOn ?? "—"}</span>
          </div>
        </section>

        <p className="mt-4">
          I confirm that I have been given access to the policy and procedure manual of {pharmacy} in the revision
          shown above, that I have read it, and that I have had the opportunity to ask questions about anything in it
          that I did not understand.
        </p>
        <p className="mt-2">
          I understand that these policies apply to my work at this pharmacy, that I am expected to follow them, and
          that failing to follow them may lead to disciplinary action. I understand that the manual may be revised, and
          that I will be asked to acknowledge a revised manual when that happens.
        </p>
        <p className="mt-2">
          I understand in particular that the manual contains this pharmacy&rsquo;s privacy and security policies, its
          exposure control plan, its controlled substance procedures, and its continuous quality improvement programme,
          and that I am required to take part in each of these so far as my work involves them.
        </p>

        {chapters.length > 0 && (
          <section className="mt-4">
            <div className="text-[9px] font-bold uppercase tracking-wide">What was in the manual at this revision</div>
            <ol className="mt-1 grid grid-cols-2 gap-x-6 text-[9px]">
              {chapters.map((c) => (
                <li key={c.id} className="py-0.5">
                  {c.number}. {c.title}
                  {c.managedBy && <span className="text-[8px]"> — maintained by {c.managedBy}</span>}
                </li>
              ))}
            </ol>
          </section>
        )}

        <div className="mt-8 grid grid-cols-2 gap-x-12 gap-y-8 text-[9px]">
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Signature</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Print name</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Job title</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Date</div>
          </div>
        </div>

        <section className="mt-8 border border-black p-3 text-[10px]">
          <div className="text-[11px] font-bold">For the pharmacist-in-charge</div>
          <p className="mt-1">
            Sign here if the manual was gone through with this person rather than only handed to them. This is what
            29 CFR 1910.1030(g)(2)(vii) asks for in respect of the exposure control plan: an opportunity for
            interactive questions and answers with a person knowledgeable in the subject.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-x-12 text-[9px]">
            <div>
              <div className="mt-5 border-b border-black" />
              <div className="pt-1">Pharmacist-in-charge — print name and sign</div>
            </div>
            <div>
              <div className="mt-5 border-b border-black" />
              <div className="pt-1">Date</div>
            </div>
          </div>
        </section>

        <p className="mt-5 text-[9px]">
          Once signed, record it against the person under Training so the file and the paper agree — the revision above
          is what to enter. {pharmacy} keeps this for six years, which is the period 45 CFR 164.530(j)(2) requires of
          the privacy training record it forms part of.
        </p>
      </div>
    </PrintFrame>
  );
}
