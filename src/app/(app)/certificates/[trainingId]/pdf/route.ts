import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { certificateFor } from "@/lib/certificate";
import { certificatePdf, certificateFileName } from "@/lib/certificate-pdf";

/** The certificate as a file — same record, same verification code, in something you can keep. */
export async function GET(_req: Request, ctx: { params: Promise<{ trainingId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { trainingId } = await ctx.params;
  const c = await certificateFor(trainingId);
  if (!c) return new NextResponse("No such training record", { status: 404 });

  const pdf = certificatePdf(c);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.length),
      "Content-Disposition": `inline; filename="${certificateFileName(c)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
