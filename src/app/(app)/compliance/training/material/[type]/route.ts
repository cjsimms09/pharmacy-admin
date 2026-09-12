import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { trainingMaterial } from "@/lib/training-material";
import { TRAINING_TYPES, type TrainingType } from "@/db/schema";

/**
 * The training material itself, to read on screen or print.
 *
 * It went out as an email attachment and existed nowhere else, so the pharmacist-in-charge could
 * not read what his own staff had been sent without finding the email — and an inspector asking
 * "show me the bloodborne pathogens training you gave them" was a search of somebody's Sent
 * folder. The material is generated from this system, so it should be one click from the screen
 * that sends it.
 *
 * The same PDF the staff member received, not a rendering of it: the version somebody was trained
 * on is the thing being produced, and a second implementation of it would eventually differ.
 */
export async function GET(req: Request, ctx: { params: Promise<{ type: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { type } = await ctx.params;
  if (!TRAINING_TYPES.includes(type as TrainingType)) return new NextResponse("Not a training", { status: 404 });

  const s = await getSettings();
  // The immunization protocol is written per person, so the material for it needs to know whose.
  const personId = new URL(req.url).searchParams.get("person") ?? "";
  const material = await trainingMaterial(type as TrainingType, {
    pharmacyName: s.pharmacy_name || "This pharmacy",
    personId,
  });

  if (!material) {
    return new NextResponse(
      "There is no written material for this one yet. The policy manual is empty, or this training is read from a document held elsewhere.",
      { status: 404 },
    );
  }

  return new NextResponse(new Uint8Array(material.pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(material.pdf.length),
      "Content-Disposition": `inline; filename="${material.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
