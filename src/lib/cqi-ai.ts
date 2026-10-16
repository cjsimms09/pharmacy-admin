import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { describeError, writeRcaCap } from "./ai";
import { audit } from "./audit";

/** Staff names are replaced by roles before anything is sent for drafting. */
export async function roleNames() {
  const people = await db.query.people.findMany();
  return people.map((p) => ({
    name: `${p.firstName} ${p.lastName}`,
    role: p.isPic ? "the PIC" : p.role === "pharmacist" ? "a pharmacist" : p.role === "technician" ? "a technician" : "a staff member",
  }));
}

/**
 * Write (or strengthen) one incident's root cause analysis and corrective action plan.
 * Prior incidents of the same type go along, so a repeat gets a stronger plan than the one that
 * did not hold — which is what the Board is looking for on the second and third occurrence.
 */
export async function writeIncidentAnalysis(incId: string, extraContext: string | null, user: { id: string; name: string }) {
  const inc = await db.query.cqiIncidents.findFirst({ where: eq(schema.cqiIncidents.id, incId) });
  if (!inc) throw new Error("Incident not found.");
  const similar = await db.query.cqiIncidents.findMany({
    where: and(eq(schema.cqiIncidents.type, inc.type), ne(schema.cqiIncidents.id, incId)),
    orderBy: (i, { desc }) => [desc(i.reportCreatedOn)],
    limit: 5,
  });
  const reviews = await db.query.cqiCapReviews.findMany();
  const out = await writeRcaCap(
    {
      type: inc.type,
      typeOther: inc.typeOther,
      description: inc.description,
      reachedPatient: inc.reachedPatient,
      existingRca: inc.rootCauseAnalysis,
      existingCap: inc.correctiveActionPlan,
      extraContext,
      priorSimilar: similar.map((p) => ({
        description: p.description,
        correctiveActionPlan: p.correctiveActionPlan,
        effective: reviews.filter((r) => r.incidentId === p.id).sort((a, b) => b.reviewNumber - a.reviewNumber)[0]?.effective ?? null,
      })),
    },
    await roleNames(),
    { userId: user.id, userName: user.name },
  );
  await db
    .update(schema.cqiIncidents)
    .set({
      rcaBeforeAi: inc.rootCauseAnalysis,
      capBeforeAi: inc.correctiveActionPlan,
      rootCauseAnalysis: out.rootCauseAnalysis,
      correctiveActionPlan: out.correctiveActionPlan,
      aiState: "done",
      aiError: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.cqiIncidents.id, incId));
}

/**
 * Draft the analysis in the background after an incident is logged, so logging it at the counter is
 * the only step. Failures are recorded on the incident rather than thrown — nobody is watching.
 */
export async function writeIncidentAnalysisInBackground(incId: string, user: { id: string; name: string }) {
  try {
    await writeIncidentAnalysis(incId, null, user);
    await audit({ action: "cqi.incident.ai_auto_write", userId: user.id, userName: user.name, entity: "cqi_incident", entityId: incId });
  } catch (e) {
    const msg = describeError(e);
    await db.update(schema.cqiIncidents).set({ aiState: "failed", aiError: msg }).where(eq(schema.cqiIncidents.id, incId));
    await audit({ action: "cqi.incident.ai_auto_write_failed", userId: user.id, userName: user.name, entity: "cqi_incident", entityId: incId, details: msg });
  }
}
