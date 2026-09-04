import Link from "next/link";
import { isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { PageHeader, Notice } from "@/components/ui";
import { DocumentList, UploadForm } from "@/components/documents";

export const metadata = { title: "Documents" };

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requireManager();
  const { error, saved } = await searchParams;
  const docs = await db.query.documents.findMany({
    where: isNull(schema.documents.personId),
    orderBy: (d, { desc }) => [desc(d.uploadedAt)],
  });
  const here = "/documents";
  const protocols = docs.filter((d) => d.category === "immunization_protocol");
  const others = docs.filter((d) => d.category !== "immunization_protocol" && !d.csInventoryId && !d.credentialId);

  return (
    <>
      <PageHeader
        title="Pharmacy documents"
        subtitle="Protocols, policies and everything else the pharmacy holds. Anything that expires is on Licences; staff documents are on each person's page."
        actions={
          <>
            <Link href="/licenses" className="btn">Licences</Link>
            <Link href="/forms" className="btn">Forms</Link>
            <Link href="/manual" className="btn">P&amp;P manual</Link>
          </>
        }
      />
      {error && <Notice kind="crit">{error}</Notice>}
      {saved && <Notice>Saved.</Notice>}

      <Notice kind="ok">
        Registrations, DEA, insurance and anything else with an expiry date now live on{" "}
        <Link href="/licenses" className="underline">Licences</Link>, sorted by what runs out first. This page is for
        documents with nothing to count down to.
      </Notice>

      <section className="card mb-6">
        <h2 className="mb-1 font-semibold">Immunization protocols</h2>
        <p className="mb-3 text-xs text-ink-3">Physician-signed protocols under K.S.A. 65-1635a. Keep each version; set the effective date and, if the protocol has a review date, its expiration.</p>
        <DocumentList docs={protocols} redirectTo={here} canManage />
      </section>

      <section className="card mb-6">
        <h2 className="mb-3 font-semibold">All other pharmacy documents</h2>
        <DocumentList docs={others} redirectTo={here} canManage />
      </section>

      <section className="card">
        <h2 className="mb-3 font-semibold">Upload a pharmacy document</h2>
        <p className="mb-3 text-xs text-ink-3">For anything without an expiration date to track. Items that expire belong in the section above so the dashboard can warn you.</p>
        <UploadForm redirectTo={here} categories={["immunization_protocol", "policy", "agreement", "insurance", "pharmacy_registration", "dea_registration", "controlled_substance_poa", "cs_inventory", "other"]} defaultCategory="immunization_protocol" />
      </section>
    </>
  );
}
