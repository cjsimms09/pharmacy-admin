"use client";

import { useRef, useState } from "react";

/** A real drop target: drag files onto it, or click to pick them. */
export function DropZone() {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [names, setNames] = useState<string[]>([]);

  const take = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    if (input.current) input.current.files = list;
    setNames(Array.from(list).map((f) => f.name));
  };

  return (
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
      className={`flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
        over ? "border-accent bg-accent-soft" : "border-line bg-ground hover:border-accent"
      }`}
    >
      <input
        ref={input}
        type="file"
        name="files"
        multiple
        className="hidden"
        accept=".pdf,.jpg,.jpeg,.png,.heic,.webp"
        onChange={(e) => setNames(Array.from(e.target.files ?? []).map((f) => f.name))}
      />
      {names.length === 0 ? (
        <>
          <p className="font-medium">Drop files here</p>
          <p className="text-sm text-ink-2">or click to choose. A licence, a CPR card, a training certificate, a signed CQI form — anything.</p>
        </>
      ) : (
        <>
          <p className="font-medium">{names.length} file{names.length === 1 ? "" : "s"} ready</p>
          <ul className="text-sm text-ink-2">
            {names.slice(0, 6).map((n) => <li key={n}>{n}</li>)}
            {names.length > 6 && <li>and {names.length - 6} more</li>}
          </ul>
          <p className="text-xs text-ink-3">Click to choose different files.</p>
        </>
      )}
    </div>
  );
}
