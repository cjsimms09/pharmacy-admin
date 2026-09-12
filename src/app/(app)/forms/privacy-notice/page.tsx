import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { onSiteToday } from "@/lib/roster";
import { noticeOfPrivacyPractices } from "@/lib/patient-forms";
import { fmtLong, todayIso } from "@/lib/dates";
import { PrintFrame } from "@/components/print";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notice of Privacy Practices" };

/**
 * The Notice itself, which the pharmacy did not have.
 *
 * It had the acknowledgement — the patient's signature saying they were given the Notice — and no
 * Notice. The two names are nearly identical and that is exactly how it happens: a signature on
 * file for a document that does not exist, and an inspection screen correctly reporting that
 * nothing is filed.
 *
 * 45 CFR 164.520(b)(1) says what a notice must contain, and it is a list rather than a style: the
 * header in the words the rule prescribes, the uses and disclosures, the ones the law permits
 * without authorisation, that everything else needs written authorisation which may be revoked,
 * each individual right, the pharmacy's duties, how to complain to the pharmacy and to the
 * Secretary, no retaliation, a contact, an effective date. Every one of those is here.
 *
 * It is a starting document and says so on its face. A notice is a promise about what the pharmacy
 * does with people's records, and this one was written without being told what this pharmacy does
 * beyond what the compliance system already knows — so it goes past somebody qualified before it
 * goes on the wall.
 */
export default async function PrivacyNoticePage() {
  await requireUser();
  const [s, people] = await Promise.all([getSettings(), onSiteToday()]);
  const pharmacy = s.pharmacy_name || "This pharmacy";
  const pic = people.find((p) => p.isPic);
  const address =
    [s.pharmacy_address, [s.pharmacy_city, s.pharmacy_state].filter(Boolean).join(", "), s.pharmacy_zip]
      .filter(Boolean)
      .join(" · ") || null;

  const notice = noticeOfPrivacyPractices({
    pharmacy,
    address,
    phone: s.pharmacy_phone || null,
    privacyOfficer: pic ? `${pic.firstName} ${pic.lastName}, pharmacist-in-charge` : null,
    effectiveOn: fmtLong(todayIso()),
  });

  return (
    <PrintFrame
      ownDocument
      formTitle="Notice of Privacy Practices"
      formNumber=""
      revised={todayIso()}
      backHref="/forms"
      pageLabel={pharmacy}
    >
      <div className="text-[11px] leading-relaxed">
        <div className="no-print mb-4 rounded-md border border-warn bg-warn-soft p-3 text-xs">
          <b>Read this before it goes on the wall.</b> Everything 45 CFR 164.520(b)(1) requires is here, written for a
          patient standing at a counter rather than for a lawyer. But a Notice is a promise about what this pharmacy
          does with people&rsquo;s records, and it was written from what the compliance system knows — not from a
          conversation with you. Check the sections on what you share and who your patients should contact, then have
          your PSAO or your attorney read it. When you are happy with it, print it, post it where patients can see it,
          and upload a copy under Documents so the inspection screen can find it.
        </div>

        <div className="mb-4">
          <div className="text-sm font-bold">{pharmacy}</div>
          {address && <div className="text-[10px]">{address}</div>}
          {s.pharmacy_phone && <div className="text-[10px]">{s.pharmacy_phone}</div>}
        </div>

        {/* The header, in the words the rule prescribes. It is not ours to paraphrase. */}
        <div className="border-y-2 border-black py-2 text-center text-[11px] font-bold uppercase leading-snug">
          {notice.heading}
        </div>

        {notice.sections.map((sec) => (
          <section key={sec.title} className="mt-4 print-block">
            <h2 className="text-[12px] font-bold">{sec.title}</h2>
            {sec.paragraphs.map((para) => (
              <p key={para.slice(0, 40)} className="mt-1.5">{para}</p>
            ))}
          </section>
        ))}

        <p className="mt-6 border-t border-black pt-2 text-[9px]">
          A copy of this notice is displayed in the pharmacy and is available on request. The acknowledgement that a
          patient was offered it is a separate form —{" "}
          <Link href="/forms/privacy-acknowledgement" className="underline">
            Records &rarr; Forms &rarr; Privacy acknowledgement
          </Link>{" "}
          — and 45 CFR 164.520(c)(2)(ii) asks for a good faith effort to obtain it, not for a signature every time.
        </p>
      </div>
    </PrintFrame>
  );
}
