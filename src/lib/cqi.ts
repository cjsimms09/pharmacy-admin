import "server-only";
import { and, gte, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { decryptText, encryptText } from "./crypto";
import { addDays, lastDayOfMonth } from "./dates";

export function rxNumbersOf(inc: { rxNumbersEnc: string | null }): string[] {
  if (!inc.rxNumbersEnc) return [];
  try {
    const v = JSON.parse(decryptText(inc.rxNumbersEnc));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return ["(unreadable — encryption key changed)"];
  }
}

export function encodeRxNumbers(raw: string): string | null {
  const list = raw.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return null;
  return encryptText(JSON.stringify(list));
}

export type EmployeeReview = { personId: string; reviewedOn: string | null; reviewedByPersonId: string | null };
export function employeeReviewsOf(inc: { employeeReviews: string }): EmployeeReview[] {
  try {
    const v = JSON.parse(inc.employeeReviews);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Incidents whose report was created inside the summary period. */
export async function incidentsInPeriod(periodStart: string, periodEnd: string) {
  return db.query.cqiIncidents.findMany({
    where: and(gte(schema.cqiIncidents.reportCreatedOn, periodStart), lte(schema.cqiIncidents.reportCreatedOn, periodEnd)),
    orderBy: (i, { asc }) => [asc(i.reportCreatedOn)],
  });
}

/**
 * CAPs to evaluate on this summary: K.A.R. 68-19-1 asks for "evaluation of the outcomes and
 * effectiveness of each corrective action plan from the summaries for the previous four months",
 * and the C-550 records a first and a second review. So: any incident with a CAP whose report was
 * created in the four months ending with this period, that has fewer than two reviews recorded.
 */
export async function capsToEvaluate(periodStart: string, periodEnd: string) {
  const [y, m] = periodStart.split("-").map(Number);
  const startMinus2 = m - 2 <= 0 ? `${y - 1}-${String(m - 2 + 12).padStart(2, "0")}-01` : `${y}-${String(m - 2).padStart(2, "0")}-01`;
  const candidates = await db.query.cqiIncidents.findMany({
    where: and(gte(schema.cqiIncidents.reportCreatedOn, startMinus2), lte(schema.cqiIncidents.reportCreatedOn, periodEnd)),
    orderBy: (i, { asc }) => [asc(i.reportCreatedOn)],
  });
  const reviews = await db.query.cqiCapReviews.findMany();
  return candidates
    .filter((i) => i.correctiveActionPlan && i.correctiveActionPlan.trim().length > 0)
    .map((i) => {
      const done = reviews.filter((r) => r.incidentId === i.id).sort((a, b) => a.reviewNumber - b.reviewNumber);
      return { incident: i, reviews: done, nextReviewNumber: done.length + 1 };
    });
}

export function periodFromDue(dueOn: string) {
  const [y, m] = dueOn.split("-").map(Number);
  const m1 = m - 2;
  const y1 = m1 <= 0 ? y - 1 : y;
  const mm1 = m1 <= 0 ? m1 + 12 : m1;
  return { periodStart: `${y1}-${String(mm1).padStart(2, "0")}-01`, periodEnd: lastDayOfMonth(y, m - 1) };
}

/** A write-up too short to satisfy the Board — an empty root cause analysis, or a one-line corrective action. */
export function isThin(rca: string | null, cap: string | null): boolean {
  return (rca ?? "").trim().length < 400 || (cap ?? "").trim().length < 400;
}

export const reviewStartDeadline = (reportCreatedOn: string) => addDays(reportCreatedOn, 7);
export const reviewCompleteDeadline = (reportCreatedOn: string) => addDays(reportCreatedOn, 30);
