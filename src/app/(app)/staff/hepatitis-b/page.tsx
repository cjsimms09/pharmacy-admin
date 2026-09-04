import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { onSiteToday } from "@/lib/roster";
import { fmt, fmtLong, todayIso } from "@/lib/dates";
import { PrintFrame } from "@/components/print";

export const dynamic = "force-dynamic";
export const metadata = { title: "Hepatitis B declination" };

/**
 * The declination form, in the words the standard requires.
 *
 * 29 CFR 1910.1030 Appendix A sets out this statement verbatim, and a paraphrase of it is not the
 * statement. An employee who was never offered the vaccine and an employee who declined it look
 * identical in an empty file — and only one of those is compliant — so the signed declination is
 * the record that matters, not the offer.
 *
 * Printed per person because the standard's wording is first-person and the file is per person.
 */
export default async function HepBPage({ searchParams }: { searchParams: Promise<{ person?: string }> }) {
  const user = await requireUser();
  const { person: personId } = await searchParams;
  const [s, people, creds] = await Promise.all([
    getSettings(),
    onSiteToday(),
    db.query.credentials.findMany({ where: eq(schema.credentials.type, "hepatitis_b") }),
  ]);

  const exposed = people.filter((p) => p.administersVaccines);
  const person = personId ? people.find((p) => p.id === personId) : undefined;
  const pharmacy = s.pharmacy_name || "this pharmacy";

  return (
    <PrintFrame
      ownDocument
      formTitle="Hepatitis B vaccination — declination"
      formNumber=""
      revised=""
      backHref="/staff"
    >
      <div className="no-print mb-4 space-y-3">
        <p className="text-sm text-ink-2">
          The standard requires the vaccine to be offered free of charge within ten working days of somebody taking on
          duties with occupational exposure, and requires this exact statement to be signed by anyone who declines.
          Record the outcome against them either way — under Required credentials on their page, as
          &ldquo;Hepatitis B vaccination offer or declination&rdquo;.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {exposed.length === 0 ? (
            <span className="text-sm text-ink-3">
              Nobody is marked as administering vaccines, so nobody currently has occupational exposure recorded.
            </span>
          ) : (
            exposed.map((p) => {
              const held = creds.find((c) => c.personId === p.id);
              return (
                <Link
                  key={p.id}
                  href={`/staff/hepatitis-b?person=${p.id}`}
                  className={`btn btn-sm ${personId === p.id ? "btn-primary" : ""}`}
                >
                  {p.firstName} {p.lastName}
                  <span className={`badge ${held ? "badge-ok" : "badge-crit"} ml-1`}>{held ? "on record" : "nothing"}</span>
                </Link>
              );
            })
          )}
        </div>
      </div>

      <div className="mb-4">
        <p className="text-lg font-bold">{s.pharmacy_name || "This pharmacy"}</p>
        <p className="text-xs">
          {[s.pharmacy_address, [s.pharmacy_city, s.pharmacy_state].filter(Boolean).join(", "), s.pharmacy_zip]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <div className="print-block border-2 border-black p-5">
        <p className="text-center text-sm font-bold uppercase tracking-wide">
          Hepatitis B vaccine declination
        </p>
        <p className="mt-1 text-center text-[11px]">Required by 29 CFR 1910.1030, Appendix A</p>

        <p className="mt-5 text-[12px]">
          Employee: <span className="inline-block min-w-[18rem] border-b border-black text-center">
            {person ? `${person.firstName} ${person.lastName}` : " "}
          </span>
        </p>

        <p className="mt-5 text-[12px] leading-relaxed">
          I understand that due to my occupational exposure to blood or other potentially infectious materials I may be
          at risk of acquiring hepatitis B virus (HBV) infection. I have been given the opportunity to be vaccinated
          with hepatitis B vaccine, at no charge to myself. However, I decline hepatitis B vaccination at this time. I
          understand that by declining this vaccine, I continue to be at risk of acquiring hepatitis B, a serious
          disease. If in the future I continue to have occupational exposure to blood or other potentially infectious
          materials and I want to be vaccinated with hepatitis B vaccine, I can receive the vaccination series at no
          charge to me.
        </p>

        <div className="mt-10 grid gap-8 sm:grid-cols-2">
          <div>
            <div className="border-b border-black" />
            <p className="mt-1 text-[10px]">Signature of employee</p>
          </div>
          <div>
            <div className="border-b border-black" />
            <p className="mt-1 text-[10px]">Date</p>
          </div>
        </div>

        <div className="mt-8 border-t border-black pt-3 text-[11px]">
          <p>
            The vaccination series was offered to the employee named above, free of charge and at a reasonable time and
            place, on ____________________ by ____________________________________ for {pharmacy}.
          </p>
        </div>
      </div>

      <div className="print-block mt-4 border border-black p-3 text-[10px] leading-relaxed">
        <p className="font-bold">Afterwards</p>
        <p className="mt-1">
          File the signed declination in the employee&rsquo;s confidential medical record, kept for the duration of
          employment plus thirty years, and record the outcome on their page so the exposure control plan has a record
          behind it rather than an assertion.
        </p>
        <p className="mt-1">
          A declination is not final. The employee may ask for the series at any later time and must receive it free of
          charge; there is nothing to re-sign if they change their mind.
        </p>
        <p className="mt-1">Printed {fmtLong(todayIso())} by {user.name}.</p>
      </div>

      {exposed.length > 0 && (
        <div className="no-print mt-6 rounded-lg border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold">Where everyone stands</h2>
          <div className="mt-2 overflow-x-auto">
            <table className="table">
              <thead><tr><th>Person</th><th>On record</th><th>Recorded</th><th></th></tr></thead>
              <tbody>
                {exposed.map((p) => {
                  const held = creds.find((c) => c.personId === p.id);
                  return (
                    <tr key={p.id}>
                      <td>{p.firstName} {p.lastName}</td>
                      <td>
                        {held ? <span className="badge badge-ok">yes</span> : <span className="badge badge-crit">nothing on file</span>}
                      </td>
                      <td className="text-xs text-ink-2">{held?.issuedOn ? fmt(held.issuedOn) : "—"}{held?.notes ? ` · ${held.notes}` : ""}</td>
                      <td>
                        <Link href={`/staff/${p.id}?add=hepatitis_b#credential-form`} className="btn btn-sm">Record it</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </PrintFrame>
  );
}
