import { requireManager } from "@/lib/auth";
import { lanAddresses } from "@/lib/network";
import { PageHeader, BackLink, Notice } from "@/components/ui";

export const metadata = { title: "Use from another computer" };
export const dynamic = "force-dynamic";

export default async function NetworkPage() {
  await requireManager();
  const addresses = lanAddresses();
  const best = addresses[0];

  return (
    <>
      <BackLink href="/settings">Settings</BackLink>
      <PageHeader
        title="Use from another computer"
        subtitle="Any computer on the pharmacy's own network can open this app. Nothing is exposed to the internet — the address below only works inside the pharmacy."
      />

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
