import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { certificateFor } from "@/lib/certificate";
import { Certificate } from "@/components/certificate";
import { BackLink } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Certificate" };

export default async function CertificatePage({ params }: { params: Promise<{ trainingId: string }> }) {
  const user = await requireUser();
  const { trainingId } = await params;
  const c = await certificateFor(trainingId);
  if (!c) notFound();

  return (
    <>
      <div className="print:hidden">
        <BackLink href="/compliance/training">Training</BackLink>
        <p className="mt-3 text-sm text-ink-2">
          This is generated from the record every time it is opened, so it can never disagree with the register. Print
          it or save it as a PDF from your browser — the address is permanent and can be given to an auditor as it is.
        </p>
      </div>
      <div className="mt-4">
        <Certificate c={c} />
      </div>
      <p className="mt-4 text-xs text-ink-3 print:hidden">Opened by {user.name}.</p>
    </>
  );
}
