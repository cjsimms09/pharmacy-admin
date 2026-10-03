/**
 * The NADAC benchmark, proved against the CMS files it was loaded from — and the prune that keeps
 * the table honest about its own size.
 *
 * Two settings, two rows, and they answer different questions about the same table.
 *
 * `nadac_proof` is written by `scripts/prove-nadac.ts`, which re-reads every CMS file in the NADAC
 * folder a line at a time and sets each row against the table by NDC and effective date. NADAC is
 * what every over- and under-payment figure on this site is measured against and what the Kansas
 * floor is calculated from, so a price the table holds that no file contained, or one a file
 * contained that the table lost, is wrong money on a screen with nothing to say so.
 *
 * `nadac_last_prune` is written by `scripts/prune-nadac.ts`. It exists because on 8 September 2026
 * the proof found 770,000 prices past the cutoff still held: the prune had one caller, inside the
 * loader, reached only when a new file had just been loaded, and its failure was swallowed. A prune
 * that never ran and a prune that failed every time looked identical, and the table grew either way.
 * It is a job now, and this row is how anybody would know it had stopped again.
 *
 * Pure.
 */

export type NadacProofFile = {
  file: string;
  bytes: number;
  sha256: string | null;
  manifestSha256: string | null;
  changedSinceLoad: boolean;
  loadedAt: string | null;
  rowsRead: number;
  rowsUnreadable: number;
  unreadableReasons: Record<string, number>;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  proved: number;
  prunedAway: number;
  missing: number;
  problems: string[];
};

export type NadacProof = {
  provedOn: string | null;
  cutoff: string | null;
  keepMonths: number;
  files: NadacProofFile[];
  rowsInFiles: number;
  provedRows: number;
  /** Distinct prices the files accounted for. The figure the fraction is built on. */
  provedKeys: number;
  prunedRows: number;
  missingRows: number;
  missingKeys: number;
  missingKeysCapped: boolean;
  tableRows: number;
  tableNdcs: number;
  tableRowsNoFileAccountsFor: number;
  /** What the pruner should have deleted and has not. Zero once the nightly job is keeping up. */
  prunableStillHeld: number;
  prunableStillHeldNdcs: number;
  lines: string[];
};

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const counts = (v: unknown): Record<string, number> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, n]) => typeof n === "number")) as Record<string, number>)
    : {};

/** Reads the setting, or null where the proof has never run or cannot be read. */
export function parseNadacProof(raw: string | undefined | null): NadacProof | null {
  if (!raw) return null;
  let j: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    j = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const files = Array.isArray(j.files)
    ? (j.files as Record<string, unknown>[]).filter((f) => f && typeof f === "object").map(
        (f): NadacProofFile => ({
          file: str(f.file) ?? "an unnamed file",
          bytes: num(f.bytes),
          sha256: str(f.sha256),
          manifestSha256: str(f.manifestSha256),
          changedSinceLoad: f.changedSinceLoad === true,
          loadedAt: str(f.loadedAt),
          rowsRead: num(f.rowsRead),
          rowsUnreadable: num(f.rowsUnreadable),
          unreadableReasons: counts(f.unreadableReasons),
          effectiveFrom: str(f.effectiveFrom),
          effectiveTo: str(f.effectiveTo),
          proved: num(f.proved),
          prunedAway: num(f.prunedAway),
          missing: num(f.missing),
          problems: strs(f.problems),
        }),
      )
    : [];
  return {
    provedOn: str(j.provedOn),
    cutoff: str(j.cutoff),
    keepMonths: num(j.keepMonths),
    files,
    rowsInFiles: num(j.rowsInFiles),
    provedRows: num(j.provedRows),
    provedKeys: num(j.provedKeys),
    prunedRows: num(j.prunedRows),
    missingRows: num(j.missingRows),
    missingKeys: num(j.missingKeys),
    missingKeysCapped: j.missingKeysCapped === true,
    tableRows: num(j.tableRows),
    tableNdcs: num(j.tableNdcs),
    tableRowsNoFileAccountsFor: num(j.tableRowsNoFileAccountsFor),
    prunableStillHeld: num(j.prunableStillHeld),
    prunableStillHeldNdcs: num(j.prunableStillHeldNdcs),
    lines: strs(j.lines),
  };
}

/**
 * The fraction: distinct prices accounted for, out of every price that has to be accounted for.
 *
 * Both directions, as the claims proof does, because either alone is blind on one side. A price in
 * the table that no file explains does not appear in the files at all; a price in a file that the
 * table lost does not appear in the table. So the denominator is the union — the prices held, plus
 * the distinct prices the files carry that the table has not got — and the numerator is what the
 * files struck off.
 *
 * Rows are deliberately not used. The weekly snapshots republish the same NDC and effective date
 * about seven times, so a fraction built on rows would read five and three-quarter million over
 * five and three-quarter million and mean almost nothing.
 */
export function nadacProofFraction(p: NadacProof): { numerator: number; denominator: number } {
  const denominator = p.tableRows + p.missingKeys;
  return { numerator: Math.min(p.provedKeys, denominator), denominator };
}

export function nadacProofGaps(p: NadacProof): string[] {
  const n = (x: number) => x.toLocaleString("en-US");
  const gaps: string[] = [];

  /*
   * A file that is not the file that was loaded comes first, because it is the only fault here
   * where every count is correct and the thing they are correct about no longer exists.
   */
  for (const f of p.files.filter((x) => x.changedSinceLoad)) {
    gaps.push(
      `${f.file} on disk is not the file that was loaded${f.loadedAt ? ` on ${f.loadedAt.slice(0, 10)}` : ""} — it has been replaced or edited since. The table holds what the old file said. Load it again from the feeds page; the proof reports this and never loads anything itself.`,
    );
  }
  for (const f of p.files) {
    for (const w of f.problems) gaps.push(`${f.file}: ${w}.`);
  }

  if (p.missingKeys > 0) {
    gaps.push(
      `${n(p.missingKeys)} price${p.missingKeys === 1 ? "" : "s"}${p.missingKeysCapped ? " or more" : ""} in the CMS files reached no row in the table, and are not explained by pruning.`,
    );
  }
  if (p.tableRowsNoFileAccountsFor > 0) {
    gaps.push(
      `${n(p.tableRowsNoFileAccountsFor)} price${p.tableRowsNoFileAccountsFor === 1 ? "" : "s"} in the table are accounted for by no file now in the NADAC folder. Expected where a loaded file has since been deleted; it is the only sign there would be of a price with no source.`,
    );
  }

  /*
   * The pruner not keeping up, which is a fault in a different thing that this row is uniquely
   * placed to see. Zero is the ordinary state now that the prune runs nightly.
   */
  if (p.prunableStillHeld > 0) {
    gaps.push(
      `${n(p.prunableStillHeld)} price${p.prunableStillHeld === 1 ? "" : "s"} across ${n(p.prunableStillHeldNdcs)} NDC${p.prunableStillHeldNdcs === 1 ? "" : "s"} are older than ${p.cutoff ?? "the cutoff"} with a newer price held, so the nightly prune should have removed them and has not. The prices are not wrong; the table is growing.`,
    );
  }

  const unreadable = p.files.reduce((a, f) => a + f.rowsUnreadable, 0);
  if (unreadable > 0) {
    const why = new Map<string, number>();
    for (const f of p.files) for (const [reason, howMany] of Object.entries(f.unreadableReasons)) why.set(reason, (why.get(reason) ?? 0) + howMany);
    const top = [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, howMany]) => `${n(howMany)} ${reason}`);
    gaps.push(`${n(unreadable)} rows in the CMS files were not prices and were not counted: ${top.join(", ")}.`);
  }
  return gaps;
}

export function nadacProofNote(p: NadacProof): string {
  const n = (x: number) => x.toLocaleString("en-US");
  if (p.files.length === 0) return "The proof ran and found no CMS file in the NADAC folder, so nothing was checked.";
  const span = p.files.reduce<{ from: string | null; to: string | null }>(
    (a, f) => ({
      from: f.effectiveFrom && (!a.from || f.effectiveFrom < a.from) ? f.effectiveFrom : a.from,
      to: f.effectiveTo && (!a.to || f.effectiveTo > a.to) ? f.effectiveTo : a.to,
    }),
    { from: null, to: null },
  );
  return (
    `${n(p.files.length)} CMS file${p.files.length === 1 ? "" : "s"} re-read: ${n(p.rowsInFiles)} rows carrying ${n(p.provedKeys)} distinct prices, ` +
    `set against ${n(p.tableRows)} held over ${n(p.tableNdcs)} NDCs` +
    (span.from && span.to ? `, effective ${span.from} to ${span.to}` : "") +
    `. ${n(p.prunedRows)} file rows are correctly absent, having been pruned past the ${p.keepMonths || 18}-month cutoff. ` +
    "The weekly files republish the same price many times, so rows far exceed prices and only prices are counted here."
  );
}

/* ── The prune, which is a job rather than a measurement ─────────────────── */

export type NadacPrune = {
  /** ISO datetime the job last recorded a result. */
  at: string | null;
  ok: boolean;
  /** Prices removed on that run, where it succeeded. */
  removed: number | null;
  /** The message, where it failed. */
  why: string | null;
  raw: string;
};

/**
 * Reads `nadac_last_prune`, which the job writes as one line rather than as JSON.
 *
 *   2026-09-09T04:10:02.114Z: removed 770,412 prices in 8,213ms
 *   2026-09-09T04:10:02.114Z: failed: database is locked
 *
 * Parsed rather than pattern-matched loosely: "failed" has to follow the timestamp, so a prune that
 * removed a drug whose name contains the word cannot read as a failure.
 */
export function parseNadacPrune(raw: string | undefined | null): NadacPrune | null {
  const line = str(raw);
  if (!line) return null;
  /*
   * The timestamp is matched as a timestamp, not as "everything up to the first colon".
   *
   * That was the first version, and an ISO datetime contains colons — so `at` came out as
   * "2026-09-09T04", the rest began "10:02.114Z: failed: …", and a failed prune read as a
   * successful one. The row would then have been green on the exact night it needed to be red.
   */
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z):\s*(.*)$/s.exec(line);
  if (!m) return { at: null, ok: false, removed: null, why: line, raw: line };
  const [, at, rest] = m;
  if (/^failed\b/i.test(rest)) {
    return { at, ok: false, removed: null, why: rest.replace(/^failed:?\s*/i, "").trim() || "no reason given", raw: line };
  }
  const removed = /removed\s+([\d,]+)/i.exec(rest);
  return { at, ok: true, removed: removed ? Number(removed[1].replace(/,/g, "")) : null, why: null, raw: line };
}

/**
 * One row, and it is a state rather than a proportion: the prune either did its work or did not.
 *
 * A denominator of one is honest here. The alternative — folding it into the proof row — would hide
 * a failed prune behind a proof that still reads well, and those are the two failures this pair
 * exists to keep apart: the prices being right, and the table being the size it should be.
 */
export function nadacPruneFraction(p: NadacPrune | null): { numerator: number; denominator: number } {
  if (!p) return { numerator: 0, denominator: 0 };
  return { numerator: p.ok ? 1 : 0, denominator: 1 };
}

export function nadacPruneGaps(p: NadacPrune | null): string[] {
  if (!p) return [];
  if (!p.ok) return [`The last NADAC prune failed: ${p.why ?? "no reason given"}. Until it succeeds the benchmark table grows, and every reading over it grows with it.`];
  return [];
}

export function nadacPruneNote(p: NadacPrune | null): string {
  if (!p) return "The nightly NADAC prune has not recorded a run.";
  if (!p.ok) return `The last run, at ${p.at ?? "an unrecorded time"}, failed.`;
  return p.removed === null
    ? `The last run, at ${p.at ?? "an unrecorded time"}, completed.`
    : p.removed === 0
      ? `The last run removed nothing, which is the ordinary state once the table is trimmed: every price held is inside the cutoff, or is the newest for its NDC.`
      : `The last run removed ${p.removed.toLocaleString("en-US")} price${p.removed === 1 ? "" : "s"} past the cutoff.`;
}
