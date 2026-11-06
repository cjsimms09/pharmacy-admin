import { reasonShown } from "./invoice-lines-said";

/** What the "Write every fix that needs no answer" press counts and says it did, both pure so that a test can fail either. */

/** The words on a finding's card that open the place to give a fact, before and after one is given, and on the button that sets it aside; the message quotes all three. */
export const TELL_IT_LABEL = "This turns on how we do it here — tell it";
export const CHANGE_IT_LABEL = "Change what you told it";
export const NOT_A_PROBLEM_LABEL = "Not a problem";

/** What became of the ask for one finding. One of these is made for every finding Claude was asked about, including the ones that threw. */
export type WriteOutcome =
  | { kind: "wrote"; section: string }
  | { kind: "needs-fact"; section: string; need: string }
  | { kind: "failed"; section: string; why: string; ours: boolean };

export type WriteAllReport = {
  /** Findings Claude was asked about in this press. */
  tried: number;
  wrote: number;
  /** Came back asking for a fact about this pharmacy that it does not have, whether or not one was given before. */
  needFacts: { section: string; need: string }[];
  /** Stopped before an answer came back: no key, the monthly ceiling, a rate limit, a finding that was gone. */
  failed: { section: string; why: string; ours: boolean }[];
  /** Still without text and never asked about, because the limit or the time ran out first. */
  notTried: number;
  /** The most findings one press asks about; the ones left without text are first in line again, so it decides whether the rest are reached. */
  limit: number;
};

export function tallyWriteAll(outcomes: WriteOutcome[], waiting: number, limit: number): WriteAllReport {
  const r: WriteAllReport = { tried: outcomes.length, wrote: 0, needFacts: [], failed: [], notTried: Math.max(0, waiting - outcomes.length), limit };
  for (const x of outcomes) {
    if (x.kind === "wrote") r.wrote++;
    else if (x.kind === "needs-fact") r.needFacts.push({ section: x.section, need: x.need });
    else r.failed.push({ section: x.section, why: x.why, ours: x.ours });
  }
  return r;
}

const many = (n: number, one: string, more: string) => (n === 1 ? one : more);
const bare = (s: string) => s.replace(/[.\s]+$/, "");
const NAMED = 6;

export function saidAboutWriteAll(r: WriteAllReport): { says: string; trouble: boolean } {
  if (r.tried === 0 && r.notTried === 0) return { says: "No finding was waiting for text.", trouble: false };
  const bits: string[] = [r.wrote > 0 ? `${r.wrote} written and waiting for you to read` : "None written"];

  const asks = r.needFacts.length;
  if (asks > 0) {
    const named = r.needFacts.slice(0, NAMED).map((x) => x.section);
    if (asks > NAMED) named.push(`and ${asks - NAMED} more`);
    bits.push(`${asks} ${many(asks, "needs", "need")} a fact about this pharmacy that it does not have: ${named.join("; ")}`);
    const first = r.needFacts[0];
    if (first.need.trim()) bits.push(`${first.section} is waiting on: ${bare(reasonShown(first.need.trim(), false))}`);
    bits.push(
      `Open ${many(asks, "it", "each")} and give the fact in the box under "${TELL_IT_LABEL}", or under "${CHANGE_IT_LABEL}" where you have already answered, and it writes the wording from your answer`,
    );
  }

  const broke = r.failed.length;
  if (broke > 0) {
    const first = r.failed[0];
    bits.push(`${broke} could not be written: ${first.section}: ${bare(reasonShown(first.why, first.ours))}${broke > 1 ? ` (and ${broke - 1} more failed)` : ""}`);
  }

  const unwritten = asks + broke;
  if (r.notTried > 0) {
    const firstInLine = `The ${unwritten} above still ${many(unwritten, "has", "have")} no text, so ${many(unwritten, "it is", "they are")} first in line again: pressing again asks about ${many(unwritten, "it", "them")} again before any of the rest`;
    bits.push(
      unwritten === 0
        ? `${r.notTried} not tried yet; press again to carry on`
        : unwritten >= r.limit
          ? `${r.notTried} not tried yet. ${firstInLine}, and a press asks about ${r.limit} at most, so none of the rest is reached until ${many(unwritten, "that is", "some of them are")} written or marked "${NOT_A_PROBLEM_LABEL}"`
          : `${r.notTried} not tried yet. ${firstInLine}, and a press asks about ${r.limit} at most and stops when its time runs out, so the rest are reached only as far as that leaves room`,
    );
  }
  return { says: bits.join(". ") + ".", trouble: broke > 0 || (r.tried > 0 && r.wrote === 0) };
}
