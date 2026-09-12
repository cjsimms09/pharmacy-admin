import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { certificateFor } from "@/lib/certificate";
import { fileCertificate } from "@/lib/certificate-filing";
import { Certificate } from "@/components/certificate";
import { BackLink, Notice } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Certificate" };

export default async function CertificatePage({
  params,
  searchParams,
}: {
  params: Promise<{ trainingId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { trainingId } = await params;
  const { ok, error } = await searchParams;
  const c = await certificateFor(trainingId);
  if (!c) notFound();

  /**
   * Filing a copy under Documents.
   *
   * The live certificate remains the authority — it is built from the record every time it is
   * opened, so it cannot drift. This puts a copy in the vault for the binder, the personnel file
   * and the backup, stamped with the verification code that was current when it was taken.
   */
  async function file() {
    "use server";
    const u = await requireManager();
    try {
      const r = await fileCertificate(trainingId, u);
      await audit({ action: "training.certificate_filed", userId: u.id, userName: u.name, details: r.fileName });
      revalidatePath(`/certificates/${trainingId}`);
      revalidatePath("/documents");
      redirect(
        `/certificates/${trainingId}?ok=` +
          encodeURIComponent(`Filed under Documents as ${r.fileName}. It is on the next backup.`),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect(
        `/certificates/${trainingId}?error=` +
          encodeURIComponent(e instanceof Error ? e.message : "Could not file a copy."),
      );
    }
  }

  return (
    <>
      <div className="print:hidden">
        <BackLink href="/compliance/training">Training</BackLink>
        {ok && <div className="mt-3"><Notice kind="ok">{ok}</Notice></div>}
        {error && <div className="mt-3"><Notice kind="crit">{error}</Notice></div>}
        <p className="mt-3 text-sm text-ink-2">
          This is generated from the record every time it is opened, so it can never disagree with the register. The
          address is permanent and can be given to an auditor as it is.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link href={`/certificates/${trainingId}/pdf`} target="_blank" rel="noreferrer" className="btn btn-sm">
            Open as a PDF
          </Link>
          <form action={file}>
            <button className="btn btn-sm btn-primary">File a copy under Documents</button>
          </form>
        </div>
        <p className="mt-2 text-xs text-ink-3">
          A filed copy carries the verification code it had when it was taken. If the record changes afterwards the
          codes stop matching, so a copy in the vault can become visibly older but never quietly wrong.
        </p>
      </div>
      <div className="mt-4">
        <Certificate c={c} />
      </div>
      <p className="mt-4 text-xs text-ink-3 print:hidden">Opened by {user.name}.</p>
    </>
  );
}
