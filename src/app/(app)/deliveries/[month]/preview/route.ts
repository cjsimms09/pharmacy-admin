import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { invoicePdfFor } from "@/lib/deliveries";

/**
 * The invoice, on screen, before anybody else sees it.
 *
 * Served as a PDF rather than as an HTML page that resembles one. Two reasons, and both matter:
 * this is the exact file that will be attached to the email, so looking at anything else would be
 * looking at a different document; and every browser's PDF viewer has a print button, which is
 * the other half of what was asked for. Print from here and what comes out of the printer is what
 * lands in the accounts inbox.
 *
 * A month with nothing entered has no invoice to show, and says so rather than producing an empty
 * page with a total of zero on it.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ month: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { month } = await ctx.params;
  if (!/^\d{4}-\d{2}$/.test(month)) return new NextResponse("Not a month", { status: 400 });

  const built = await invoicePdfFor(month);
  if (!built) {
    return new NextResponse("Nothing has been entered for that month yet, so there is no invoice to show.", {
      status: 404,
    });
  }

  return new NextResponse(new Uint8Array(built.pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(built.pdf.length),
      // Inline, so it opens in the viewer rather than landing in Downloads. Saving and printing
      // are both one click from there.
      "Content-Disposition": `inline; filename="${built.fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
