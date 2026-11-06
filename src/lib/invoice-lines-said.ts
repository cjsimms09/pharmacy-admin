/** What the "Read the lines off the invoices" press counts and says it did, both pure so that a test can fail either. */

export type LineReadReport = {
  /** Invoices the rules were run on: every one with no lines on file and a page with text. A scan, or a page that would not open, is in `unreadable` instead. */
  invoices: number;
  /** Of those, the ones that now have at least one line. */
  withLines: number;
  linesRead: number;
  /** Pages with no text to read, plus the ones that could not be read at all (`failed`). */
  unreadable: number;
  /** The subset of `unreadable` that threw: the file would not open, or the read failed. */
  failed: number;
  /** Read and kept with a shortfall on its row (`lines_short_cents`): a half of it, or the whole, did not add up to what the invoice prints. */
  short: number;
  /** Invoices whose lines came from Claude and were kept. */
  byModel: number;
  model: {
    /** Invoices that went to Claude: the rules found no line on them. */
    sent: number;
    /** Of the ones kept, how many had no total anywhere to add the lines up to. */
    keptUnchecked: number;
    /** Asked for and stopped before anything left: no key, the monthly ceiling, the file. */
    refused: number;
    whyNotKept: string | null;
    whyRefused: string | null;
  };
};

/** What became of the ask to Claude for one invoice: whether it was sent, whether the lines were kept, and why not. */
export type ModelReading = { sent: boolean; kept: boolean; why: string | null };

/** What the press learned about one invoice. */
export type OneInvoice =
  | { kind: "scan" }
  | { kind: "failed" }
  /** `shortCents` is read back from the invoice's row after the write, because the row is where its shortfall is recorded. */
  | { kind: "read"; read: number; reconciles: boolean | null; readBy: "rule" | "model" | null; shortCents: number; model: ModelReading };

export function tally(results: OneInvoice[]): LineReadReport {
  const r: LineReadReport = {
    invoices: 0,
    withLines: 0,
    linesRead: 0,
    unreadable: 0,
    failed: 0,
    short: 0,
    byModel: 0,
    model: { sent: 0, keptUnchecked: 0, refused: 0, whyNotKept: null, whyRefused: null },
  };
  const notKept = new Set<string>();
  const refused = new Set<string>();
  for (const x of results) {
    if (x.kind === "scan") {
      r.unreadable++;
      continue;
    }
    if (x.kind === "failed") {
      r.unreadable++;
      r.failed++;
      continue;
    }
    r.invoices++;
    r.linesRead += x.read;
    if (x.read > 0) r.withLines++;
    if (x.read > 0 && x.shortCents !== 0) r.short++;
    if (x.readBy === "model") {
      r.byModel++;
      if (x.reconciles === null) r.model.keptUnchecked++;
    }
    if (x.model.sent) {
      r.model.sent++;
      if (!x.model.kept && x.model.why) notKept.add(x.model.why);
    } else if (x.model.why) {
      r.model.refused++;
      refused.add(x.model.why);
    }
  }
  r.model.whyNotKept = [...notKept].slice(0, 3).join("; ") || null;
  r.model.whyRefused = [...refused].slice(0, 3).join("; ") || null;
  return r;
}

const many = (n: number, one: string, more: string) => (n === 1 ? one : more);
const bare = (s: string) => s.replace(/[.\s]+$/, "");

/** A reason as he is shown it: the site's own refusals whole, since they are written to be read; anything else cut at a word, with the cut visible. */
export function reasonShown(message: string, ours: boolean): string {
  if (ours || message.length <= 240) return message;
  return message.slice(0, 240).replace(/\s+\S*$/, "") + "…";
}

export function saidAboutLineRead(r: LineReadReport): { says: string; trouble: boolean } {
  const bits: string[] = [];
  bits.push(
    r.invoices > 0
      ? `${r.linesRead.toLocaleString()} item line${r.linesRead === 1 ? "" : "s"} read, on ${r.withLines} of the ${r.invoices} invoice${r.invoices === 1 ? "" : "s"} that had text to read`
      : r.unreadable > 0
        ? "No item line was read"
        : "No invoice was waiting to have its lines read",
  );
  if (r.short > 0) {
    const n = r.short;
    bits.push(
      `${n} invoice${many(n, " was", "s were")} read but did not add up to the amount printed on ${many(n, "it", "them")}. The lines are kept, and ${many(n, "its row", "each row")} shows what it is short by`,
    );
  }
  const notKept = r.model.sent - r.byModel;
  if (r.model.sent > 0) {
    const n = r.model.sent;
    let t = `${n} invoice${many(n, " was", "s were")} sent to Claude, because the rules found no line on ${many(n, "it", "them")}: ${r.byModel} read and kept`;
    if (r.model.keptUnchecked > 0) t += ` (${r.model.keptUnchecked} of those with no total to add the lines up to)`;
    if (notKept > 0) {
      t += `, ${notKept} not kept${r.model.whyNotKept ? ` (${bare(r.model.whyNotKept)})` : ""}. ${many(notKept, "That invoice has", "Those invoices have")} no lines, so ${many(notKept, "it is", "they are")} sent again the next time this is pressed, and a reading Claude finishes is charged for whether or not it is kept`;
    }
    bits.push(t);
  }
  if (r.model.refused > 0) {
    bits.push(`${r.model.refused} invoice${many(r.model.refused, "", "s")} could not be sent to Claude${r.model.whyRefused ? `: ${bare(r.model.whyRefused)}` : ""}`);
  }
  const scans = r.unreadable - r.failed;
  if (scans > 0) bits.push(`${scans} ${many(scans, "is a scan", "are scans")} with no text to read`);
  if (r.failed > 0) bits.push(`${r.failed} could not be read at all, and ${many(r.failed, "was", "were")} left as ${many(r.failed, "it was", "they were")}`);
  return { says: bits.join(". ") + ".", trouble: r.model.refused > 0 || r.failed > 0 || notKept > 0 };
}
