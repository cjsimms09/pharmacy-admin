import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { todayIso } from "@/lib/dates";
import { trainingBinderPdf, binderFileName } from "@/lib/training-binder";

/**
 * Every course, in one file, for the binder in the pharmacy.
 *
 * One address rather than six, because printing the set one course at a time from six different
 * pages is exactly the small friction that leaves a binder a year out of date. Generated on the
 * spot from the same page builder as the individual handouts, so what comes out of the printer is
 * what was emailed and cannot drift from it.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const s = await getSettings();
  const on = todayIso();
  const pdf = trainingBinderPdf(s.pharmacy_name || "This pharmacy", on, user.name);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.length),
      "Content-Disposition": `inline; filename="${binderFileName(on)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
