"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

/**
 * "Send this page to Claude", on every page, in the same place.
 *
 * The export existed and reached eleven pages of a hundred and one, because it was added a page at
 * a time. The ninety it missed are the ones where something looked wrong and there was no way to
 * send it — which is backwards: a page nobody thought to instrument is a page nobody has checked.
 *
 * So it lives in the frame, at the foot of the sidebar, where it never moves and never has to be
 * looked for. It takes the page's own path and query string with it, so the file answers the same
 * question the screen was answering — the month being viewed, the filter that was set.
 *
 * Two links rather than one, and the second says exactly what it does. A diagnosis is almost
 * always possible without real prescription numbers, so that is the default.
 */
function Buttons() {
  const path = usePathname();
  const search = useSearchParams();

  const qs = new URLSearchParams(search?.toString() ?? "");
  qs.set("path", path ?? "/");
  const safe = `/api/export/for?${qs.toString()}`;
  const withIds = `/api/export/for?${new URLSearchParams({ ...Object.fromEntries(qs), identifiers: "include" }).toString()}`;

  /*
   * Clicking a download inside a <details> does not close it, so the panel stayed open over the
   * page after the file had been taken — "once i hit send this to claude button, that box never
   * goes away". A link that has done its job closes the thing it was in.
   */
  const close = (e: React.MouseEvent<HTMLElement>) => {
    e.currentTarget.closest("details")?.removeAttribute("open");
  };

  return (
    <details className="no-print relative">
      <summary className="cursor-pointer list-none">
        <span className="btn btn-sm">Send to Claude</span>
      </summary>
      <div className="absolute right-0 top-10 z-40 w-72 space-y-2 rounded-xl bg-surface p-4 text-xs leading-relaxed text-ink-3" style={{ boxShadow: "var(--shadow-lift)" }}>
        <a href={safe} download onClick={close} className="btn btn-sm btn-primary w-full justify-center">
          Download this page&rsquo;s file
        </a>
        <p>
          Everything this page computed, what it was filtered to, and what the site had loaded at the time. Send it in
          the chat and the answer can be about the actual row.
        </p>
        <p>
          Prescription numbers are replaced with stand-ins that mean nothing outside the file. Patient names, dates of
          birth and addresses are never stored by this site, so they cannot be in it.
        </p>
        <a href={withIds} download onClick={close} className="underline hover:text-ink">
          With the real prescription numbers
        </a>
        <p>Only when the question is about one prescription by name. Every download is recorded either way.</p>
      </div>
    </details>
  );
}

export function SendToClaude() {
  /*
   * useSearchParams needs a boundary, or every page that renders this frame is forced out of
   * static rendering at build time. The fallback is the closed button, which is what it looks like
   * anyway until somebody opens it.
   */
  return (
    <Suspense fallback={<div className="no-print mt-2 h-7" />}>
      <Buttons />
    </Suspense>
  );
}
