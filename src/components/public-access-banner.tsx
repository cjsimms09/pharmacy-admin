import { readAccess, isOpen, timeLeft, clearAccess } from "@/lib/public-access";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

/**
 * The stripe across the top that says the whole world can see this.
 *
 * A site that looks identical whether or not it is reachable from the internet is a site somebody
 * will type a password into, open a patient's record on, or leave running over a weekend without
 * once thinking about it. The exposure is deliberate and brief and that is fine; what is not fine
 * is it being invisible.
 *
 * So it is loud, it is on every page, it carries the time remaining rather than a vague
 * reassurance, and stopping it is one press from wherever you happen to be standing — because the
 * moment you want it off is never the moment you want to go and find the setting.
 */
export async function PublicAccessBanner() {
  const access = readAccess();
  if (!isOpen(access)) return null;
  const left = timeLeft(access);

  async function stop() {
    "use server";
    const u = await requireManager();
    clearAccess();
    await audit({ action: "public_access.stopped", userId: u.id, userName: u.name, details: access?.url ?? "" });
    revalidatePath("/", "layout");
    /*
     * The record is what the launcher watches, so deleting it is what actually closes the door —
     * within fifteen seconds, when the site goes down and comes back up private. Said plainly here
     * rather than left to be discovered, because a stop button whose effect is invisible for a
     * quarter of a minute gets pressed four times.
     */
    redirect("/settings/network?ok=" + encodeURIComponent("Closing the tunnel. The site will restart on its own in a few seconds and come back private."));
  }

  return (
    <div className="no-print bg-crit px-4 py-2 text-white">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-semibold uppercase tracking-wide">Open to the internet</span>
        <span className="opacity-90">
          Anyone with the address can reach this pharmacy&rsquo;s real records. Closes on its own in{" "}
          <b className="tabular-nums">{left}</b>
          {access?.reason ? ` — opened for: ${access.reason}` : ""}.
        </span>
        {access?.url ? <code className="rounded bg-white/15 px-1.5 py-0.5">{access.url}</code> : null}
        <form action={stop} className="ml-auto">
          <button className="rounded-full border border-white/40 px-3 py-0.5 font-medium hover:bg-white/15">Close it now</button>
        </form>
      </div>
    </div>
  );
}
