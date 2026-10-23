import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { MEDICARE_RIGHTS_NOTICE } from "@/lib/patient-forms";
import { todayIso } from "@/lib/dates";
import { PrintFrame } from "@/components/print";
import { Notice } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Medicare Prescription Drug Coverage and Your Rights" };

/**
 * The notice a Part D patient gets when the claim will not go through.
 *
 * Required at the point of sale whenever an enrolled patient's prescription cannot be filled
 * under their plan — it is what tells them a coverage determination exists and how to ask for
 * one. It is the single Part D obligation that lands on the pharmacy counter rather than on the
 * plan, and it was a heading in the manual with nothing behind it.
 *
 * A CMS document reproduced, not one this pharmacy wrote, and the page says so: putting the
 * pharmacy's name at the top of somebody else's standardised notice is how a notice stops being
 * the standardised one.
 */
export default async function MedicareRightsPage() {
  await requireUser();
  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "This pharmacy";

  return (
    <PrintFrame
      ownDocument
      formTitle="Medicare Prescription Drug Coverage and Your Rights"
      formNumber=""
      revised={todayIso()}
      backHref="/forms"
      pageLabel={pharmacy}
    >
      <div className="no-print mb-4">
        <Notice kind="warn">
          <b>This is CMS&rsquo;s notice, not the pharmacy&rsquo;s.</b> It reproduces the standardised Medicare
          Prescription Drug Coverage and Your Rights notice (CMS-10147). CMS revises it from time to time and the
          revision in force is the one that must be handed over, so check it against the current version on cms.gov
          when the pharmacy reviews this manual each year. Nothing on this page may be reworded.
        </Notice>
      </div>

      <div className="text-[11px] leading-relaxed">
        <p>
          Your Medicare drug plan did not pay for the prescription you tried to fill today, or the pharmacy could not
          fill it as written. Keep this notice — it explains what you can do about that.
        </p>

        {MEDICARE_RIGHTS_NOTICE.map((sec) => (
          <section key={sec.heading} className="mt-4">
            <h2 className="text-[12px] font-bold">{sec.heading}</h2>
            {sec.body.map((p) => <p key={p} className="mt-1.5">{p}</p>)}
          </section>
        ))}

        <section className="mt-5 border border-black p-3">
          <h2 className="text-[12px] font-bold">This pharmacy</h2>
          <p className="mt-1">
            {pharmacy}
            {s.pharmacy_phone ? ` · ${s.pharmacy_phone}` : ""}
          </p>
          <p className="mt-1 text-[10px]">
            The pharmacy cannot make a coverage decision for your plan and cannot grant an exception. Ask your plan,
            or ask your prescriber to contact them for you.
          </p>
        </section>

        <p className="mt-5 text-[9px]">
          Form CMS-10147. Distributed at the point of sale as required by 42 CFR 423.562(a)(3) and the CMS Medicare
          Prescription Drug Benefit Manual. This notice is also displayed in the pharmacy.
        </p>
      </div>
    </PrintFrame>
  );
}
