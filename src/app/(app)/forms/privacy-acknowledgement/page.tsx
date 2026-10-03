import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { PRIVACY_ACKNOWLEDGEMENT_TEXT } from "@/lib/patient-forms";
import { todayIso } from "@/lib/dates";
import { PrintFrame } from "@/components/print";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notice of Privacy Practices acknowledgement" };

/**
 * The signature 45 CFR 164.520(c)(2)(ii) asks a pharmacy to make a good faith effort to obtain.
 *
 * The rule is about the effort, not the signature. A patient who will not sign is not a
 * compliance failure — but a form with nowhere to record that they declined turns a lawful
 * outcome into a missing document, and a missing document is what an audit finds. So refusal has
 * a box of its own, with room for the reason, and the staff member records what they did.
 */
export default async function PrivacyAcknowledgementPage() {
  await requireUser();
  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "This pharmacy";
  const address =
    [s.pharmacy_address, [s.pharmacy_city, s.pharmacy_state].filter(Boolean).join(", "), s.pharmacy_zip]
      .filter(Boolean)
      .join(" · ") || null;

  return (
    <PrintFrame
      ownDocument
      formTitle="Acknowledgement of Receipt of Notice of Privacy Practices"
      formNumber=""
      revised={todayIso()}
      backHref="/forms"
      pageLabel={pharmacy}
    >
      <div className="text-[11px] leading-relaxed">
        <div className="mb-4">
          <div className="text-sm font-bold">{pharmacy}</div>
          {address && <div className="text-[10px]">{address}</div>}
          {s.pharmacy_phone && <div className="text-[10px]">{s.pharmacy_phone}</div>}
        </div>

        {PRIVACY_ACKNOWLEDGEMENT_TEXT.map((p) => <p key={p} className="mt-3">{p}</p>)}

        <div className="mt-8 grid grid-cols-2 gap-x-12 gap-y-8 text-[9px]">
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Signature of patient or personal representative</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Print name</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">If signed by a representative: relationship and authority</div>
          </div>
          <div>
            <div className="mt-6 border-b border-black" />
            <div className="pt-1">Date</div>
          </div>
        </div>

        {/*
          The half of this form that is usually missing.

          A pharmacy that only records signatures has no answer at all for the patient who
          declined — and "we asked and they said no" is a complete answer under the rule, but only
          if somebody wrote it down at the time.
        */}
        <section className="mt-8 border border-black p-3">
          <div className="text-[12px] font-bold">If the acknowledgement was not obtained</div>
          <p className="mt-1 text-[10px]">
            Complete this section instead. The rule requires a good faith effort to obtain the acknowledgement and, if
            it is not obtained, a record of the effort made and the reason it was not.
          </p>
          <div className="mt-3 space-y-3 text-[10px]">
            <label className="flex items-start gap-2"><span className="mt-0.5 inline-block h-3 w-3 border border-black" /> The patient was given the Notice and declined to sign.</label>
            <label className="flex items-start gap-2"><span className="mt-0.5 inline-block h-3 w-3 border border-black" /> The prescription was delivered or mailed; the Notice was sent with it.</label>
            <label className="flex items-start gap-2"><span className="mt-0.5 inline-block h-3 w-3 border border-black" /> An emergency; the Notice was provided as soon as practicable afterwards.</label>
            <label className="flex items-start gap-2"><span className="mt-0.5 inline-block h-3 w-3 border border-black" /> Other — described below.</label>
          </div>
          <div className="mt-3 h-10 border-b border-black" />
          <div className="pt-0.5 text-[8px] uppercase tracking-wide">What was done, and why the acknowledgement was not obtained</div>
          <div className="mt-5 grid grid-cols-2 gap-x-12 text-[9px]">
            <div>
              <div className="mt-5 border-b border-black" />
              <div className="pt-1">Staff member — print name and sign</div>
            </div>
            <div>
              <div className="mt-5 border-b border-black" />
              <div className="pt-1">Date</div>
            </div>
          </div>
        </section>

        <p className="mt-5 text-[9px]">
          File the completed form in the patient&rsquo;s pharmacy record. {pharmacy} retains it for six years.
          45 CFR 164.520(c)(2)(ii) and 45 CFR 164.530(j).
        </p>
      </div>
    </PrintFrame>
  );
}
