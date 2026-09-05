import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { allSections, outline } from "@/lib/manual-store";
import { fmtLong, todayIso } from "@/lib/dates";
import { PrintButton } from "@/components/print-button";
import { logo } from "@/lib/branding";
import { revisionOf } from "@/lib/manual-version";

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
  const [sections, s, people, mark] = await Promise.all([
    allSections(),
    getSettings(),
    db.query.people.findMany({ where: eq(schema.people.active, true) }),
    logo(),
  ]);
  const revision = revisionOf(sections);
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

      {/*
        The cover.

        A title page is the whole of the first impression a manual makes, and this one was a line
        of small capitals and a heading. It now carries the pharmacy's own mark, a rule under it,
        and the identifying facts an inspector opens a manual to find — the registration it is
        written for and the pharmacist accountable for it — rather than leaving them to be hunted
        for inside.
      */}
      <section className="print-block flex min-h-[9in] flex-col justify-center border-b-2 border-black text-center">
        {mark && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mark.url} alt="" className="mx-auto mb-8 max-h-[1.6in] w-auto max-w-[4in] object-contain" />
        )}
        <div className="mx-auto h-px w-24 bg-black" />
        <h1 className="mt-6 text-[2.1rem] font-bold leading-tight tracking-tight">{pharmacy}</h1>
        <div className="mt-3 text-[13px] uppercase tracking-[0.28em] text-neutral-700">
          Policy and Procedure Manual
        </div>
        <div className="mx-auto mt-6 h-px w-24 bg-black" />
        <div className="mt-6 text-sm">
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
          <dt className="text-neutral-600">Revision</dt>
          <dd className="font-mono">{revision.fingerprint}</dd>
          <dt className="text-neutral-600">Sections</dt>
          <dd>{revision.sections}</dd>
          <dt className="text-neutral-600">Printed</dt>
          <dd>{fmtLong(todayIso())}</dd>
          <dt className="text-neutral-600">Last section reviewed</dt>
          <dd>{reviewed ? fmtLong(reviewed) : "not recorded"}</dd>
        </dl>

        {/*
          The approval block.

          A policy manual with nobody's name on it is a document nobody adopted. This is the line
          an inspector looks for and the one a court would: who is accountable for it, and from
          when. The revision is printed beside it so the signature names the version it approves —
          the same fingerprint the staff acknowledgements are recorded against.
        */}
        <div className="mx-auto mt-10 w-[5in] border border-black p-3 text-left text-[10px]">
          <div className="text-[11px] font-bold">Adopted for this pharmacy</div>
          <p className="mt-1 leading-relaxed">
            This manual, revision <span className="font-mono">{revision.fingerprint}</span>, is adopted as the policy
            and procedure manual of {pharmacy}. Staff acknowledge it by revision, and the acknowledgements are held in
            the pharmacy&rsquo;s compliance system.
          </p>
          <div className="mt-6 grid grid-cols-2 gap-x-8">
            <div>
              <div className="border-b border-black" />
              <div className="pt-1">
                {pic ? `${pic.firstName} ${pic.lastName}, ` : ""}pharmacist-in-charge
              </div>
            </div>
            <div>
              <div className="border-b border-black" />
              <div className="pt-1">Date</div>
            </div>
          </div>
        </div>
        <p className="mx-auto mt-8 max-w-[5in] text-[10px] leading-relaxed text-neutral-700">
          This manual is maintained in the pharmacy&rsquo;s compliance system and printed from it. The sections in
          Appendix A are generated from that system, so they describe the procedures the pharmacy actually performs and
          the forms it actually produces. Any printed copy is a copy; the current version is the one in the system.
        </p>
      </section>

      {/*
        Everything after the cover sits in one table, for one reason: the running header.

        A hundred and forty loose sheets carrying nothing but body text cannot be put back in
        order, and a page adrift of the binder cannot be identified at all — so each one needs the
        pharmacy's name and the revision on it. The obvious way to do that is a fixed-position
        element, and it is wrong: fixed positioning repeats the header on every sheet but reserves
        space for it on none, so it printed straight over the first line of text on all twenty
        pages. Padding the body only makes room on the first.

        A table header group is the one construction a browser genuinely repeats *and* makes room
        for. So the contents and the body are the single cell of a one-column table whose thead
        carries the running header. It looks like an odd way to lay out a document and it is the
        only one that works.
      */}
      <table className="w-full border-separate border-spacing-0">
        <thead className="hidden print:table-header-group">
          <tr>
            <th className="p-0">
              <div className="mb-3 flex items-baseline justify-between border-b border-neutral-400 pb-1 text-[8px] font-normal text-neutral-600">
                <span className="font-semibold">{pharmacy} — Policy and Procedure Manual</span>
                <span className="font-mono">rev {revision.fingerprint}</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="p-0 align-top">

      {/* Contents */}
      <section className="print-page-break mt-8">
        <h2 className="print-heading border-b-2 border-black pb-1 text-lg font-bold tracking-tight">Contents</h2>
        <ul className="mt-3 text-[11px] leading-relaxed">
          {numbered.map((x) => (
            <li
              key={x.id}
              style={{ paddingLeft: `${x.depth * 16}px` }}
              className={x.depth === 0 ? "mt-2.5 border-b border-neutral-300 pb-0.5 font-semibold" : "text-neutral-800"}
            >
              <span className="inline-block w-14 text-neutral-600">{x.number}</span>
              {x.title}
              {x.depth === 0 && x.managedBy && (
                <span className="ml-2 text-[9px] font-normal italic text-neutral-600">
                  maintained by {x.managedBy}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* Body */}
      <section className="print-page-break mt-10 space-y-5">
        {numbered.map((x) => (
          <article key={x.id} className="print-prose">
            {x.depth === 0 ? (
              // A chapter starts a sheet of its own. Running two chapters together down one page
              // is what makes a manual feel like a printout rather than a document.
              <header className="print-page-break pt-2">
                <div className="text-[9px] uppercase tracking-[0.22em] text-neutral-600">Chapter {x.number}</div>
                <h2 className="print-heading mt-1 border-b-2 border-black pb-1.5 text-xl font-bold tracking-tight">
                  {x.title}
                </h2>
                {x.managedBy && (
                  <p className="mt-1.5 border-l-2 border-neutral-400 pl-2 text-[10px] italic text-neutral-700">
                    Maintained by {x.managedBy}. Reproduced here because this pharmacy is bound by it; not written by
                    the pharmacy, and not amended by it.
                  </p>
                )}
              </header>
            ) : (
              <h3
                className={`print-heading mt-5 border-b border-neutral-300 pb-0.5 font-semibold ${
                  x.depth === 1 ? "text-[13px]" : "text-[11.5px] text-neutral-800"
                }`}
              >
                <span className="mr-2 text-neutral-600">{x.number}</span>
                {x.title}
              </h3>
            )}
            {x.body.trim() ? (
              <div className="mt-1.5 whitespace-pre-wrap text-[11px] leading-[1.55]">{x.body.trim()}</div>
            ) : x.hasChildren ? null : (
              <div className="mt-1 text-[11px] italic text-neutral-500">[This section has no text. Nothing is claimed under this heading.]</div>
            )}
          </article>
        ))}
      </section>

            </td>
          </tr>
        </tbody>
      </table>

      <footer className="mt-10 border-t-2 border-black pt-2 text-[10px] text-neutral-700">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span>
            <b>{pharmacy}</b> — policy and procedure manual, revision{" "}
            <span className="font-mono">{revision.fingerprint}</span>.
          </span>
          <span>Printed {fmtLong(todayIso())}. End of manual.</span>
        </div>
      </footer>
    </div>
  );
}
