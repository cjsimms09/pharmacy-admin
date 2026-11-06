import { periodsBetween, periodKeyFor, periodLabel, type PeriodState } from "./periods";
import type { ObligationCadence } from "@/db/schema";

/**
 * Which periods of a duty the site judges at all, and so what the register may say about a period.
 *
 * Two screens draw the same duties: the list on Compliance decides late or part done, and the register draws every period as a coloured
 * cell. If they differ about which periods were judged, the register paints "covered" over a period nobody judged. Two periods were
 * never judged and read green: every period of a duty still waiting for its yes or no, and every period before the day a late-confirmed
 * duty was confirmed. Both are decided here, once.
 *
 * A duty waiting for its yes or no is judged for no period: it ships switched on because leaving out a rule that does apply is the
 * expensive mistake, but counting periods against a question produces a screen of failures for things the pharmacy may not do. A duty
 * confirmed as the pharmacy's own in March is judged from March: confirming one then does not manufacture two missed months.
 *
 * Pure, so the agreement can be checked on its own.
 */

export type CellState = PeriodState | "awaiting" | "not_judged";

export type Judged = { cadence: ObligationCadence; needsConfirmation: boolean; confirmedOn: string | null };

/** The day counting starts for a duty: when the site began, or when the duty was confirmed as the pharmacy's own if that came later. */
export function judgedFrom(confirmedOn: string | null, siteStart: string): string {
  return confirmedOn && confirmedOn > siteStart ? confirmedOn : siteStart;
}

/** The periods judged: none while the duty waits for an answer, and none before the day counting starts. */
export function judgedPeriods(o: Judged, siteStart: string, today: string): string[] {
  if (o.needsConfirmation) return [];
  return periodsBetween(o.cadence, judgedFrom(o.confirmedOn, siteStart), today);
}

/** What the register shows for one period. `listed` is the state the list on Compliance gave it, undefined when the list did not carry it. */
export function cellState(o: Pick<Judged, "needsConfirmation">, periodKey: string, judged: ReadonlySet<string>, listed: PeriodState | undefined): CellState {
  if (o.needsConfirmation) return "awaiting";
  if (!judged.has(periodKey)) return "not_judged";
  return listed ?? "satisfied";
}

/** Said once, so Compliance, Today, the register and the inspection sheet do not each find their own words for a duty nobody has answered. */
export function awaitingSaid(n: number): string {
  return `${n} ${n === 1 ? "duty is" : "duties are"} waiting for your yes or no`;
}

/** What waiting costs. It is also why none of these screens may call themselves clean while a duty waits. */
export const AWAITING_COST =
  "Until you answer, no period of a waiting duty is judged, so none reads late and none reads covered. A person's training or a licence is judged on its own screen either way.";

/** What the inspection sheet says about the register: what is behind, then what is waiting. Late and part done are both behind. */
export function registerSaid(missed: number, partial: number, waiting: number): string {
  const behind =
    missed === 0 && partial === 0
      ? waiting === 0
        ? "Every period that has ended is covered."
        : "Every period that has been judged is covered."
      : [
          missed > 0 ? `${missed} period${missed === 1 ? "" : "s"} went by without being covered.` : "",
          partial > 0 ? `${partial} period${partial === 1 ? " was" : "s were"} only partly covered.` : "",
          "Those are what an inspector finds.",
        ]
          .filter(Boolean)
          .join(" ");
  return waiting === 0 ? behind : `${behind} ${awaitingSaid(waiting)}. ${AWAITING_COST}`;
}

/** What answering "yes" starts. The period that holds the day of the answer is judged along with every later one; earlier ones are not. */
export function yesSaid(title: string, cadence: ObligationCadence, today: string): string {
  const key = periodKeyFor(cadence, today);
  return key
    ? `"${title}" is now tracked. It is counted from the period that holds today, ${periodLabel(key)}, so that period can still be late if it ends uncovered; earlier ones are not counted.`
    : `"${title}" is recorded as applying here. It is done when it happens, so it has no periods and is never counted late.`;
}

/** What answering "no" stops, and what it leaves alone: only this duty's own periods. A person's training and a licence have their own screens. */
export function noSaid(title: string): string {
  return `"${title}" is recorded as not applying here, with today's date and your name. None of its periods are counted on Compliance or the register any more, and the register lists it under "Considered and not applicable". Anything with its own screen, such as a person's training or a licence, is still tracked there.`;
}
