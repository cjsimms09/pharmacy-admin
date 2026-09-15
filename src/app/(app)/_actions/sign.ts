"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { signRecord, revokeSignature, SIGNABLE } from "@/lib/record-signatures";

/**
 * Signing any record the pharmacy produces, from one place.
 *
 * One action rather than one per page, because the parts that make an electronic signature stand
 * up — the intent, the identity, the exact wording, the time and address — are easy to leave out
 * one page at a time and impossible to leave out of a single implementation.
 */

const backTo = (fd: FormData) => {
  const raw = String(fd.get("back") ?? "/");
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
};

export async function signRecordAction(fd: FormData) {
  const u = await requireManager();
  const back = backTo(fd);
  const kind = String(fd.get("kind") ?? "");
  const recordKey = String(fd.get("recordKey") ?? "");
  try {
    const sig = await signRecord(
      {
        kind,
        recordKey,
        typedName: String(fd.get("typedName") ?? ""),
        intent: String(fd.get("intent") ?? "") === "yes",
        content: fd.get("content") === null ? undefined : String(fd.get("content")),
      },
      u,
    );
    await audit({
      action: "record.sign",
      userId: u.id,
      userName: u.name,
      entity: kind,
      entityId: recordKey,
      details: `signed as ${sig.signedName}`,
    });
    revalidatePath(back);
    redirect(
      `${back}${back.includes("?") ? "&" : "?"}ok=` +
        encodeURIComponent(
          `Signed. ${SIGNABLE[kind]?.label ?? "The record"} now carries your name, the statement you agreed to, and the time — and prints with all three.`,
        ),
    );
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    redirect(
      `${back}${back.includes("?") ? "&" : "?"}error=` +
        encodeURIComponent(e instanceof Error ? e.message : "That could not be signed."),
    );
  }
}

export async function revokeSignatureAction(fd: FormData) {
  const u = await requireManager();
  const back = backTo(fd);
  try {
    await revokeSignature(String(fd.get("id") ?? ""), String(fd.get("reason") ?? ""), u);
    await audit({ action: "record.sign.revoke", userId: u.id, userName: u.name, entityId: String(fd.get("id") ?? "") });
    revalidatePath(back);
    redirect(
      `${back}${back.includes("?") ? "&" : "?"}ok=` +
        encodeURIComponent("Withdrawn, with your reason on it. The original signature is kept — a record that can be silently unsigned is not a record."),
    );
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    redirect(`${back}${back.includes("?") ? "&" : "?"}error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not withdraw that."));
  }
}
