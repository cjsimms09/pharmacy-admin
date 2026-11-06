import Link from "next/link";
import { isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { manualStanding } from "@/lib/manual-store";
import { fmt } from "@/lib/dates";
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
  const manual = await manualStanding();
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

      {/*
        The manual is the first document an inspector asks for, so it is the first one on this page.
        It is not an upload: the whole of it is held in this site and printed from it. Listing it
        here as a real entry is what stops the inspection checklist — and the pharmacist reading
        this page — from looking for a file that should not exist.
      */}
      <section className="card mb-6">
        <h2 className="mb-1 font-semibold">Policy and procedure manual</h2>
        <p className="mb-3 text-xs text-ink-3">K.A.R. 68-7-11. The first document asked for at an inspection, and the one every other answer is measured against.</p>
        {manual.inSite ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <p className="font-medium">Kept in this site — nothing to upload.</p>
              <p className="text-xs text-ink-2">
                {manual.ownSections} section{manual.ownSections === 1 ? "" : "s"} this pharmacy maintains
                {manual.managedElsewhere > 0 ? `, ${manual.managedElsewhere} the medical practice maintains` : ""} ·
                revision {manual.revision.fingerprint}
                {manual.revision.changedOn ? ` · last edited ${fmt(manual.revision.changedOn)}` : ""}
              </p>
              {manual.emptyHeadings > 0 && (
                <p className="mt-1 text-xs text-warn">
                  {manual.emptyHeadings} heading{manual.emptyHeadings === 1 ? " has" : "s have"} nothing written under {manual.emptyHeadings === 1 ? "it" : "them"}.
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <Link href="/manual" className="btn">Read and edit</Link>
              <Link href="/manual/print" className="btn btn-primary">Print the whole manual</Link>
            </div>
          </div>
        ) : (
          <Notice kind="warn">
            No manual is held in this site. Import the Word manual on the{" "}
            <Link href="/manual" className="underline">P&amp;P manual</Link> page — after that it is maintained here and
            prints as one document, rather than being a file that has to be kept in step by hand.
          </Notice>
        )}
      </section>

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
