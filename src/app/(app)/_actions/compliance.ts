"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { attest, answerObligation } from "@/lib/compliance-status";
import { periodLabel } from "@/lib/periods";

/**
 * The two compliance actions, in one place.
 *
 * Both the dashboard and the compliance screen offer them, because a thirty-second duty should
 * close from wherever the PIC happens to be looking. Each form says where it was submitted from
 * and lands back there — being bounced to another screen to confirm one sentence is exactly the
 * friction that leaves duties open for a fortnight.
 */

const backTo = (fd: FormData) => {
  const raw = String(fd.get("back") ?? "/");
  // Only ever a path inside this site. A redirect target taken from a form is otherwise an open
  // redirect, and there is no reason for one here.
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
};

export async function attestAction(fd: FormData) {
  const u = await requireManager();
  const back = backTo(fd);
  const id = String(fd.get("obligationId") ?? "");
  const periodKey = String(fd.get("periodKey") ?? "");
  const statement = String(fd.get("statement") ?? "");
  try {
    await attest(id, periodKey, statement, u);
    await audit({ action: "compliance.attest", userId: u.id, userName: u.name, details: `${id} ${periodKey}` });
    revalidatePath("/");
    revalidatePath("/compliance");
    revalidatePath("/compliance/register");
    redirect(`${back}?ok=` + encodeURIComponent(`Recorded for ${periodLabel(periodKey)}.`));
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    redirect(`${back}?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not record that."));
  }
}

export async function answerAction(fd: FormData) {
  const u = await requireManager();
  const back = backTo(fd);
  const id = String(fd.get("obligationId") ?? "");
  const applies = String(fd.get("applies") ?? "") === "yes";
  try {
    const r = await answerObligation(id, applies, u);
    await audit({
      action: applies ? "compliance.applies" : "compliance.not_applicable",
      userId: u.id,
      userName: u.name,
      details: id,
    });
    revalidatePath("/");
    revalidatePath("/compliance");
    revalidatePath("/compliance/register");
    redirect(
      `${back}?ok=` +
        encodeURIComponent(
          applies
            ? `"${r.title}" is now tracked, counting from today rather than from before you said so.`
            : `"${r.title}" is switched off, with today's date and your name on the decision.`,
        ),
    );
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    redirect(`${back}?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not record that."));
  }
}
