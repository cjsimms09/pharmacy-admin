"use client";

/**
 * Bulk selection for the training grid.
 *
 * The grid used to arrive with everything due already ticked, which is fine when you want to send
 * everything and infuriating the rest of the time: unticking twenty-eight boxes to send two is
 * worse than ticking two. So nothing is ticked to begin with and the bulk moves are buttons.
 *
 * It works on the DOM rather than on React state on purpose. The table is server-rendered from
 * the same data that decides what is due, and lifting all of it into a client component to track
 * thirty booleans would mean two descriptions of who owes what — which is exactly how a screen
 * starts disagreeing with itself.
 */
export function PickControls({ dueCount }: { dueCount: number }) {
  const boxes = (filter?: (el: HTMLInputElement) => boolean): HTMLInputElement[] => {
    const all = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-pick]"));
    return filter ? all.filter(filter) : all;
  };
  const set = (els: HTMLInputElement[], on: boolean) => {
    for (const el of els) el.checked = on;
    // Nudge the count in the button label without re-rendering the table.
    document.dispatchEvent(new CustomEvent("picks-changed"));
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-sm" onClick={() => set(boxes((el) => el.dataset.due === "1"), true)}>
        Tick everything due ({dueCount})
      </button>
      <button type="button" className="btn btn-sm" onClick={() => set(boxes(), false)}>
        Clear all
      </button>
    </div>
  );
}

/** Ticks or clears one person's whole row, or one training's whole column. */
export function PickGroup({ match, label }: { match: { person?: string; type?: string }; label: string }) {
  const toggle = () => {
    const els = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-pick]")).filter(
      (el) => (!match.person || el.dataset.person === match.person) && (!match.type || el.dataset.type === match.type),
    );
    // If any are unticked, tick them all; otherwise clear them. One control, both directions,
    // which is what people expect from a header checkbox.
    const anyOff = els.some((el) => !el.checked);
    for (const el of els) el.checked = anyOff;
  };
  return (
    <button type="button" onClick={toggle} className="text-[10px] font-normal text-accent hover:underline" title={label}>
      {label}
    </button>
  );
}
