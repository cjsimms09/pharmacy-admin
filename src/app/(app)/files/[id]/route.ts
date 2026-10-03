import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { readFile } from "@/lib/files";
import { audit } from "@/lib/audit";

/** Authenticated download of a stored document. Staff may only open documents attached to their own record. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, id) });
  if (!doc) return new NextResponse("Not found", { status: 404 });
  if (user.role === "staff" && doc.personId !== user.personId) return new NextResponse("Forbidden", { status: 403 });
  const buf = await readFile(doc.storageKey);
  await audit({ action: "document.view", userId: user.id, userName: user.name, entity: "document", entityId: doc.id, details: doc.title });
  const safeName = doc.fileName.replace(/[^\w.\-() ]+/g, "_");
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": doc.mimeType,
      "Content-Length": String(buf.length),
      "Content-Disposition": `inline; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
