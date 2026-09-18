"use client";

/** Opens the browser print dialog. Kept client-side so the print pages stay server-rendered. */
export function PrintButton() {
  return (
    <button type="button" className="btn btn-primary" onClick={() => window.print()}>
      Print
    </button>
  );
}
