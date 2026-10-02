import { NextResponse, type NextRequest } from "next/server";
import { isRetired } from "@/lib/retired";

/**
 * A retired address lands on one sentence, never on the old page and never on an error (src/lib/retired.ts). The
 * matcher below must name every prefix RETIRED names; tests/retired.test.ts checks that it does.
 */
export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (!isRetired(path)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/retired";
  url.search = `?from=${encodeURIComponent(path)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/purchasing/:path*",
    "/nadac/:path*",
    "/inventory/returns/:path*",
    "/suppliers/:id/terms/:path*",
    "/money/found/:path*",
    "/claims/appeals/:path*",
    "/claims/floor/:path*",
    "/plans/:path*",
    "/payers/plans/:path*",
    "/payers/performance/:path*",
    "/payers/networks/:path*",
    "/payers/contracts/:path*",
    "/payers/sort/:path*",
    "/tools/check/:path*",
    "/tools/data-health/:path*",
    "/reports/:path*",
    "/settings/features/:path*",
    "/v2/:path*",
  ],
};
