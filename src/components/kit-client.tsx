"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The three pieces of the design system that need a click to exist: a drawer for forms that
 * used to sit in the page flow, a row menu for the edit and delete every list row is owed, and
 * a help panel for the explanation that used to be paragraphs above the figures.
 *
 * Client components only for the open/closed state. Everything inside them is rendered on the
 * server and passed as children, so a form in a drawer still posts to its server action and a
 * link in a row menu is still a link.
 */

function useEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);
}

/**
 * A form behind a button.
 *
 * "Add a supplier" was the tallest thing on the suppliers page; "Load a price file" sat between
 * the figures and the list on Purchasing. A drawer keeps the form one click away and the page
 * about its list.
 */
export function Drawer({ label, title, children, primary = false, className }: { label: ReactNode; title: string; children: ReactNode; primary?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  useEscape(open, () => setOpen(false));
  return (
    <>
      <button type="button" className={`btn ${primary ? "btn-primary" : ""} ${className ?? ""}`} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
        {label}
      </button>
      {open && (
        <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={title}>
          <div className="absolute inset-0 bg-ink/30" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 right-0 flex w-full max-w-lg flex-col border-l border-line bg-surface shadow-[var(--shadow-lift)]">
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <h2 className="text-base font-semibold">{title}</h2>
              <button type="button" className="btn btn-sm" onClick={() => setOpen(false)} aria-label="Close">
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The actions a row is owed, in the same place on every row.
 *
 * A trailing "…" that opens edit, delete-or-retire, open. The children are the actions as the
 * page renders them — a link, a form with a server action, a confirm button — so this decides
 * nothing about what they do.
 */
export function RowMenu({ children, label = "Actions" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEscape(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);
  return (
    <div className="relative inline-block" ref={ref}>
      <button type="button" className="btn btn-sm px-2" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={label}>
        …
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 min-w-40 rounded-md border border-line bg-surface p-1 shadow-[var(--shadow-lift)] [&_a]:block [&_a]:rounded [&_a]:px-2.5 [&_a]:py-1.5 [&_a]:text-sm [&_a:hover]:bg-ground [&_button]:block [&_button]:w-full [&_button]:rounded [&_button]:px-2.5 [&_button]:py-1.5 [&_button]:text-left [&_button]:text-sm [&_button:hover]:bg-ground">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * The explanation, one click away.
 *
 * The site's pages are right to explain themselves and wrong to do it above the figures. The
 * prose goes here, behind a "?" in the header, and one line stays on the page.
 */
export function HelpPanel({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEscape(open, () => setOpen(false));
  return (
    <>
      <button type="button" className="btn btn-sm rounded-full px-2.5 font-semibold" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} aria-label={`How ${title} works`} title="How this page works">
        ?
      </button>
      {open && (
        <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={`How ${title} works`}>
          <div className="absolute inset-0 bg-ink/30" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-line bg-surface shadow-[var(--shadow-lift)]">
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <h2 className="text-base font-semibold">How this works</h2>
              <button type="button" className="btn btn-sm" onClick={() => setOpen(false)} aria-label="Close">
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm leading-relaxed text-ink-2">{children}</div>
          </div>
        </div>
      )}
    </>
  );
}
