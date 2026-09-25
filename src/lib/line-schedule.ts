import { scheduleFromDea } from "./invoice-lines";

/**
 * What schedule an invoice line's drug is, and who says so.
 *
 * `invoice_lines.controlled` answers one narrow question — is this line in the Schedule II half of an invoice that prints
 * its halves — and it is set only where the invoice prints them, which today means IPD. Three lines on the whole site
 * carry it. Everything else is null, which is "not said" and not "not controlled": session 1's first pass at checking the
 * filing read those nulls as uncontrolled and produced five false disagreements, which is the trap that flag sets for
 * anybody who meets it.
 *
 * So the line keeps its own schedule as a word, from whichever of three sources can actually answer, and says which one:
 *
 *   the invoice's own halves   IPD prints the Schedule II items under their own subtotal. The supplier's determination
 *                              about its own delivery, and the strongest evidence there is.
 *   the FDA directory          the schedule registered against that NDC. Answers per line, and declines on a device, a
 *                              front-end item, or anything it does not list — which is 43 of 54 invoices here.
 *   PioneerRx's receiving      the schedules the pharmacy itself recorded for the whole DELIVERY, not per line. It can
 *                              therefore only prove a negative: a delivery whose schedules carry no 2 has no Schedule II
 *                              line in it, whatever else is unknown. Reading it as a per-line answer would be inventing
 *                              one, and this is the source that never declines — which is exactly what makes it tempting.
 *
 * Where none of the three can answer, the schedule is null and stays null. Pure.
 */

export type LineSchedule = "schedule_2" | "schedule_3_5" | "none";

/**
 * What the FDA directory says about one NDC, as a code `scheduleFromDea` understands.
 *
 * Two different silences, and telling them apart is the whole of this function. An NDC the
 * directory has never heard of tells you nothing. An NDC the directory *lists*, with the schedule
 * field blank, tells you it is not a controlled substance — every entry has been looked at, and a
 * drug recorded with no schedule is a drug with no schedule.
 *
 * `invoices.ts` has always applied that rule when filing a whole invoice, in as many words: "the
 * directory's blank means 'not a controlled substance', and this is the one place such a null is a
 * fact rather than an absence". The per-line reader did not, and passed the blank through as an
 * empty string — which `scheduleFromDea` discards, leaving the line unanswered. So a line whose
 * drug the FDA positively lists as uncontrolled was recorded as "nobody knows".
 *
 * Written as "0" because that is PioneerRx's code for an ordinary item and the parser already reads
 * it. One vocabulary, not two.
 */
export function directoryCodeOf(listed: string | null | undefined): string | null {
  if (listed === null || listed === undefined) return null;
  const code = listed.trim();
  return code === "" ? "0" : code;
}

export type ScheduleAnswer = {
  schedule: LineSchedule | null;
  /** Whether this line is a Schedule II item: the question `invoice_lines.controlled` has always asked. */
  controlled: boolean | null;
  /** Which source answered, so a disagreement can be argued with rather than only noticed. */
  from: "the invoice's own sections" | "the supplier's own class" | "the FDA directory" | "PioneerRx's receiving record" | null;
};

/**
 * What McKesson's item class says about a line's schedule, where it says anything.
 *
 * McKesson prints a class against every line it sells, and on this pharmacy's invoices the class is
 * the schedule: X on all 81 Schedule II lines, B, D and E on every Schedule III-V line, R on 566
 * prescription lines none of which is controlled. It is the supplier's own statement about the
 * product it shipped, which is why it sits above the FDA directory.
 *
 * Found on 22 September 2026, hours after the directory was allowed to answer "not controlled": the
 * directory lists the Xcopri titration pack with a blank schedule, and cenobamate has been Schedule
 * V since 2020. McKesson's E was right and the directory was wrong, and a Schedule V drug was
 * recorded as uncontrolled by a fix written that afternoon. One line in 139, and the one kind of
 * mistake this column exists to prevent.
 *
 * Only the letters the invoices have proved are read. A class nobody has seen yet says nothing, and
 * a blank says nothing either: blank is McKesson's over-the-counter class, and pseudoephedrine is
 * over the counter federally and scheduled in some states.
 */
export function scheduleFromSupplierClass(cls: string | null | undefined): LineSchedule | null {
  const c = String(cls ?? "").trim().toUpperCase();
  if (c === "X") return "schedule_2";
  if (c === "B" || c === "D" || c === "E") return "schedule_3_5";
  if (c === "R") return "none";
  return null;
}

export function lineSchedule(input: {
  /** The invoice's own half, where it prints halves: true for the Schedule II side. */
  sectionControlled?: boolean | null;
  /** McKesson's item class for the line, where the supplier is McKesson. Nobody else prints one. */
  supplierClass?: string | null;
  /** The DEA schedule the FDA directory registers against this line's NDC, as printed there ("2", "3", "CIV", ""). */
  directoryCode?: string | null;
  /** Every schedule PioneerRx recorded for the whole delivery this line arrived on. */
  deliveryCodes?: (string | null | undefined)[] | null;
}): ScheduleAnswer {
  if (input.sectionControlled === true) return { schedule: "schedule_2", controlled: true, from: "the invoice's own sections" };

  const byClass = scheduleFromSupplierClass(input.supplierClass);
  if (byClass !== null) return { schedule: byClass, controlled: byClass === "schedule_2", from: "the supplier's own class" };

  const directory = scheduleFromDea([input.directoryCode]);
  if (directory !== "unknown") {
    return { schedule: directory, controlled: directory === "schedule_2", from: "the FDA directory" };
  }

  /*
   * The delivery's own schedules, used only for what they can prove.
   *
   * A delivery carrying no 2 has no Schedule II line on it, so this line is not one — but the delivery's schedules say
   * nothing about WHICH of its lines is the Schedule III on it, so the schedule itself stays unknown unless every code is
   * "not controlled".
   */
  const codes = (input.deliveryCodes ?? []).map((c) => String(c ?? "").trim()).filter((c) => c !== "");
  if (codes.length > 0) {
    const delivery = scheduleFromDea(codes);
    if (delivery === "none") return { schedule: "none", controlled: false, from: "PioneerRx's receiving record" };
    if (delivery !== "schedule_2" && delivery !== "unknown") return { schedule: null, controlled: false, from: "PioneerRx's receiving record" };
    if (input.sectionControlled === false && delivery === "schedule_2") {
      /* The invoice says this line is not in its Schedule II half, and the delivery did carry one: not this line's. */
      return { schedule: null, controlled: false, from: "the invoice's own sections" };
    }
  }

  /* The invoice printed halves and this line is in the other one: not Schedule II, and nothing more is known. */
  if (input.sectionControlled === false) return { schedule: null, controlled: false, from: "the invoice's own sections" };
  return { schedule: null, controlled: null, from: null };
}

/**
 * A line whose own schedule contradicts the drawer its invoice is filed in.
 *
 * The one filing error a regulator cares about: a Schedule II item on an invoice filed as ordinary. Kept as a question
 * about evidence rather than a rule about states — a line that says nothing contradicts nothing, which is the whole
 * lesson of the null flag.
 */
export function filingDisagrees(input: { lineSchedule: LineSchedule | null; invoiceSchedule: string }): string | null {
  if (input.lineSchedule === "schedule_2" && input.invoiceSchedule !== "schedule_2") {
    return `a Schedule II line on an invoice filed as ${input.invoiceSchedule.replace("_", " ")}`;
  }
  if (input.lineSchedule === "schedule_3_5" && input.invoiceSchedule === "none") {
    return "a Schedule III-V line on an invoice filed as carrying no controlled items";
  }
  return null;
}
