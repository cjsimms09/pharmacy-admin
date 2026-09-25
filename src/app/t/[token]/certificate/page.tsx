import { notFound } from "next/navigation";
import { certificateForToken } from "@/lib/certificate";
import { Certificate } from "@/components/certificate";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your certificate" };

/**
 * The person's own copy, reachable from the link they were sent and nothing else.
 *
 * Worth having for its own sake: somebody who has just done twenty minutes of training should be
 * able to keep proof of it without asking their employer, and a person who can produce their own
 * training history is a person who does the training.
 */
export default async function StaffCertificatePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const c = await certificateForToken(token);
  if (!c) notFound();

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <p className="mb-4 text-sm text-ink-2 print:hidden">
        Your certificate. Print it or save it as a PDF from your browser — this page stays at the same address.
      </p>
      <Certificate c={c} />
    </main>
  );
}
