"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/crypto";
import { todayIso } from "@/lib/dates";
import { engineRefresh } from "@/lib/engine/run";

/**
 * The answers on Compliance. Each writes through the library that owns the record (an attestation is signed, a
 * month is signed off only once every excursion is explained, a discrepancy is a row in the log), refreshes the
 * engine and returns to the tab. A blank field is a refusal with its reason on the screen, never a default.
 */
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function back(fd: FormData, error?: string): string {
  const tab = str(fd, "tab") || "register";
  return `/v2/compliance?tab=${tab}${error ? `&error=${encodeURIComponent(error)}` : ""}`;
}

async function finish(fd: FormData, reason: string, error?: string): Promise<void> {
  if (!error) await engineRefresh(reason);
  revalidatePath("/v2/compliance");
  revalidatePath("/v2/today");
  const { redirect } = await import("next/navigation");
  redirect(back(fd, error));
}

/** A duty closed by the pharmacist's own statement, signed with a typed name. */
export async function attestDuty(fd: FormData): Promise<void> {
  const user = await requireManager();
  const obligationId = str(fd, "obligationId");
  const periodKey = str(fd, "periodKey");
  const statement = str(fd, "statement");
  const typedName = str(fd, "typedName");
  if (!obligationId || !periodKey) return finish(fd, "", "Which duty, and which period?");
  if (!statement) return finish(fd, "", "An attestation needs the statement it attests.");
  if (typedName.length < 3) return finish(fd, "", "Type your name to sign it.");
  const { attest } = await import("@/lib/compliance-status");
  try {
    await attest(obligationId, periodKey, statement, { id: user.id, name: user.name, role: user.role }, { typedName, intent: true });
  } catch (e) {
    return finish(fd, "", e instanceof Error ? e.message : String(e));
  }
  await audit({ action: "compliance.attest", userId: user.id, userName: user.name, entity: "obligation", entityId: obligationId, details: `${periodKey}: ${statement.slice(0, 160)}` });
  return finish(fd, "answer: duty attested");
}

/** Whether a duty applies to this pharmacy at all. */
export async function answerDuty(fd: FormData): Promise<void> {
  const user = await requireManager();
  const obligationId = str(fd, "obligationId");
  const applies = str(fd, "applies");
  if (!obligationId || !["yes", "no"].includes(applies)) return finish(fd, "", "Say whether it applies.");
  const { answerObligation } = await import("@/lib/compliance-status");
  const r = await answerObligation(obligationId, applies === "yes", { id: user.id, name: user.name });
  await audit({ action: "compliance.answer", userId: user.id, userName: user.name, entity: "obligation", entityId: obligationId, details: `${r.title}: ${applies === "yes" ? "applies" : "does not apply"}` });
  return finish(fd, "answer: duty answered");
}

/** An out-of-range reading explained, in the pharmacist's words, against that reading. */
export async function explainReading(fd: FormData): Promise<void> {
  const user = await requireManager();
  const readingId = str(fd, "readingId");
  const note = str(fd, "note");
  if (!readingId) return finish(fd, "", "Which reading?");
  if (note.length < 4) return finish(fd, "", "Say what happened and what was done.");
  const reading = await db.query.tempReadings.findFirst({ where: eq(schema.tempReadings.id, readingId) });
  if (!reading) return finish(fd, "", "That reading is no longer there.");
  await db.insert(schema.tempNotes).values({ id: newId(), sensorId: reading.sensorId, periodKey: reading.periodKey, readingId, note, reviewed: false, writtenBy: user.name });
  await audit({ action: "temps.explain", userId: user.id, userName: user.name, entity: "temp_reading", entityId: readingId, details: note.slice(0, 200) });
  return finish(fd, "answer: reading explained");
}

/** A sensor's month signed off: only once every excursion in it is explained. */
export async function signOffMonth(fd: FormData): Promise<void> {
  const user = await requireManager();
  const sensorId = str(fd, "sensorId");
  const periodKey = str(fd, "periodKey");
  if (!sensorId || !periodKey) return finish(fd, "", "Which sensor, which month?");
  const { monthSummary } = await import("@/lib/imonnit");
  const s = await monthSummary(sensorId, periodKey);
  if (!s) return finish(fd, "", "No readings for that sensor and month.");
  if (!s.allExplained) return finish(fd, "", `Every out-of-range reading needs a note before ${periodKey} can be signed off: ${s.unexplainedCount} still unexplained.`);
  if (s.reviewed) return finish(fd, "", `${periodKey} is already signed off for ${s.sensorName}.`);
  const statement = `Reviewed by ${user.name}. ${s.readings} readings, ${s.excursions} out of range, each explained above.`;
  await db.insert(schema.tempNotes).values({ id: newId(), sensorId, periodKey, readingId: null, note: statement, reviewed: true, writtenBy: user.name });
  await audit({ action: "temps.signoff", userId: user.id, userName: user.name, entity: "temp_sensor", entityId: sensorId, details: `${periodKey}: ${statement}` });
  return finish(fd, "answer: month signed off");
}

/** A controlled-substance discrepancy logged the day it is found. */
export async function logDiscrepancy(fd: FormData): Promise<void> {
  const user = await requireManager();
  const drugName = str(fd, "drugName");
  const schedule = str(fd, "schedule");
  const narrative = str(fd, "narrative");
  const discoveredOn = str(fd, "discoveredOn") || todayIso();
  const expected = str(fd, "expected");
  const counted = str(fd, "counted");
  if (!drugName || !narrative) return finish(fd, "", "Name the drug and say what was found.");
  if (!["CII", "CIII", "CIV", "CV", "non_controlled", "unknown"].includes(schedule)) return finish(fd, "", "Which schedule?");
  const toThousandths = (v: string) => (v === "" ? null : Math.round(Number(v) * 1000));
  if ((expected && !Number.isFinite(Number(expected))) || (counted && !Number.isFinite(Number(counted)))) return finish(fd, "", "Expected and counted are numbers of units.");
  const id = newId();
  await db.insert(schema.csDiscrepancies).values({
    id,
    discoveredOn,
    drugName,
    ndc11: str(fd, "ndc11") || null,
    strength: str(fd, "strength") || null,
    schedule: schedule as (typeof schema.csDiscrepancies.$inferInsert)["schedule"],
    expectedThousandths: toThousandths(expected),
    countedThousandths: toThousandths(counted),
    unit: str(fd, "unit") || "EA",
    narrative,
    createdBy: user.name,
  });
  await audit({ action: "discrepancy.log", userId: user.id, userName: user.name, entity: "cs_discrepancy", entityId: id, details: `${discoveredOn} ${schedule} ${drugName}: ${narrative.slice(0, 160)}` });
  return finish(fd, "answer: discrepancy logged");
}

/** A discrepancy resolved, with whether the DEA was told. A significant loss still needs DEA Form 106 filed by hand. */
export async function resolveDiscrepancy(fd: FormData): Promise<void> {
  const user = await requireManager();
  const id = str(fd, "id");
  const resolution = str(fd, "resolution");
  if (!id || resolution.length < 4) return finish(fd, "", "Say how it was resolved.");
  await db.update(schema.csDiscrepancies).set({ resolution, resolvedOn: todayIso(), reportedToDea: str(fd, "reportedToDea") === "yes" }).where(eq(schema.csDiscrepancies.id, id));
  await audit({ action: "discrepancy.resolve", userId: user.id, userName: user.name, entity: "cs_discrepancy", entityId: id, details: resolution.slice(0, 200) });
  return finish(fd, "answer: discrepancy resolved");
}
