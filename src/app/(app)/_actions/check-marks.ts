"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { markShown } from "@/lib/daily-check-store";
import { putBack } from "@/lib/check-marks";

/**
 * Pressing "This is wrong" or "This is settled" on a line of the morning check, and taking a press back.
 *
 * Each form says where it was submitted from and lands back there, as the compliance actions do. The press is judged against the check as
 * it stands when the form arrives and not as it stood when the page was drawn: if what the line found has changed since he looked,
 * nothing is recorded, because a mark must cover the finding he saw and no other.
 */

const backTo = (fd: FormData) => {
  const raw = String(fd.get("back") ?? "/");
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
};

export async function markCheckAction(fd: FormData) {
  const u = await requireManager();
  const back = backTo(fd);
  const key = String(fd.get("key") ?? "");
  const shown = String(fd.get("fingerprint") ?? "");
  const verdict = String(fd.get("verdict") ?? "");
  try {
    const { already } = await markShown(key, shown, verdict, String(fd.get("note") ?? ""), u);
    revalidatePath("/");
    redirect(
      `${back}?ok=` +
        encodeURIComponent(
          already
            ? "That was already recorded, so nothing was added."
            : verdict === "wrong"
              ? "Recorded as wrong. The line is set aside until the things it found change, and the press is kept as a report of a wrong alarm until somebody has answered it."
              : "Recorded as settled. The line is set aside until the things it found change.",
        ),
    );
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    redirect(`${back}?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not record that."));
  }
}

export async function putBackAction(fd: FormData) {
  const u = await requireManager();
  const back = backTo(fd);
  const id = String(fd.get("id") ?? "");
  try {
    if (!(await putBack(id, u))) throw new Error("That one had already ended, so nothing was changed.");
    revalidatePath("/");
    redirect(`${back}?ok=` + encodeURIComponent("Put back. If the check still fails, its line shows again."));
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    redirect(`${back}?error=` + encodeURIComponent(e instanceof Error ? e.message : "Could not put that back."));
  }
}
