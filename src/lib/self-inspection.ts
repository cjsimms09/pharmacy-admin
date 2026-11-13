import "server-only";
import { eq, and, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { todayIso } from "./dates";
import { periodKeyFor } from "./periods";
import { ALL_ITEMS, itemFor, ITEM_COUNT } from "./self-inspection-checklist";
import type { SelfInspectionResult } from "@/db/schema";

/**
 * Running a self-inspection, and — the part that matters — closing out what it finds.
 *
 * An inspection that finds nothing is worth very little. An inspection that finds two things and
 * shows them corrected three days later is worth a great deal, because it demonstrates the one
 * thing an inspector cannot verify by looking: that this pharmacy checks itself and acts on the
 * answer. So findings are first-class here — they outlive the walkthrough that produced them,
 * they appear on the dashboard until they are corrected, and the printed record shows both the
 * finding and its correction rather than quietly dropping the ones that were fixed.
 */

export type OpenFinding = {
  id: string;
  inspectionId: string;
  itemKey: string;
  ask: string;
  section: string;
  authority: string;
  note: string | null;
  correctiveAction: string | null;
  foundOn: string;
  daysOpen: number;
  /** Where in the site this gets fixed, when the site holds the tool. */
  fixHref: string | null;
};

export async function startInspection(user: { name: string }): Promise<string> {
  // An unfinished walkthrough already in progress is resumed rather than duplicated: two half-done
  // inspections is worse than one, and it is how somebody ends up with neither finished.
  const open = await db.query.selfInspections.findFirst({ where: isNull(schema.selfInspections.completedOn) });
  if (open) return open.id;

  const id = newId();
  await db.insert(schema.selfInspections).values({
    id,
    startedOn: todayIso(),
    periodKey: periodKeyFor("annual", todayIso()),
    createdBy: user.name,
  });
  return id;
}

export async function currentInspection() {
  return db.query.selfInspections.findFirst({ where: isNull(schema.selfInspections.completedOn) });
}

/** Records one answer, replacing any earlier answer for that item in the same walkthrough. */
export async function answer(
  inspectionId: string,
  itemKey: string,
  result: SelfInspectionResult,
  note: string | null,
): Promise<void> {
  if (!itemFor(itemKey)) throw new Error("That is not an item on the checklist.");
  if (result === "finding" && !note?.trim()) {
    throw new Error("Say what you found. A finding with no note cannot be corrected by anyone but the person who saw it.");
  }

  const existing = await db.query.selfInspectionItems.findFirst({
    where: and(
      eq(schema.selfInspectionItems.inspectionId, inspectionId),
      eq(schema.selfInspectionItems.itemKey, itemKey),
    ),
  });

  if (existing) {
    await db
      .update(schema.selfInspectionItems)
      .set({ result, note: note?.trim() || null })
      .where(eq(schema.selfInspectionItems.id, existing.id));
    return;
  }
  await db.insert(schema.selfInspectionItems).values({
    id: newId(),
    inspectionId,
    itemKey,
    result,
    note: note?.trim() || null,
  });
}

/** Marks a finding put right. */
export async function correct(itemId: string, action: string, user: { name: string }): Promise<void> {
  if (!action.trim()) throw new Error("Say what was done about it.");
  await db
    .update(schema.selfInspectionItems)
    .set({ correctiveAction: action.trim(), correctedOn: todayIso(), correctedBy: user.name })
    .where(eq(schema.selfInspectionItems.id, itemId));
}

export type InspectionProgress = {
  id: string;
  startedOn: string;
  answered: number;
  total: number;
  findings: number;
  notApplicable: number;
  complete: boolean;
};

export async function progress(inspectionId: string): Promise<InspectionProgress> {
  const rows = await db.query.selfInspectionItems.findMany({
    where: eq(schema.selfInspectionItems.inspectionId, inspectionId),
  });
  const insp = await db.query.selfInspections.findFirst({ where: eq(schema.selfInspections.id, inspectionId) });
  return {
    id: inspectionId,
    startedOn: insp?.startedOn ?? todayIso(),
    answered: rows.length,
    total: ITEM_COUNT,
    findings: rows.filter((r) => r.result === "finding").length,
    notApplicable: rows.filter((r) => r.result === "na").length,
    complete: rows.length >= ITEM_COUNT,
  };
}

/**
 * Finalises the walkthrough and closes the compliance duty against it.
 *
 * Refuses on a half-finished one. A self-inspection that skipped the controlled substance section
 * is not a self-inspection, and recording it as one would put a green tick on the register for
 * something that did not happen — which is worse than the duty being open.
 */
export async function finalise(
  inspectionId: string,
  user: { id: string; name: string },
  notes?: string,
): Promise<{ findings: number }> {
  const p = await progress(inspectionId);
  if (!p.complete) {
    throw new Error(
      `${p.total - p.answered} item${p.total - p.answered === 1 ? "" : "s"} still unanswered. Mark each one — including anything that does not apply here — before finishing.`,
    );
  }

  const today = todayIso();
  await db
    .update(schema.selfInspections)
    .set({ completedOn: today, completedBy: user.name, notes: notes?.trim() || null })
    .where(eq(schema.selfInspections.id, inspectionId));

  const obligation = await db.query.obligations.findFirst({
    where: eq(schema.obligations.seedKey, "self_inspection"),
  });
  if (obligation) {
    const periodKey = periodKeyFor(obligation.cadence, today) ?? today.slice(0, 4);
    const already = await db.query.obligationCompletions.findFirst({
      where: and(
        eq(schema.obligationCompletions.obligationId, obligation.id),
        eq(schema.obligationCompletions.periodKey, periodKey),
      ),
    });
    if (!already) {
      await db.insert(schema.obligationCompletions).values({
        id: newId(),
        obligationId: obligation.id,
        periodKey,
        completedOn: today,
        completedBy: user.name,
        statement:
          `On ${today} I walked the pharmacy against all ${p.total} items of the self-inspection checklist. ` +
          `${p.findings === 0 ? "Nothing was found requiring correction." : `${p.findings} item${p.findings === 1 ? " was" : "s were"} found requiring correction and recorded with what is being done about ${p.findings === 1 ? "it" : "them"}.`}` +
          `${p.notApplicable > 0 ? ` ${p.notApplicable} item${p.notApplicable === 1 ? " does" : "s do"} not apply to this pharmacy.` : ""}`,
      });
    }
  }
  return { findings: p.findings };
}

/** Findings from any inspection that have not been corrected yet. */
export async function openFindings(): Promise<OpenFinding[]> {
  const rows = await db.query.selfInspectionItems.findMany({
    where: and(eq(schema.selfInspectionItems.result, "finding"), isNull(schema.selfInspectionItems.correctedOn)),
  });
  if (rows.length === 0) return [];
  const inspections = await db.query.selfInspections.findMany();
  const today = todayIso();

  return rows
    .map((r) => {
      const item = itemFor(r.itemKey);
      const insp = inspections.find((i) => i.id === r.inspectionId);
      const foundOn = insp?.completedOn ?? insp?.startedOn ?? today;
      return {
        id: r.id,
        inspectionId: r.inspectionId,
        itemKey: r.itemKey,
        ask: item?.ask ?? r.itemKey,
        section: ALL_ITEMS.find((i) => i.key === r.itemKey)?.section ?? "",
        authority: item?.authority ?? "",
        note: r.note,
        correctiveAction: r.correctiveAction,
        fixHref: item?.fixHref ?? null,
        foundOn,
        daysOpen: Math.max(0, Math.round((Date.parse(today) - Date.parse(foundOn)) / 86_400_000)),
      };
    })
    .sort((a, b) => b.daysOpen - a.daysOpen);
}

/** Everything ever walked, newest first. */
export async function history() {
  const inspections = await db.query.selfInspections.findMany({
    orderBy: (i, { desc }) => [desc(i.startedOn)],
  });
  const items = await db.query.selfInspectionItems.findMany();
  return inspections.map((i) => {
    const mine = items.filter((x) => x.inspectionId === i.id);
    return {
      ...i,
      answered: mine.length,
      findings: mine.filter((x) => x.result === "finding").length,
      outstanding: mine.filter((x) => x.result === "finding" && !x.correctedOn).length,
    };
  });
}

export type KnownAnswer = {
  /** What the site believes, and why. */
  suggests: SelfInspectionResult;
  evidence: string;
};

/**
 * What the site can answer without anyone walking anywhere.
 *
 * Roughly a third of any pharmacy checklist asks about things this site has been tracking all
 * along — whether the technician list is current, whether every licence is in date, whether the
 * temperature months are covered, whether training records are complete. Making the PIC go and
 * check those by hand is asking them to audit software that already knows, and it is how the
 * other two thirds — the fridge, the bins, the shelves, the things that genuinely need eyes —
 * end up rushed.
 *
 * So these arrive pre-answered with the evidence attached. Deliberately as a suggestion rather
 * than a fait accompli: the pharmacist still presses the button, because a checklist that fills
 * itself in is a checklist nobody has read, and the signature at the end has to mean something.
 */
export async function knownAnswers(): Promise<Map<string, KnownAnswer>> {
  const out = new Map<string, KnownAnswer>();
  const today = todayIso();

  const [{ complianceSummary }, { staffMatrix }, { registerStatus }, { csInventoryStatus }] = await Promise.all([
    import("./compliance-status"),
    import("./staff-matrix"),
    import("./business-associates"),
    import("./compliance"),
  ]);
  const [compliance, matrix, agreements, cs, summaries] = await Promise.all([
    complianceSummary(),
    staffMatrix(),
    registerStatus(),
    csInventoryStatus(),
    db.query.cqiSummaries.findMany(),
  ]);

  const temps = compliance.all.find((i) => i.seedKey === "temperature_logs" && (i.state === "missed" || i.state === "partial"));
  out.set("temperature_logs", {
    suggests: temps ? "finding" : "ok",
    evidence: temps
      ? `${temps.periodLabel} is not complete — readings, an explanation against every excursion, and the month signed off.`
      : "Every month that has ended has readings, every excursion explained, and the month signed off.",
  });

  const trainingGaps = matrix.rows.reduce(
    (n, r) => n + ["hipaa", "fwa", "bbp", "hazcom"].filter((k) => r.cells[k]?.state === "missing" || r.cells[k]?.state === "late").length,
    0,
  );
  out.set("training_records", {
    suggests: trainingGaps > 0 ? "finding" : "ok",
    evidence:
      trainingGaps > 0
        ? `${trainingGaps} training record${trainingGaps === 1 ? " is" : "s are"} missing or lapsed across the people on site.`
        : `All ${matrix.rows.length} people on site are current, each with a certificate behind it, and the whole file prints in one go.`,
  });

  const licenceGaps = matrix.rows.filter((r) => r.cells.license.state === "missing" || r.cells.license.state === "late");
  out.set("licences_current", {
    suggests: licenceGaps.length > 0 ? "finding" : "ok",
    evidence:
      licenceGaps.length > 0
        ? `No current licence on file for ${licenceGaps.map((r) => r.name).join(", ")}.`
        : `All ${matrix.rows.length} people on site hold a current licence or registration.`,
  });

  const techList = compliance.all.find((i) => i.seedKey === "technician_list" && i.state === "missed");
  out.set("technician_list", {
    suggests: techList ? "finding" : "ok",
    evidence: techList
      ? `The list for ${techList.periodLabel} was never filed.`
      : "Filed automatically at the end of every month, and any past month prints exactly as it stood.",
  });

  out.set("baas", {
    suggests: agreements.ok ? "ok" : "finding",
    evidence: agreements.summary,
  });

  const cqiOpen = compliance.all.find((i) => i.seedKey === "cqi_summary" && i.state === "missed");
  out.set("cqi_records", {
    suggests: cqiOpen ? "finding" : summaries.filter((s) => s.status === "final").length === 0 ? "finding" : "ok",
    evidence: cqiOpen
      ? `The summary for ${cqiOpen.periodLabel} was not filed.`
      : summaries.filter((s) => s.status === "final").length === 0
        ? "No summary has been finalised yet."
        : `${summaries.filter((s) => s.status === "final").length} finalised summaries on file.`,
  });

  const csLate = cs.dueOn ? Date.parse(cs.dueOn) < Date.parse(today) : true;
  out.set("biennial_inventory", {
    suggests: csLate ? "finding" : "ok",
    evidence: cs.last
      ? `Last taken ${cs.last}${csLate ? " — past due" : ""}.`
      : "No controlled substance inventory has ever been recorded here.",
  });

  return out;
}
