import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { onSiteToday } from "@/lib/roster";
import { SCREENING_QUESTIONS } from "@/lib/patient-forms";
import { todayIso } from "@/lib/dates";
import { PrintFrame } from "@/components/print";

export const dynamic = "force-dynamic";
export const metadata = { title: "Vaccine administration record" };

/**
 * Screening, consent and the dose, on one sheet.
 *
 * The manual promised a "Vaccine Administration Record" and had nothing behind the heading. What
 * the pharmacy actually needs at the point of vaccination is one piece of paper that does three
 * jobs — the screening questions asked before the dose, the patient's consent, and what was
 * given — because those three separate on a busy Saturday and the one that goes missing is the
 * screening. K.S.A. 65-1635a conditions the whole authority on screening having happened; a
 * record of the dose with no record of the screening is a record of an unauthorised act.
 *
 * The immunizers are listed by name from the staff record rather than left as a blank line, so
 * the person signing is one the pharmacy can show was trained and CPR-certified on the day.
 */
export default async function VaccineAdministrationRecordPage() {
  await requireUser();
  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "This pharmacy";
  const address =
    [s.pharmacy_address, [s.pharmacy_city, s.pharmacy_state].filter(Boolean).join(", "), s.pharmacy_zip]
      .filter(Boolean)
      .join(" · ") || null;
  const immunizers = (await onSiteToday()).filter((p) => p.administersVaccines);

  const line = (label: string, w = "flex-1") => (
    <div className={`${w} min-w-0`}>
      <div className="h-5 border-b border-black" />
      <div className="pt-0.5 text-[8px] uppercase tracking-wide">{label}</div>
    </div>
  );

  return (
    <PrintFrame
      ownDocument
      formTitle="Vaccine Screening, Consent and Administration Record"
      formNumber=""
      revised={todayIso()}
      backHref="/forms"
      pageLabel={pharmacy}
    >
      <div className="text-[10px] leading-relaxed">
        <div className="mb-3">
          <div className="text-sm font-bold">{pharmacy}</div>
          {address && <div className="text-[9px]">{address}</div>}
          {s.pharmacy_phone && <div className="text-[9px]">{s.pharmacy_phone}</div>}
        </div>

        <section className="border border-black p-2">
          <div className="text-[11px] font-bold">Patient</div>
          <div className="mt-2 flex gap-3">{line("Full name")}{line("Date of birth", "w-28")}{line("Today's date", "w-28")}</div>
          <div className="mt-3 flex gap-3">{line("Address")}{line("Phone", "w-36")}</div>
          <div className="mt-3 flex gap-3">{line("Primary care provider")}{line("Insurance / plan", "w-48")}</div>
        </section>

        <section className="mt-3 border border-black p-2">
          <div className="text-[11px] font-bold">Screening — ask every question before any dose is drawn up</div>
          <p className="mt-1 text-[9px]">
            A “yes” does not by itself rule out vaccination. It is the point at which the pharmacist decides, and the
            decision is recorded at the foot of this section.
          </p>
          <table className="mt-2 w-full">
            <thead>
              <tr className="text-[8px] uppercase tracking-wide">
                <th className="w-8 border border-black py-0.5">Yes</th>
                <th className="w-8 border border-black py-0.5">No</th>
                <th className="w-12 border border-black py-0.5">Unsure</th>
                <th className="border border-black py-0.5 text-left">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {SCREENING_QUESTIONS.map((q) => (
                <tr key={q}>
                  <td className="h-6 border border-black" />
                  <td className="border border-black" />
                  <td className="border border-black" />
                  <td className="border border-black px-1.5 py-1 text-[9.5px]">{q}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex gap-3">
            {line("Pharmacist's decision and reason, where any answer was yes or unsure")}
          </div>
        </section>

        <section className="mt-3 border border-black p-2">
          <div className="text-[11px] font-bold">Consent</div>
          <p className="mt-1 text-[9.5px]">
            I have been given a copy of the current Vaccine Information Statement (VIS) for each vaccine listed below
            and have had the chance to ask questions. I understand the benefits and risks explained to me, and I
            request that the vaccine or vaccines below be administered to me, or to the person for whom I am
            authorised to consent. I understand that {pharmacy} will report this administration to the Kansas
            Immunization Registry, and will notify my primary care provider where I have named one.
          </p>
          <div className="mt-3 flex gap-3">{line("Signature of patient or person authorised to consent")}{line("Relationship, if not the patient", "w-40")}{line("Date", "w-24")}</div>
        </section>

        <section className="mt-3 border border-black p-2">
          <div className="text-[11px] font-bold">Administration</div>
          <table className="mt-2 w-full text-[8.5px]">
            <thead>
              <tr className="uppercase tracking-wide">
                {["Vaccine", "Manufacturer", "Lot number", "Exp.", "Dose", "Route", "Site", "VIS date", "VIS given", "Time"].map((h) => (
                  <th key={h} className="border border-black px-1 py-0.5">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2].map((r) => (
                <tr key={r}>
                  {Array.from({ length: 10 }).map((_, c) => <td key={c} className="h-7 border border-black" />)}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex gap-3">
            {line("Administered by — print name")}
            {line("Signature")}
            {line("Licence / registration no.", "w-40")}
          </div>
          {immunizers.length > 0 && (
            <p className="mt-2 text-[8.5px]">
              Authorised to administer at this pharmacy under the current protocol:{" "}
              {immunizers.map((p) => `${p.firstName} ${p.lastName}`).join(", ")}.
            </p>
          )}
        </section>

        <section className="mt-3 border border-black p-2">
          <div className="text-[11px] font-bold">If a reaction occurs</div>
          <p className="mt-1 text-[9.5px]">
            Follow the emergency protocol in the signed immunization protocol: call 911, give epinephrine, keep the
            patient supine unless they are struggling to breathe, monitor and maintain the airway. Record what
            happened below, tell the pharmacist-in-charge the same day, report it to VAERS, and log it as a
            quality-related event.
          </p>
          <div className="mt-2 h-12 border border-black" />
          <div className="pt-0.5 text-[8px] uppercase tracking-wide">What happened, what was given, and who was told</div>
        </section>

        <p className="mt-3 text-[8.5px]">
          File the completed record in the patient&rsquo;s pharmacy file. {pharmacy} keeps immunization records for at
          least five years and produces them to the Board on request. Screening and consent: K.S.A. 65-1635a. VIS:
          42 U.S.C. 300aa-26. Adverse events: VAERS.
        </p>
      </div>
    </PrintFrame>
  );
}
