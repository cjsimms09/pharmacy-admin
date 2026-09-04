import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { allSections, outline } from "@/lib/manual-store";
import { fmtLong, todayIso } from "@/lib/dates";
import { PrintButton } from "@/components/print-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Print the manual" };

/**
 * The whole manual, as one printable document.
 *
 * A manual that only exists on a screen is not a manual an inspector can be handed, and a manual
 * that is exported by copying sections into Word by hand is one that goes out of date the first
 * time somebody is in a hurry. So the export is a page: cover, contents, numbered body, in the
 * order the sections are stored, generated fresh every time it is opened.
 *
 * Numbering is computed here rather than stored, because a number stored against a section is
 * wrong the moment a section is inserted above it, and a manual whose contents page disagrees
 * with its body is worse than one with no contents page at all.
 */
export default async function ManualPrintPage() {
  await requireUser();
  const [sections, s, people] = await Promise.all([
    allSections(),
    getSettings(),
    db.query.people.findMany({ where: eq(schema.people.active, true) }),
  ]);
  const pic = people.find((p) => p.isPic);
  const pharmacy = s.pharmacy_name || "This pharmacy";

  const numbered = outline(sections);

  const reviewed = sections
    .map((x) => x.reviewedOn)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1);

  return (
    <div className="mx-auto max-w-[8.5in] bg-white text-black print:max-w-none">
      <div className="no-print mb-4 rounded-md border border-line bg-ground px-3 py-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href="/manual" className="text-ink-2 hover:text-ink">← Back to the manual</Link>
          <PrintButton />
        </div>
        <p className="mt-2 text-xs text-ink-2">
          <b>Before you print:</b> open <b>More settings</b> and untick <b>Headers and footers</b>, so the web address
          does not print along the bottom of every page of your policy manual. Set Margins to <b>Default</b> and Scale
          to <b>100%</b>. Then print to paper, or save as PDF for the copy you keep.
        </p>
        <p className="mt-1 text-xs text-ink-3">
          {sections.length} sections. Printed straight from the live manual, so this is current as of right now — there
          is no separate file to keep in step.
        </p>
      </div>

      {/* Cover */}
      <section className="print-block flex min-h-[7in] flex-col justify-center border-b-2 border-black text-center">
        <div className="text-xs uppercase tracking-[0.2em] text-neutral-600">Policy and procedure manual</div>
        <h1 className="mt-3 text-3xl font-bold">{pharmacy}</h1>
        <div className="mt-2 text-sm">
          {s.pharmacy_address}
          {s.pharmacy_address ? <br /> : null}
          {[s.pharmacy_city, s.pharmacy_state, s.pharmacy_zip].filter(Boolean).join(", ")}
          {s.pharmacy_phone ? <><br />{s.pharmacy_phone}</> : null}
        </div>
        <dl className="mx-auto mt-8 grid w-[4.5in] grid-cols-2 gap-x-4 gap-y-1 text-left text-[11px]">
          {pic && (
            <>
              <dt className="text-neutral-600">Pharmacist-in-charge</dt>
              <dd>{pic.firstName} {pic.lastName}</dd>
            </>
          )}
          {s.pharmacy_registration_number && (
            <>
              <dt className="text-neutral-600">Kansas registration</dt>
              <dd>{s.pharmacy_registration_number}</dd>
            </>
          )}
          {s.pharmacy_dea && (
            <>
              <dt className="text-neutral-600">DEA registration</dt>
              <dd>{s.pharmacy_dea}</dd>
            </>
          )}
          {s.pharmacy_npi && (
            <>
              <dt className="text-neutral-600">NPI</dt>
              <dd>{s.pharmacy_npi}</dd>
            </>
          )}
          <dt className="text-neutral-600">Printed</dt>
          <dd>{fmtLong(todayIso())}</dd>
          <dt className="text-neutral-600">Last section reviewed</dt>
          <dd>{reviewed ? fmtLong(reviewed) : "not recorded"}</dd>
        </dl>
        <p className="mx-auto mt-8 max-w-[5in] text-[10px] leading-relaxed text-neutral-700">
          This manual is maintained in the pharmacy&rsquo;s compliance system and printed from it. The sections in
          Appendix A are generated from that system, so they describe the procedures the pharmacy actually performs and
          the forms it actually produces. Any printed copy is a copy; the current version is the one in the system.
        </p>
      </section>

      {/* Contents */}
      <section className="print-page-break mt-8">
        <h2 className="print-heading border-b border-black pb-1 text-lg font-bold">Contents</h2>
        <ul className="mt-2 text-[11px] leading-relaxed">
          {numbered.map((x) => (
            <li key={x.id} style={{ paddingLeft: `${x.depth * 16}px` }} className={x.depth === 0 ? "mt-1 font-semibold" : ""}>
              <span className="inline-block w-14 text-neutral-600">{x.number}</span>
              {x.title}
            </li>
          ))}
        </ul>
      </section>

      {/* Body */}
      <section className="print-page-break mt-10 space-y-5">
        {numbered.map((x) => (
          <article key={x.id} className="print-prose">
            {x.depth === 0 ? (
              <h2 className="print-heading mt-6 border-b border-black pb-1 text-base font-bold">
                {x.number}. {x.title}
              </h2>
            ) : (
              <h3 className={`print-heading mt-4 font-semibold ${x.depth === 1 ? "text-sm" : "text-[12px]"}`}>
                {x.number} {x.title}
              </h3>
            )}
            {x.body.trim() ? (
              <div className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed">{x.body.trim()}</div>
            ) : x.hasChildren ? null : (
              <div className="mt-1 text-[11px] italic text-neutral-500">[This section has no text. Nothing is claimed under this heading.]</div>
            )}
          </article>
        ))}
      </section>

      <footer className="mt-10 border-t border-black pt-2 text-[10px] text-neutral-700">
        {pharmacy} — policy and procedure manual. Printed {fmtLong(todayIso())}.
      </footer>
    </div>
  );
}
