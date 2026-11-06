import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { buildBundle, sourceForPath, genericBundle } from "@/lib/diagnostic-sources";

export const dynamic = "force-dynamic";

/**
 * The export for whatever page somebody is on.
 *
 * The button that used to be added page by page now lives in the frame, so it does not know which
 * export it wants — it knows where it is. This maps the one to the other, and answers with the
 * site's own state where a page has no loader yet, because a button that sometimes does nothing is
 * worse than no button: it teaches the pharmacy not to press it.
 *
 * Behind the same login as everything else, and every download is written to the audit log with
 * what was taken and whether real prescription numbers went with it.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser();
  const params = req.nextUrl.searchParams;
  const path = params.get("path") ?? "/";

  // The page's own query string travels with it, so the export answers the same question the
  // screen was answering — the month being viewed, the filter that was set.
  const forward = new URLSearchParams(params);
  forward.delete("path");

  const source = sourceForPath(path);
  const built = source ? await buildBundle(source.key, forward) : null;
  const { bundle, filename } =
    built && built.ok ? { bundle: built.bundle, filename: built.filename } : await genericBundle(path, forward);

  await audit({
    action: "diagnostics.export",
    userId: user.id,
    userName: user.name,
    entity: "page",
    entityId: source?.key ?? path,
    details:
      `${bundle.pageTitle} exported` +
      (bundle.privacy.identifiersIncluded
        ? " WITH real prescription numbers"
        : ` with ${bundle.privacy.distinctPrescriptions} prescription numbers replaced by stand-ins`),
  });

  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      // Never let a proxy or the browser keep a copy of one of these.
      "cache-control": "no-store, no-cache, must-revalidate, private",
    },
  });
}
