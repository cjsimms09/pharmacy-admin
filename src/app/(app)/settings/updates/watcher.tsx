"use client";

import { useEffect, useState } from "react";

/**
 * Waits for the app to come back after an update.
 *
 * This must be a client component: the Install button redirects with a client-side navigation, so a
 * <script> tag in the server-rendered page would be inserted by React and never execute — which is
 * exactly how this page used to sit on "Installing…" forever after a perfectly good update.
 */
export function InstallingWatcher() {
  const [seconds, setSeconds] = useState(0);
  const [back, setBack] = useState(false);

  useEffect(() => {
    const tick = setInterval(() => setSeconds((s) => s + 1), 1000);
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const r = await fetch("/login", { cache: "no-store" });
        if (r.ok) {
          setBack(true);
          stopped = true;
          setTimeout(() => (window.location.href = "/settings/updates"), 1200);
          return;
        }
      } catch {
        /* the server is down mid-rebuild — that is expected */
      }
      setTimeout(poll, 3000);
    };
    const start = setTimeout(poll, 8000);
    return () => {
      stopped = true;
      clearInterval(tick);
      clearTimeout(start);
    };
  }, []);

  const slow = seconds > 240;
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <h1 className="text-xl font-bold">{back ? "Update installed" : "Installing the update…"}</h1>
      <p className="mt-2 text-sm text-ink-2">
        {back
          ? "The app is back. Taking you to Updates…"
          : "This usually takes one to three minutes while the app rebuilds itself. Leave this page open — it returns on its own as soon as the app is back."}
      </p>
      {!back && <p className="mt-1 text-xs text-ink-3">{seconds < 60 ? `${seconds} seconds` : `${Math.floor(seconds / 60)} min ${seconds % 60} sec`} elapsed</p>}
      <div className="mx-auto mt-6 h-1 w-48 overflow-hidden rounded bg-line">
        <div className={`h-full bg-accent ${back ? "w-full" : "w-1/3 animate-pulse"}`} />
      </div>
      <p className="mt-6 text-xs text-ink-3">
        <a href="/" className="text-accent underline">Open the app now</a> — safe to click at any time. If the app is back, this works immediately.
      </p>
      {slow && !back && (
        <div className="mt-6 rounded-lg border border-warn bg-warn-soft p-3 text-left text-xs">
          <p className="font-semibold">Taking longer than usual.</p>
          <p className="mt-1">On the pharmacy computer, look at the black <b>Pharmacy Admin</b> window. If any text in it is highlighted, press <b>Esc</b> — a stray click in that window pauses the update until you do.</p>
          <p className="mt-1">If that isn't it, close the window and double-click <b>Start Pharmacy Admin</b> again. Nothing is lost — your data is never touched by an update.</p>
        </div>
      )}
    </div>
  );
}
