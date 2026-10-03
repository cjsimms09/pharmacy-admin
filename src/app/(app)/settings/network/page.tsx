import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { lanAddresses } from "@/lib/network";
import { audit } from "@/lib/audit";
import { readAccess, writeAccess, clearAccess, isOpen, isReachable, timeLeft, expiryFor, MAX_HOURS } from "@/lib/public-access";
import { PageHeader, BackLink, Notice, Card } from "@/components/ui";

export const metadata = { title: "Use from another computer" };
export const dynamic = "force-dynamic";

export default async function NetworkPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const me = await requireManager();
  const addresses = lanAddresses();
  const best = addresses[0];
  const notice = await searchParams;
  const access = readAccess();
  const open = isOpen(access);
  const live = isReachable(access);

  /*
   * Opening the pharmacy to the internet, for a stated reason and a stated length of time.
   *
   * The reason is required rather than polite. A record that says only "opened at 14:12" answers
   * nothing six weeks later when somebody asks why the pharmacy's records were reachable from
   * outside that afternoon; one that says "so Claude can see the ordering screens" answers it
   * completely. It goes in the audit log and on the banner.
   */
  async function openUp(fd: FormData) {
    "use server";
    const u = await requireManager();
    const reason = String(fd.get("reason") ?? "").trim();
    const hours = Number(fd.get("hours")) || 1;
    if (reason.length < 4) {
      redirect("/settings/network?error=" + encodeURIComponent("Say what it is being opened for. It goes in the record."));
    }
    const record = { url: null, status: "requested" as const, problem: null, requestedAt: new Date().toISOString(), expiresAt: expiryFor(hours), requestedBy: u.name, reason };
    writeAccess(record);
    await audit({ action: "public_access.opened", userId: u.id, userName: u.name, details: `${reason} — until ${record.expiresAt}` });
    revalidatePath("/", "layout");
    redirect(
      "/settings/network?ok=" +
        encodeURIComponent(
          "Asked for. Close the app and start it again — the tunnel has to come up before the site does, or every button on every page would stop working. The address appears here once it is up.",
        ),
    );
  }

  async function closeDown() {
    "use server";
    const u = await requireManager();
    clearAccess();
    await audit({ action: "public_access.stopped", userId: u.id, userName: u.name });
    revalidatePath("/", "layout");
    redirect("/settings/network?ok=" + encodeURIComponent("Closing the tunnel. The site restarts on its own within a few seconds and comes back private."));
  }

  return (
    <>
      <BackLink href="/settings">Settings</BackLink>
      <PageHeader
        title="Use from another computer"
        subtitle="Any computer on the pharmacy's own network can open this app. Nothing is exposed to the internet — the address below only works inside the pharmacy."
      />

      {notice.ok ? <Notice kind="ok">{notice.ok}</Notice> : null}
      {notice.error ? <Notice kind="crit">{notice.error}</Notice> : null}

      <Card
        className="mb-6"
        tone={open ? "crit" : undefined}
        title="Reach it from outside the pharmacy"
        subtitle="A temporary address on the internet, for working with somebody who is not in the building."
      >
        {open ? (
          <>
            {!live ? (
              <Notice kind={access?.status === "failed" ? "crit" : "warn"}>
                {access?.status === "failed" ? (
                  <>
                    <b>The outside address could not be made, so nothing is exposed.</b> {access.problem}
                  </>
                ) : (
                  <>
                    <b>Asked for, but not started yet.</b> The tunnel comes up when the site starts, so close the app
                    and start it again. Until then nothing is reachable from outside and this page will keep saying so
                    rather than showing an address.
                  </>
                )}
              </Notice>
            ) : null}
            <p className="text-sm">
              <b>{live ? "The site is open to the internet right now." : "This is asked for but not running."}</b> It{" "}
              {live ? "closes" : "would close"} on its own in{" "}
              <b className="tabular-nums">{timeLeft(access)}</b> — on{" "}
              <b>{access ? new Date(access.expiresAt).toLocaleString() : ""}</b> — whether or not anybody remembers.
            </p>
            <dl className="mt-3 grid gap-1 text-xs text-ink-2 sm:grid-cols-[7rem_1fr]">
              <dt className="font-medium text-ink">Address</dt>
              <dd>
                {access?.url ? (
                  <code className="rounded bg-ground px-1.5 py-0.5 select-all">{access.url}</code>
                ) : (
                  <span className="text-ink-3">
                    {access?.status === "failed" ? "none — it could not be made" : "none yet — it appears here once the site has been restarted"}
                  </span>
                )}
              </dd>
              <dt className="font-medium text-ink">Opened for</dt>
              <dd>{access?.reason}</dd>
              <dt className="font-medium text-ink">Opened by</dt>
              <dd>{access?.requestedBy}</dd>
              <dt className="font-medium text-ink">While it is open</dt>
              <dd>
                The pharmacist-in-charge is emailed once a day that it is still open, again if the address changes,
                and straight away if somebody starts trying passwords against it.
              </dd>
            </dl>
            <form action={closeDown} className="mt-3">
              <button className="btn btn-danger">{live ? "Close it now" : "Cancel it"}</button>
            </form>
          </>
        ) : (
          <>
            <p className="text-sm text-ink-2">
              This puts the pharmacy&rsquo;s <b>real records</b> — every contract, every claim, the prescription
              numbers and the registration numbers — behind nothing but the login, reachable by anyone who has the
              address. That is sometimes the right trade and it is never the right one to forget about, so every run
              ends by itself on a date you pick, {MAX_HOURS / 24} days at the very most. While it is open every page
              in the site says so, and the pharmacist-in-charge is emailed once a day that it is still open, again if
              the address changes, and straight away if somebody starts guessing at the login.
            </p>
            <p className="mt-2 text-xs text-ink-3">
              Needs <code>cloudflared</code> on this computer. Nothing is installed for you: a program whose job is to
              open this machine to the internet is one somebody should have put there deliberately.
            </p>
            <form action={openUp} className="mt-3 flex flex-wrap items-end gap-3">
              <label className="grow">
                <span className="label">What is it being opened for?</span>
                <input name="reason" className="field" required minLength={4} placeholder="e.g. working through the ordering screens with Claude" />
              </label>
              <label>
                <span className="label">For how long?</span>
                <select name="hours" className="field" defaultValue="336">
                  <option value="2">2 hours</option>
                  <option value="8">8 hours</option>
                  <option value="24">1 day</option>
                  <option value="168">1 week</option>
                  <option value="336">2 weeks</option>
                  <option value="504">3 weeks — the most allowed</option>
                </select>
              </label>
              <button className="btn btn-danger">Open it</button>
            </form>
          </>
        )}
      </Card>

      {/*
        Put here, directly under the outside-access card, because this is the question that card
        gets opened to answer — and opening the pharmacy to the internet is the wrong answer to it.
      */}
      <Card
        className="mb-6"
        title="Working on this site with Claude"
        subtitle="On this computer, with the real database in front of it, and nothing exposed to anyone."
      >
        <p className="text-sm text-ink-2">
          Claude working on this site from a browser runs on Anthropic&rsquo;s machines, and those machines are only
          allowed to reach a short list of addresses — GitHub and a few software registries. Every other address on
          the internet is refused. So an outside address for this site, however it is made, can never be reached from
          there. That is not a setting anybody here can change.
        </p>
        <p className="mt-2 text-sm text-ink-2">
          The way round it is the better arrangement anyway: rather than opening the pharmacy to Claude, put Claude in
          the pharmacy. Running here it reads the real database directly, opens the real screens, runs the tests, and
          changes the code in place — with no address, no tunnel, and nothing for anybody to remember to close.
        </p>
        <p className="mt-3 rounded-md border border-line bg-ground px-3 py-2 text-sm">
          In the pharmacy-admin folder, double-click <b>Work on this with Claude.cmd</b>. The first time it installs
          Claude and asks you to sign in with the same account you use on claude.ai. After that it opens straight away.
        </p>
        <p className="mt-2 text-sm text-ink-2">
          <b>From the counter, or from home.</b> It starts with Remote Control on and shows a QR code — scan it with
          the Claude app on your phone and the same conversation carries on from anywhere. The work still happens on
          this computer against the real database; the phone is a keyboard, not a copy, and nothing about the pharmacy
          is published. That is the difference between this and an outside address, and it is the whole reason this is
          the better arrangement.
        </p>
      </Card>

      {!best ? (
        <Notice kind="crit">
          This computer doesn't appear to be on a network right now, so there's no address to share. Connect it to the pharmacy's Wi-Fi or network cable and reload this page.
        </Notice>
      ) : (
        <>
          <section className="card mb-6">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-2">Step 1 — the address</h2>
            <p className="mb-3 text-sm text-ink-2">On the other computer, open a browser and type this into the address bar exactly as shown:</p>
            <div className="rounded-md border-2 border-accent bg-accent-soft px-4 py-4 text-center">
              <div className="font-mono text-2xl font-bold text-accent">{best.url}</div>
            </div>
            <p className="mt-3 text-sm text-ink-2">
              Then sign in with a login from Settings → Logins. Bookmark the page on that computer so nobody has to type it again.
            </p>
            {addresses.length > 1 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-ink-3">If that address doesn't work, try one of these</summary>
                <ul className="mt-2 space-y-1 text-sm">
                  {addresses.slice(1).map((a) => (
                    <li key={a.address}>
                      <span className="font-mono">{a.url}</span> <span className="text-xs text-ink-3">({a.label})</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="card mb-6">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-2">Step 2 — let Windows allow it (once)</h2>
            <p className="mb-2 text-sm text-ink-2">
              Windows blocks other computers by default. You only have to do this one time, on <b>this</b> computer (the one running the app):
            </p>
            <ol className="ml-5 list-decimal space-y-1 text-sm text-ink-2">
              <li>Open the <b>pharmacy-admin</b> folder (This PC → C: → Users → your name → pharmacy-admin).</li>
              <li>Find the file named <b>Allow on network</b>.</li>
              <li><b>Right-click</b> it and choose <b>Run as administrator</b>. Click Yes if Windows asks.</li>
              <li>A black window opens, says “Done”, and waits — press any key to close it.</li>
            </ol>
            <p className="mt-2 text-sm text-ink-2">Now try the address from step 1 again on the other computer.</p>
          </section>

          <section className="card mb-6">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-2">Keep in mind</h2>
            <ul className="ml-5 list-disc space-y-1 text-sm text-ink-2">
              <li>This computer must be <b>on and running the app</b> for the other computer to reach it.</li>
              <li>The address can change if the network hands out a new one (after a router restart, for example). If it stops working, come back to this page for the current address, or ask whoever manages the network to reserve a fixed address for this computer.</li>
              <li>Anyone on the pharmacy network who has a login can reach it. Give each person their own login under Settings → Logins, and use the Staff role for anyone who only needs their own record.</li>
              <li>This is not a way to use the app from home. That comes later, with the secure remote access setup.</li>
            </ul>
          </section>

          <section className="card">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-2">If it still doesn't work</h2>
            <ul className="ml-5 list-disc space-y-1 text-sm text-ink-2">
              <li>Check both computers are on the same network (same Wi-Fi name, or both plugged into the pharmacy's network).</li>
              <li>Make sure the black “Pharmacy Admin” window is still open on this computer.</li>
              <li>Some guest Wi-Fi networks block computers from seeing each other. Use the main pharmacy network instead.</li>
            </ul>
          </section>
        </>
      )}
    </>
  );
}
