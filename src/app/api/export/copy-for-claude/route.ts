import { NextResponse } from "next/server";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { buildClaudeCopy } from "@/lib/backup-scrub";

export const dynamic = "force-dynamic";
// Copying, scrubbing and proving a database of this size takes tens of seconds, not the default.
export const maxDuration = 300;

/**
 * The scrubbed copy, as a download.
 *
 * Behind the manager login, written to the audit log, and — this is the part that matters — never
 * produced at all unless the copy passes its own privacy check. `buildClaudeCopy` snapshots,
 * scrubs, and then reads every text value back looking for anything that still looks like an
 * identifier; a copy that fails is refused and nothing is written. So there is no moment at which
 * an unscrubbed file exists somewhere it could be picked up by mistake, and no way for this route
 * to hand one over.
 *
 * A route rather than a form action because it is a file leaving the building, and a file leaving
 * the building should be a download with a name on it rather than something a page does invisibly.
 */
export async function GET() {
  const user = await requireManager();
  const built = await buildClaudeCopy();

  if (!built.ok) {
    await audit({
      action: "backup.copy_for_claude_refused",
      userId: user.id,
      userName: user.name,
      details: built.why.slice(0, 400),
    });
    return NextResponse.json(
      {
        error: built.why,
        found: built.found,
        whatToDo:
          "Nothing was written and nothing left the pharmacy. Send this message to Claude: the site has a column " +
          "the scrubber does not know about, and the scrubber is what needs changing before a copy can be made.",
      },
      { status: 409 },
    );
  }

  await audit({
    action: "backup.copy_for_claude",
    userId: user.id,
    userName: user.name,
    details:
      `${built.fileName}, ${(built.bytes / 1_048_576).toFixed(1)} MB. ` +
      `${built.report.prescriptions.toLocaleString()} prescription numbers replaced; ` +
      `${built.checked.toLocaleString()} values checked and none held an identifier.`,
  });

  return new NextResponse(new Uint8Array(built.data!), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${built.fileName}"`,
      "Content-Length": String(built.bytes),
      "Cache-Control": "no-store",
    },
  });
}
