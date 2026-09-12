"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { attest, answerObligation } from "@/lib/compliance-status";
import { periodLabel } from "@/lib/periods";
import { assignTraining, sendOutstanding } from "@/lib/training-assignments";
import { requestCredential } from "@/lib/credential-requests";
import type { TrainingType, CredentialType } from "@/db/schema";

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
    await attest(id, periodKey, statement, u, {
      typedName: String(fd.get("typedName") ?? ""),
      intent: String(fd.get("intent") ?? "") === "yes",
    });
    await audit({ action: "compliance.attest", userId: u.id, userName: u.name, details: `${id} ${periodKey} signed` });
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

/**
 * Sends, or re-sends, one person's training from wherever they are being looked at.
 *
 * The point of this living here rather than only on the training screen is that the grid which
 * shows the gap should be the thing that closes it. Being sent to another page to act on
 * something already on screen is the friction that turns a thirty-second job into one that waits
 * a fortnight — which is why the same gaps kept reappearing week after week.
 *
 * Re-sending is deliberately the same call. It reuses the assignment that already exists, so the
 * person's link and reply code do not change, nothing they have already done is reset, and a
 * follow-up is genuinely a follow-up rather than a second thing to do.
 */
export async function sendTrainingAction(fd: FormData) {
  const u = await requireManager();
  const back = backTo(fd);
  const personId = String(fd.get("personId") ?? "");
  const type = String(fd.get("trainingType") ?? "") as TrainingType;
  const followUp = String(fd.get("followUp") ?? "") === "1";
  try {
    if (followUp) {
      const r = await sendOutstanding([personId]);
      await audit({ action: "training.followup", userId: u.id, userName: u.name, details: `${personId} ${type}` });
      revalidatePath("/");
      revalidatePath("/compliance/training");
      redirect(
        `${back}?${r.problems.length ? "error" : "ok"}=` +
          encodeURIComponent(
            r.emailed > 0
              ? `Follow-up accepted for delivery to ${r.delivered.join(", ")} — one email covering everything they still owe. If it does not arrive, any bounce that comes back is read automatically and will appear against them. ${r.problems.join(" ")}`.trim()
              : r.problems.join(" ") || "Nothing outstanding to follow up on.",
          ),
      );
    }
    const r = await assignTraining([personId], type, {}, u);
    await audit({ action: "training.assign", userId: u.id, userName: u.name, details: `${type} to ${personId}` });
    revalidatePath("/");
    revalidatePath("/compliance/training");
    revalidatePath(`/staff/${personId}`);
    redirect(
      `${back}?${r.problems.length ? "error" : "ok"}=` +
        encodeURIComponent(
          r.emailed > 0
            ? `Accepted for delivery to ${r.delivered.join(", ")} — one email covering everything they owe, with the course attached. That is the mail server taking it, not the person receiving it; if it bounces, the report is read automatically and will appear against them. ${r.problems.join(" ")}`.trim()
            : r.problems.join(" ") || "Assigned, but nothing could be emailed.",
        ),
    );
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    redirect(`${back}?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not send that."));
  }
}

/**
 * Asks somebody for the certificate the pharmacy does not have.
 *
 * Lives here for the same reason sending training does: the gap is seen on the staff board and on
 * the person's own page, and both should be able to close it. Emailing someone, waiting, then
 * remembering to file whatever came back against the right person and the right requirement is
 * four steps, and every one of them is a place it stopped happening — which is why the same gaps
 * sat open for months.
 *
 * The reply files itself. What comes back is matched on a code and on the sender's own address,
 * both or neither, and the credential is created with the dates deliberately left blank: an
 * attachment proves the certificate exists and says nothing about when it expires, and an invented
 * expiry date passes every check while telling you nothing.
 */
export async function requestCredentialAction(fd: FormData) {
  const u = await requireManager();
  const back = backTo(fd);
  const personId = String(fd.get("personId") ?? "");
  const type = String(fd.get("credentialType") ?? "") as CredentialType;
  try {
    const r = await requestCredential(personId, type, u);
    await audit({ action: "credential.request", userId: u.id, userName: u.name, entity: "person", entityId: personId, details: type });
    revalidatePath("/");
    revalidatePath(`/staff/${personId}`);
    revalidatePath("/staff");
    redirect(`${back}?${r.ok ? "ok" : "error"}=` + encodeURIComponent(r.message));
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    redirect(`${back}?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not send that."));
  }
}
