/**
 * The claims proof, as a row and as a warning.
 *
 * The owner, 8 September: "these things need to be right!! we need to make sure claims are
 * matching their info properly and continue to. we need to do the same with drug info (pricing,
 * nadac, awp, equivalents, etc).. this is the most important thing."
 *
 * "And continue to" is the whole of it. Every other row on Data health measures whether the site's
 * tables link up with each other, which they can do perfectly while every one of them disagrees
 * with the file it was read from. A proof is the other question: the stored source read again and
 * set against what was stored from it. `scripts/prove-claims.ts` does the reading each night and
 * leaves its answer in the `claims_proof` setting; this turns that answer into a row and, when it
 * is bad, into a line on the screen the pharmacist reads from the doorway.
 *
 * Pure, and deliberately so — it parses JSON written by another process, which is exactly the kind
 * of boundary where a shape drifts silently. Everything here tolerates a field being absent, and
 * says "not measured" rather than inventing a zero, because a proof that has never run and a proof
 * that found nothing wrong must never read the same.
 */

/** One report file, re-read and set against the claims stored from it. */
export type ClaimsProofFile = {
  file: string;
  /** The days this report covers, which is not the day the proof ran. Both are printed. */
  period: { from: string | null; to: string | null } | null;
  rowsRead: number;
  paid: number;
  reversed: number;
  matched: number;
  cancelledLater: number;
  differs: number;
  missing: number;
  reportSalesCents: number | null;
  readRemitCents: number | null;
  readSalesCents: number | null;
  skipped: number;
  /** Anything that stopped the file being proved at all, in words. */
  problems: string[];
};

export type ClaimsProof = {
  /** ISO. The day the proof was run, not the last day its files cover. */
  provedOn: string | null;
  files: ClaimsProofFile[];
  paidRowsInFiles: number;
  matched: number;
  disagreements: number;
  /** Rows in the claims table that no report file accounts for: the other direction of the proof. */
  tableRowsNoFileAccountsFor: number;
  /** The first of the disagreements, already in words. */
  lines: string[];
};

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const maybeNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A file's coverage, `{from, to}`. Tolerates a bare string, which is what it looked like from outside. */
function period(v: unknown): { from: string | null; to: string | null } | null {
  if (typeof v === "string") return { from: null, to: str(v) };
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const from = str(o.from);
  const to = str(o.to);
  return from === null && to === null ? null : { from, to };
}

/**
 * Reads the setting, or null where it has never been written or cannot be read.
 *
 * Null rather than an empty proof, because those are different facts and only one of them is
 * reassuring. A proof that has never run is a thing to go and fix; a proof that ran and found
 * nothing wrong is the finished state.
 */
export function parseClaimsProof(raw: string | undefined | null): ClaimsProof | null {
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
        (f): ClaimsProofFile => ({
          file: str(f.file) ?? "an unnamed file",
          period: period(f.period),
          rowsRead: num(f.rowsRead),
          paid: num(f.paid),
          reversed: num(f.reversed),
          matched: num(f.matched),
          cancelledLater: num(f.cancelledLater),
          differs: num(f.differs),
          missing: num(f.missing),
          reportSalesCents: maybeNum(f.reportSalesCents),
          readRemitCents: maybeNum(f.readRemitCents),
          readSalesCents: maybeNum(f.readSalesCents),
          skipped: num(f.skipped),
          problems: strs(f.problems),
        }),
      )
    : [];
  return {
    provedOn: str(j.provedOn),
    files,
    paidRowsInFiles: num(j.paidRowsInFiles),
    matched: num(j.matched),
    disagreements: num(j.disagreements),
    tableRowsNoFileAccountsFor: num(j.tableRowsNoFileAccountsFor),
    lines: strs(j.lines),
  };
}

/** Rows cancelled by a later reversal, which are proved: the file says so and the table agrees. */
export function cancelledRows(p: ClaimsProof): number {
  return p.files.reduce((n, f) => n + f.cancelledLater, 0);
}

/** Rows that could not be proved at all: named, so the number is never the whole answer. */
export function missingRows(p: ClaimsProof): number {
  return p.files.reduce((n, f) => n + f.missing, 0);
}

export function skippedRows(p: ClaimsProof): number {
  return p.files.reduce((n, f) => n + f.skipped, 0);
}

/** Everything that stopped a file being proved, with the file named on each. */
export function fileProblems(p: ClaimsProof): string[] {
  return p.files.flatMap((f) => f.problems.map((w) => `${f.file}: ${w}`));
}

/**
 * The fraction the Data health row shows.
 *
 * ── Why the denominator counts both directions ──
 *
 * The obvious denominator is the paid rows in the files, and it is half the question. A row in the
 * claims table that no file accounts for is the same failure seen from the other end, and it is
 * invisible from that side: four hundred stray rows and none read identically at a hundred per
 * cent. So the denominator is every row that has to be proved, on either side — the file rows plus
 * the table rows nothing explains — and the numerator is the rows that were proved. A stray on
 * either side then costs the percentage, which is what makes the row worth reading.
 *
 * ── Rows that matched but disagree ──
 *
 * A row whose figures differ from the claim's is not proved; it is the opposite. `differs` is
 * taken to be disjoint from `matched` — the script counts a row as one or the other — so nothing
 * is subtracted here. If that turns out to be wrong the fix is the one line marked below, and the
 * symptom would be a row reading a hundred per cent while `disagreements` is not zero, which the
 * test named for it would catch.
 */
export function claimsProofFraction(p: ClaimsProof): { numerator: number; denominator: number } {
  const denominator = p.paidRowsInFiles + p.tableRowsNoFileAccountsFor;
  // If `matched` is ever found to include the rows that differ, subtract p.disagreements here.
  const numerator = Math.min(p.matched + cancelledRows(p), denominator);
  return { numerator, denominator };
}

/**
 * What is wrong, in the words the page prints, worst first.
 *
 * The script's own sentences come first and are used verbatim: it read the files and this module
 * did not, so it is the one that can say which prescription on which day differs by how much.
 */
export function claimsProofGaps(p: ClaimsProof): string[] {
  const gaps: string[] = [];
  const problems = fileProblems(p);
  if (problems.length > 0) gaps.push(...problems);
  if (p.disagreements > 0) {
    gaps.push(
      `${p.disagreements.toLocaleString("en-US")} row${p.disagreements === 1 ? "" : "s"} in the daily reports disagree with the claim stored from them.`,
    );
  }
  const missing = missingRows(p);
  if (missing > 0) {
    gaps.push(`${missing.toLocaleString("en-US")} paid row${missing === 1 ? "" : "s"} in the reports reached no claim in the table at all.`);
  }
  if (p.tableRowsNoFileAccountsFor > 0) {
    gaps.push(
      `${p.tableRowsNoFileAccountsFor.toLocaleString("en-US")} claim row${p.tableRowsNoFileAccountsFor === 1 ? "" : "s"} in the table are accounted for by no report on file. They may be right; nothing here can show that they are.`,
    );
  }
  const skipped = skippedRows(p);
  if (skipped > 0) gaps.push(`${skipped.toLocaleString("en-US")} row${skipped === 1 ? "" : "s"} were skipped rather than proved.`);
  // The script's own sentences last, because they are the detail behind the counts above.
  gaps.push(...p.lines);
  return gaps;
}

/**
 * The last day any proved report covers, which is not the day the proof ran.
 *
 * The two diverge the moment a night is skipped or a report stops arriving, and that gap is the
 * whole point of the row — a proof run faithfully every night over files that stopped three weeks
 * ago is a green row over a blind spot. So both dates are printed, and this is the second one.
 */
export function coversThrough(p: ClaimsProof): string | null {
  const days = p.files.map((f) => f.period?.to).filter((d): d is string => typeof d === "string");
  return days.length === 0 ? null : days.reduce((a, b) => (a > b ? a : b));
}

/** The note under the figure: what the proof covered, so a hundred per cent is readable. */
export function claimsProofNote(p: ClaimsProof): string {
  if (p.files.length === 0) return "The proof has run but read no report file, so nothing was checked.";
  const cancelled = cancelledRows(p);
  const cents = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const sales = p.files.reduce<number | null>((n, f) => (f.reportSalesCents === null || n === null ? null : n + f.reportSalesCents), 0);
  const read = p.files.reduce<number | null>((n, f) => (f.readSalesCents === null || n === null ? null : n + f.readSalesCents), 0);
  const totals =
    sales !== null && read !== null
      ? sales === read
        ? ` The reports' own grand totals of ${cents(sales)} equal what was read from them, to the cent.`
        : ` The reports' own grand totals come to ${cents(sales)} and what was read from them to ${cents(read)}, a difference of ${cents(Math.abs(sales - read))}.`
      : "";
  /*
   * Both dates, always, and they are different questions.
   *
   * `provedOn` is when the proof ran; the newest file's period is how far the evidence reaches. A
   * proof run faithfully every night over reports that stopped arriving three weeks ago is a green
   * row over a blind spot, and only the second date shows it.
   */
  const through = coversThrough(p);
  return (
    `${p.files.length} daily report${p.files.length === 1 ? "" : "s"} re-read and set against the claims stored from them: ` +
    `${p.matched.toLocaleString("en-US")} matched` +
    (cancelled > 0 ? ` and ${cancelled.toLocaleString("en-US")} cancelled by a later reversal, which is also proved` : "") +
    `.${totals}` +
    (through ? ` Proved on ${p.provedOn ?? "an unrecorded day"}, covering through ${through}.` : "")
  );
}

/**
 * Whether this belongs on the screen read from the doorway, and what it should say there.
 *
 * Deliberately narrow. A proof exists to be silent almost every day, and a row that appears on
 * Today for anything less than a real disagreement teaches the pharmacist to scroll past the ones
 * that matter. Two things qualify: the figures disagree, or a file could not be proved at all —
 * the second because a proof that could not run is indistinguishable from one that found nothing,
 * which is the failure this whole arrangement cannot survive quietly.
 *
 * A proof that has never run does not appear here. That is a gap on Data health, where the list of
 * what has not been measured belongs, not an alarm about today's money.
 */
export function claimsProofAlert(p: ClaimsProof | null): { title: string; why: string } | null {
  if (!p) return null;
  const problems = fileProblems(p);
  if (p.disagreements === 0 && problems.length === 0) return null;
  /*
   * One of these is read far more often than twelve, so the singular has to be a sentence.
   *
   * Pluralising the noun alone left "1 claim disagree with the report they were read from", which
   * is the sort of thing that makes a pharmacist trust the arithmetic slightly less than he did
   * before he read it. The verb and the pronoun move with the count.
   */
  const one = p.disagreements === 1;
  const parts: string[] = [];
  if (p.disagreements > 0) {
    parts.push(
      one
        ? "1 row in the daily reports does not match the claim stored from it"
        : `${p.disagreements.toLocaleString("en-US")} rows in the daily reports do not match the claims stored from them`,
    );
  }
  if (problems.length > 0) parts.push(`${problems.length} report${problems.length === 1 ? "" : "s"} could not be proved: ${problems[0]}`);
  return {
    title:
      p.disagreements > 0
        ? one
          ? "1 claim disagrees with the report it was read from"
          : `${p.disagreements.toLocaleString("en-US")} claims disagree with the reports they were read from`
        : "A daily report could not be checked against the claims stored from it",
    why: `${parts.join("; ")}. Every figure on this site starts at the claims, so this is checked before anything built on them is worth reading.`,
  };
}
