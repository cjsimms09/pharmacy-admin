"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { dropFiles } from "@/app/(app)/intake/actions";

/**
 * "Add" — the upload, on every page, in the same place.
 *
 * The owner: "I need an easy way to get to the upload tool from any page to correctly upload and
 * sort and categorise what I'm uploading." Uploading used to mean knowing which page a document
 * belonged to before you could file it — which is backwards, because the whole point of the reader
 * is that it works out what a document is. So the door is in the frame: drop anything here, from
 * wherever you are, and it lands on the review card where Claude has already said what it is, who
 * it is from and what the figures are, with every field editable before it is filed.
 *
 * A real drop target as well as a click, because an invoice arrives as a photograph on a phone or
 * a PDF dragged off an email, and both should be one gesture.
 */
export function AddAnything() {
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [over, setOver] = useState(false);
  const [names, setNames] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  const take = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    if (input.current) input.current.files = list;
    setNames(Array.from(list).map((f) => f.name));
  };

  return (
    <details className="no-print relative">
      <summary className="cursor-pointer list-none">
        <span className="btn btn-sm btn-primary">Add</span>
      </summary>
      <div className="absolute right-0 top-10 z-40 w-80 rounded-xl bg-surface p-4" style={{ boxShadow: "var(--shadow-lift)" }}>
        <h3 className="mb-1">Add anything</h3>
        <p className="mb-3 text-xs leading-relaxed text-ink-2">
          An invoice, a remittance, a rebate statement, a bill, a licence, a report. Claude reads it, says what it is and files it where the money goes. You check the card before anything is kept.
        </p>
        <form ref={form} action={dropFiles} encType="multipart/form-data" onSubmit={() => setSending(true)}>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              take(e.dataTransfer.files);
            }}
            onClick={() => input.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                input.current?.click();
              }
            }}
            role="button"
            tabIndex={0}
            className={`flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-4 text-center text-xs transition-colors ${
              over ? "border-accent bg-accent-soft" : "border-line bg-ground hover:border-accent"
            }`}
          >
            <input
              ref={input}
              type="file"
              name="files"
              multiple
              className="hidden"
              accept=".pdf,.jpg,.jpeg,.png,.heic,.webp,.835,.edi,.txt,.x12,.csv,.xlsx"
              onChange={(e) => setNames(Array.from(e.target.files ?? []).map((f) => f.name))}
            />
            {names.length === 0 ? (
              <>
                <span className="font-medium text-ink">Drop a file, or click to choose</span>
                <span className="text-ink-3">Photograph, PDF, 835, spreadsheet</span>
              </>
            ) : (
              <span className="font-medium text-ink">{names.length === 1 ? names[0] : `${names.length} files`}</span>
            )}
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <Link href="/intake" className="text-xs text-ink-3 underline hover:text-ink">
              Everything waiting
            </Link>
            <button className="btn btn-sm btn-primary" disabled={names.length === 0 || sending}>
              {sending ? "Reading…" : "Read it"}
            </button>
          </div>
        </form>
      </div>
    </details>
  );
}
