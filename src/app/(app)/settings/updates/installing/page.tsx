export const metadata = { title: "Installing update" };
export const dynamic = "force-dynamic";

/** Shown while the launcher pulls, rebuilds and restarts. Polls until the app is back. */
export default function InstallingPage() {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <h1 className="text-xl font-bold">Installing the update…</h1>
      <p className="mt-2 text-sm text-ink-2">This usually takes one to three minutes. This page will reload on its own when the app is back. If it doesn't after five minutes, open the Pharmacy Admin window on the computer to see what happened.</p>
      <div className="mx-auto mt-6 h-1 w-48 overflow-hidden rounded bg-line"><div className="h-full w-1/3 animate-pulse bg-accent" /></div>
      <script
        dangerouslySetInnerHTML={{
          __html: `setTimeout(function poll(){fetch('/login',{cache:'no-store'}).then(function(r){if(r.ok){location.href='/settings/updates';}else{setTimeout(poll,4000);}}).catch(function(){setTimeout(poll,4000);});},15000);`,
        }}
      />
    </div>
  );
}
