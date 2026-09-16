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

export type ScheduleAnswer = {
  schedule: LineSchedule | null;
  /** Whether this line is a Schedule II item: the question `invoice_lines.controlled` has always asked. */
  controlled: boolean | null;
  /** Which source answered, so a disagreement can be argued with rather than only noticed. */
  from: "the invoice's own sections" | "the FDA directory" | "PioneerRx's receiving record" | null;
};

export function lineSchedule(input: {
  /** The invoice's own half, where it prints halves: true for the Schedule II side. */
  sectionControlled?: boolean | null;
  /** The DEA schedule the FDA directory registers against this line's NDC, as printed there ("2", "3", "CIV", ""). */
  directoryCode?: string | null;
  /** Every schedule PioneerRx recorded for the whole delivery this line arrived on. */
  deliveryCodes?: (string | null | undefined)[] | null;
}): ScheduleAnswer {
  if (input.sectionControlled === true) return { schedule: "schedule_2", controlled: true, from: "the invoice's own sections" };

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
