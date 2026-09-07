import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { Hub } from "@/components/hub";

export const metadata = { title: "Tools" };

/**
 * The section landing: the feeds, the reference data and the log, from the same list the
 * sidebar draws.
 *
 * This page used to carry a second board underneath — nine cards naming the reimbursement pages
 * with a hand-typed "ready", "waiting" or "needs work" and a sentence about what each was waiting
 * on. The sentences were written on the day each page was built and never again, so within a
 * month the board said NADAC had nothing loaded while the NADAC page showed the week's file. A
 * status that is typed rather than measured is wrong by default; the pages themselves say what
 * they are waiting on, in figures, and Today ranks what is due.
 */
export default async function ToolsPage() {
  await requireUser();
  return (
    <>
      <PageHeader title="Tools" subtitle="The feeds and the reference data behind every figure, and the log of who did what." />
      <Hub href="/tools" />
    </>
  );
}
