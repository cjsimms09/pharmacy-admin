import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { FORMS, appendixVersion, policies } from "@/lib/manual";
import { PageHeader, Card, Notice } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Forms" };

/**
 * Every form this pharmacy uses, in one place.
 *
 * A pharmacist-in-charge asked where the forms were, and the honest answer was "each one is on
 * the page that produces it, and you have to know which page that is." That is a filing system
 * only its author can use. An inspector asking for the technician list, a new employee asked to
 * sign an acknowledgement, a locum wanting the daily log sheet — none of them should have to
 * learn the site's shape first.
 *
 * The list is the same list the policy manual's appendix is generated from, deliberately: what
 * this page shows and what the manual says the pharmacy uses cannot differ, because they are one
 * array read twice.
 */
export default async function FormsPage() {
  await requireUser();
  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "This pharmacy";
  const version = appendixVersion(policies(pharmacy));

  return (
    <>
      <PageHeader
        title="Forms"
        subtitle="Every form this pharmacy produces, what it records, and where it comes from. Nothing here is a blank kept on a shelf — each one is produced from the record it belongs to."
        actions={
          <>
            <Link href="/manual" className="btn">In the manual</Link>
            <Link href="/inspection" className="btn btn-primary">Inspection pack</Link>
          </>
        }
      />

      <Notice kind="ok">
        These twelve are also Appendix A.2 of the policy manual, generated from this same list — so the manual
        describes the forms the pharmacy actually uses, down to the fields on them. Appendix version <b>{version}</b>.
      </Notice>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {FORMS.map((f) => (
          <Card key={f.name} title={f.name} actions={<Link href={f.href} className="btn btn-sm btn-primary">Open</Link>}>
            <p className="card-sub">{f.purpose}</p>
            <dl className="mt-2 space-y-1.5 text-sm">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-ink-3">What it records</dt>
                <dd>
                  <ul className="ml-4 list-disc text-ink-2">
                    {f.fields.map((x) => <li key={x}>{x}</li>)}
                  </ul>
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 pt-1 text-xs text-ink-3">
                <span><b className="font-semibold text-ink-2">When:</b> {f.cadence}</span>
                <span><b className="font-semibold text-ink-2">Where:</b> {f.where}</span>
                <span><b className="font-semibold text-ink-2">Authority:</b> {f.authority}</span>
              </div>
            </dl>
          </Card>
        ))}
      </div>
    </>
  );
}
