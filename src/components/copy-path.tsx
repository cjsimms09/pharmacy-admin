"use client";

import { useState } from "react";

/**
 * The file's own location, in one press.
 *
 * The download is the convenient way to get a copy out of the site and it is not the reliable one:
 * ten megabytes of zip through a browser on a pharmacy computer meets antivirus, SmartScreen and a
 * connection this site serializes, and when any of those wins the browser says only "couldn't
 * download". The file is already on the disk in a folder that syncs to OneDrive, so the surest
 * route is to open that folder and attach it — which needs the path, exactly, without typing it.
 */
export function CopyPath({ path }: { path: string }) {
  const [said, setSaid] = useState("");
  return (
    <span className="inline-flex flex-wrap items-baseline gap-2">
      <code className="select-all break-all rounded bg-ground px-1 py-0.5 text-[11px]">{path}</code>
      <button
        type="button"
        className="btn btn-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(path);
            setSaid("Copied — paste it into the address bar of a File Explorer window.");
          } catch {
            // Clipboard access is refused on some machines; the path is selectable either way.
            setSaid("Select the path above and copy it with Ctrl+C.");
          }
          setTimeout(() => setSaid(""), 6000);
        }}
      >
        Copy the path
      </button>
      {said ? <span className="text-[11px] text-ink-3">{said}</span> : null}
    </span>
  );
}
