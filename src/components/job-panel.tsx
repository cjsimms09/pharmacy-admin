"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * A running job, shown while it runs.
 *
 * The work happens on the server, behind the request that started it, so the page has no way of
 * knowing it has moved on unless it asks. This asks — every four seconds, and only while
 * something is actually running, so an idle manual page makes no requests at all.
 *
 * It is deliberately more than a spinner. A spinner says "wait"; this says which section is being
 * read right now and how many are left, which is the difference between a person deciding to go
 * and do something else and a person deciding the button is broken. The elapsed clock is there
 * for the same reason: work that takes four minutes needs to look like work that is taking four
 * minutes, not like nothing.
 */
export function JobPanel({
  step,
  done,
  total,
  startedAt,
  by,
}: {
  step: string;
  done: number;
  total: number;
  startedAt: string;
  by: string;
}) {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(() => Math.max(0, Date.now() - Date.parse(startedAt)));

  useEffect(() => {
    const tick = setInterval(() => setElapsed(Math.max(0, Date.now() - Date.parse(startedAt))), 1000);
    // Refreshing the server component is what brings the new step across; the clock above only
    // keeps the seconds honest in between.
    const poll = setInterval(() => router.refresh(), 4000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [router, startedAt]);

  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;

  return (
    <div className="mb-6 rounded-lg border border-accent bg-accent-soft px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-accent">
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
          Claude is working through the manual
        </span>
        <span className="font-mono text-xs text-accent">
          {mins}:{String(secs).padStart(2, "0")} elapsed
        </span>
      </div>

      <p className="mt-1.5 text-sm text-ink">{step}</p>

      {pct !== null && (
        <>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ground">
            <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-xs text-ink-3">
            {done} of {total} done
          </p>
        </>
      )}

      <p className="mt-2 text-xs text-ink-3">
        Started by {by}. You can leave this page or carry on using the site — it keeps going, and everything it
        finishes is saved as it goes. This panel updates itself.
      </p>
    </div>
  );
}
