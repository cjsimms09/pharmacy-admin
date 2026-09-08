import { readAccess, isOpen, isReachable, timeLeft, clearAccess } from "@/lib/public-access";
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
  /*
   * Asked for is not the same as open, and the stripe must not say otherwise.
   *
   * A request whose tunnel has not started — or could not start — is not exposure. Colouring it red
   * and announcing the site is open to the internet trains somebody to read that stripe as noise,
   * and it is the one stripe in this site that cannot afford to be read as noise.
   */
  const live = isReachable(access);

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
    <div className={`no-print px-4 py-2 text-white ${live ? "bg-crit" : "bg-warn"}`}>
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-semibold uppercase tracking-wide">
          {live ? "Open to the internet" : access?.status === "failed" ? "Outside access could not start" : "Outside access is waiting"}
        </span>
        <span className="opacity-90">
          {live ? (
            <>
              Anyone with the address can reach this pharmacy&rsquo;s real records. Closes on its own in{" "}
              <b className="tabular-nums">{left}</b>
              {access?.reason ? ` — opened for: ${access.reason}` : ""}.
            </>
          ) : access?.status === "failed" ? (
            <>{access.problem} The site is private in the meantime.</>
          ) : (
            <>Close the app and start it again — the tunnel comes up when the site starts. Nothing is exposed until it does.</>
          )}
        </span>
        {live && access?.url ? <code className="rounded bg-white/15 px-1.5 py-0.5">{access.url}</code> : null}
        <form action={stop} className="ml-auto">
          <button className="rounded-full border border-white/40 px-3 py-0.5 font-medium hover:bg-white/15">
            {live ? "Close it now" : "Cancel it"}
          </button>
        </form>
      </div>
    </div>
  );
}
