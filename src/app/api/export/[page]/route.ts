import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { buildBundle } from "@/lib/diagnostic-sources";

export const dynamic = "force-dynamic";

/**
 * Hands a page's own data over as a file.
 *
 * Behind the same login as everything else — an export is a disclosure, and one reachable without
 * signing in would be a way to read the pharmacy's whole position from outside it. Every download
 * is written to the audit log with what was taken and whether real prescription numbers went with
 * it, because "who sent that file and what was in it" is a question that gets asked afterwards.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ page: string }> }) {
  const user = await requireUser();
  const { page } = await ctx.params;
  const params = req.nextUrl.searchParams;

  const built = await buildBundle(page, params);
  if (!built.ok) return NextResponse.json({ error: built.why }, { status: 404 });

  await audit({
    action: "diagnostics.export",
    userId: user.id,
    userName: user.name,
    entity: "page",
    entityId: page,
    details:
      `${built.bundle.pageTitle} exported` +
      (built.bundle.privacy.identifiersIncluded
        ? " WITH real prescription numbers"
        : ` with ${built.bundle.privacy.distinctPrescriptions} prescription numbers replaced by stand-ins`),
  });

  return new NextResponse(JSON.stringify(built.bundle, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${built.filename}"`,
      // Never let a proxy or the browser keep a copy of one of these.
      "cache-control": "no-store, no-cache, must-revalidate, private",
    },
  });
}
