import "server-only";
import { and, eq, isNull, lt } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { todayIso } from "./dates";
import {
  RebateTerms,
  ReturnTerms,
  TERMS_VERSION,
  readRebateTerms,
  readReturnTerms,
  type RebateTermsT,
  type ReturnTermsT,
} from "./supplier-terms";

/**
 * Where a supplier's rebate schedule and return policy are kept, and how a new one replaces the old.
 *
 * Versioned by row rather than edited in place. A schedule that changes on 1 January is a new row
 * from that date; the previous row is closed the day before and kept, because the rebate paid for
 * December was earned under December's terms and a purchasing comparison run over last quarter
 * has to use last quarter's ladder. Nothing here is ever deleted.
 */

export type RebateProgramRow = typeof schema.supplierRebatePrograms.$inferSelect;
export type ReturnPolicyRow = typeof schema.supplierReturnPolicies.$inferSelect;

/** The calendar day before an ISO date. */
function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export async function rebateProgramsFor(supplierId: string): Promise<RebateProgramRow[]> {
  return db.query.supplierRebatePrograms.findMany({
    where: eq(schema.supplierRebatePrograms.supplierId, supplierId),
    orderBy: (p, { desc }) => [desc(p.effectiveFrom)],
  });
}

export async function returnPoliciesFor(supplierId: string): Promise<ReturnPolicyRow[]> {
  return db.query.supplierReturnPolicies.findMany({
    where: eq(schema.supplierReturnPolicies.supplierId, supplierId),
    orderBy: (p, { desc }) => [desc(p.effectiveFrom)],
  });
}

/** The row in force on a date: the latest effective-from on or before it, not yet ended. */
function inForce<T extends { effectiveFrom: string; effectiveTo: string | null }>(rows: T[], on: string): T | null {
  return rows.filter((r) => r.effectiveFrom <= on && (r.effectiveTo === null || r.effectiveTo >= on)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
}

export async function currentRebateProgram(supplierId: string, on = todayIso()): Promise<{ row: RebateProgramRow; terms: RebateTermsT } | null> {
  const row = inForce(await rebateProgramsFor(supplierId), on);
  if (!row) return null;
  const terms = readRebateTerms(row.termsJson);
  return terms ? { row, terms } : null;
}

export async function currentReturnPolicy(supplierId: string, on = todayIso()): Promise<{ row: ReturnPolicyRow; terms: ReturnTermsT } | null> {
  const row = inForce(await returnPoliciesFor(supplierId), on);
  if (!row) return null;
  const terms = readReturnTerms(row.termsJson);
  return terms ? { row, terms } : null;
}

export type SaveTermsInput = { name: string; effectiveFrom: string; notes?: string | null; documentId?: string | null };

/**
 * Records a rebate schedule from a date, closing whatever was current before it.
 *
 * The terms are validated against the shape before anything is written; a schedule that does not
 * fit is refused with the reason rather than stored as prose. A row already current from an
 * earlier date is ended the day before this one starts. A row current from the *same* date is
 * replaced, because that is a correction, not a new version.
 */
export async function saveRebateProgram(supplierId: string, input: SaveTermsInput, terms: unknown, user: { name: string }): Promise<string> {
  const parsed = RebateTerms.safeParse(terms);
  if (!parsed.success) throw new Error(`The rebate terms do not fit the shape: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const name = input.name.trim();
  if (!name) throw new Error("Give the programme the name the supplier uses for it.");
  if (!isIsoDate(input.effectiveFrom)) throw new Error("Give the date the schedule takes effect.");

  const same = await db.query.supplierRebatePrograms.findFirst({
    where: and(eq(schema.supplierRebatePrograms.supplierId, supplierId), eq(schema.supplierRebatePrograms.effectiveFrom, input.effectiveFrom)),
  });
  const json = JSON.stringify(parsed.data);
  if (same) {
    await db
      .update(schema.supplierRebatePrograms)
      .set({ name, termsJson: json, termsVersion: TERMS_VERSION, notes: input.notes?.trim() || null, documentId: input.documentId ?? same.documentId, updatedAt: new Date().toISOString() })
      .where(eq(schema.supplierRebatePrograms.id, same.id));
    return same.id;
  }
  await db
    .update(schema.supplierRebatePrograms)
    .set({ effectiveTo: dayBefore(input.effectiveFrom), updatedAt: new Date().toISOString() })
    .where(and(eq(schema.supplierRebatePrograms.supplierId, supplierId), isNull(schema.supplierRebatePrograms.effectiveTo), lt(schema.supplierRebatePrograms.effectiveFrom, input.effectiveFrom)));
  const id = newId();
  await db.insert(schema.supplierRebatePrograms).values({
    id,
    supplierId,
    name,
    effectiveFrom: input.effectiveFrom,
    termsVersion: TERMS_VERSION,
    termsJson: json,
    documentId: input.documentId ?? null,
    notes: input.notes?.trim() || null,
    createdBy: user.name,
  });
  return id;
}

export async function saveReturnPolicy(supplierId: string, input: SaveTermsInput, terms: unknown, user: { name: string }): Promise<string> {
  const parsed = ReturnTerms.safeParse(terms);
  if (!parsed.success) throw new Error(`The return terms do not fit the shape: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const name = input.name.trim() || "Return policy";
  if (!isIsoDate(input.effectiveFrom)) throw new Error("Give the date the policy takes effect.");

  const same = await db.query.supplierReturnPolicies.findFirst({
    where: and(eq(schema.supplierReturnPolicies.supplierId, supplierId), eq(schema.supplierReturnPolicies.effectiveFrom, input.effectiveFrom)),
  });
  const json = JSON.stringify(parsed.data);
  if (same) {
    await db
      .update(schema.supplierReturnPolicies)
      .set({ name, termsJson: json, termsVersion: TERMS_VERSION, notes: input.notes?.trim() || null, documentId: input.documentId ?? same.documentId, updatedAt: new Date().toISOString() })
      .where(eq(schema.supplierReturnPolicies.id, same.id));
    return same.id;
  }
  await db
    .update(schema.supplierReturnPolicies)
    .set({ effectiveTo: dayBefore(input.effectiveFrom), updatedAt: new Date().toISOString() })
    .where(and(eq(schema.supplierReturnPolicies.supplierId, supplierId), isNull(schema.supplierReturnPolicies.effectiveTo), lt(schema.supplierReturnPolicies.effectiveFrom, input.effectiveFrom)));
  const id = newId();
  await db.insert(schema.supplierReturnPolicies).values({
    id,
    supplierId,
    name,
    effectiveFrom: input.effectiveFrom,
    termsVersion: TERMS_VERSION,
    termsJson: json,
    documentId: input.documentId ?? null,
    notes: input.notes?.trim() || null,
    createdBy: user.name,
  });
  return id;
}

export type TermsSummary = {
  rebate: { name: string; effectiveFrom: string; terms: RebateTermsT } | null;
  returns: { name: string; effectiveFrom: string; terms: ReturnTermsT } | null;
};

/** What is in force today for every supplier, in one read, for the supplier cards. */
export async function termsSummaryBySupplier(on = todayIso()): Promise<Map<string, TermsSummary>> {
  const [rebates, returns] = await Promise.all([db.query.supplierRebatePrograms.findMany(), db.query.supplierReturnPolicies.findMany()]);
  const out = new Map<string, TermsSummary>();
  const get = (id: string) => {
    let e = out.get(id);
    if (!e) {
      e = { rebate: null, returns: null };
      out.set(id, e);
    }
    return e;
  };
  const byRebate = new Map<string, RebateProgramRow[]>();
  for (const r of rebates) byRebate.set(r.supplierId, [...(byRebate.get(r.supplierId) ?? []), r]);
  for (const [supplierId, rows] of byRebate) {
    const row = inForce(rows, on);
    const terms = row ? readRebateTerms(row.termsJson) : null;
    if (row && terms) get(supplierId).rebate = { name: row.name, effectiveFrom: row.effectiveFrom, terms };
  }
  const byReturn = new Map<string, ReturnPolicyRow[]>();
  for (const r of returns) byReturn.set(r.supplierId, [...(byReturn.get(r.supplierId) ?? []), r]);
  for (const [supplierId, rows] of byReturn) {
    const row = inForce(rows, on);
    const terms = row ? readReturnTerms(row.termsJson) : null;
    if (row && terms) get(supplierId).returns = { name: row.name, effectiveFrom: row.effectiveFrom, terms };
  }
  return out;
}
