import Link from "next/link";

/**
 * "Send this page to Claude."
 *
 * Every arithmetic error this site has had was found by the pharmacist reading a figure and
 * knowing the real answer. The slow part was afterwards: working out from a screenshot *which*
 * figure, and what it was computed from. This ends that — the file carries what the page computed,
 * the inputs it ran on, and what the site had loaded at the time.
 *
 * Two buttons rather than one, and the second says what it does. A diagnosis is almost always
 * possible without real prescription numbers, so that is the default; when the question is about
 * one named prescription, the other is there and says plainly what it includes.
 */
export function ExportData({
  page,
  params,
  className,
}: {
  /** The key in diagnostic-sources.ts. */
  page: string;
  /** What the page is currently showing, so the export answers the same question as the screen. */
  params?: Record<string, string | number | null | undefined>;
  className?: string;
}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== null && v !== undefined && v !== "") qs.set(k, String(v));
  }
  const base = `/api/export/${page}`;
  const safe = qs.toString() ? `${base}?${qs}` : base;
  const withIds = `${base}?${new URLSearchParams({ ...Object.fromEntries(qs), identifiers: "include" })}`;

  return (
    <div className={`no-print ${className ?? ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={safe} prefetch={false} className="btn btn-sm" download>
          Download this page&rsquo;s data
        </Link>
        <details className="text-xs text-ink-3">
          <summary className="cursor-pointer">What is in it</summary>
          <div className="mt-1 max-w-prose leading-relaxed">
            <p>
              Everything this page computed, the dates and filters it ran on, and what the site had loaded at the time —
              row counts, whether the mailbox is on, which reports have arrived. Send it and the answer can be about the
              row rather than about what the row might have been.
            </p>
            <p className="mt-1">
              Prescription numbers are replaced with stand-ins. Rows belonging to one prescription still match each
              other inside the file, and the stand-ins mean nothing outside it. Patient names, dates of birth,
              addresses and member IDs are never stored by this site, so they cannot be in it.
            </p>
            <p className="mt-2">
              <Link href={withIds} prefetch={false} className="underline" download>
                Download it with the real prescription numbers
              </Link>{" "}
              — only when the question is about one prescription by name. Every download is recorded in the audit log
              either way.
            </p>
          </div>
        </details>
      </div>
    </div>
  );
}
