import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { FORMS } from "@/lib/manual";
import { PageHeader, Card, Figure } from "@/components/ui";
import { Hub } from "@/components/hub";

export const dynamic = "force-dynamic";
export const metadata = { title: "Records" };

/**
 * What the pharmacy can produce on request.
 *
 * The Board's question is never "do you have a system"; it is "show me the technician list for
 * March". This page is the index to that: the forms, the agreements, the attestations, what
 * arrived by email, and who did what. Everything an inspector asks for is one click from here,
 * which is the only property that matters at the counter with somebody waiting.
 */
export default async function RecordsPage() {
  await requireUser();
  const s = await getSettings();
  const pharmacy = s.pharmacy_name || "This pharmacy";

  return (
    <>
      <PageHeader
        title="Records"
        subtitle={`Everything ${pharmacy} keeps and can produce on request. Records held here are electronic on purpose — the Board's test is that they can be separated out and produced within 48 hours, and they can.`}
        actions={<Link href="/inspection" className="btn btn-primary">Inspection pack</Link>}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Figure value={FORMS.length} label="Forms produced here" sub="Each one described in the manual's appendix" tone="ok" href="/forms" />
        <Figure value="5 yrs" label="Retention" sub="Prescription and controlled substance records" tone="ok" />
        <Figure value="48 hrs" label="Retrieval" sub="What “readily retrievable” means to the Board" tone="ok" />
      </div>

      <h2 className="mb-3">In this section</h2>
      <Hub href="/records" />

      <Card title="The one that cannot be electronic" tone="warn" className="mt-6">
        <p className="text-sm text-ink-2">
          Controlled substance inventories. K.A.R. 68-20-16 requires legible hard copy and 21 CFR 1304.11(a) requires
          written, typewritten or printed form at the registered location — so the C-250 is printed, signed by everyone
          who counted, filed on the premises, and scanned back in.{" "}
          <Link href="/inventory" className="underline">Inventories</Link>.
        </p>
      </Card>
    </>
  );
}
