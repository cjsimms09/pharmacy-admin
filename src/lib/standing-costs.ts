import "server-only";
import { eq, isNull, or, lte, and, gte } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
export { shareOfMonth, accruedCents, standingLines, type StandingLine } from "./standing-math";

/**
 * A cost that is the same every month, known before its bill: payroll, rent, the loan.
 *
 * Stored as the owner typed it — one figure a month, from a month, to a month or open-ended — and
 * turned into the month's share by the pure arithmetic in `standing-math.ts`. Nothing here is
 * inferred from history: a vendor that bills the same amount every month is not a standing cost
 * until the owner says so, because the site cannot tell a habit from a contract.
 */
export type StandingCost = typeof schema.standingCosts.$inferSelect;

export async function allStandingCosts(): Promise<StandingCost[]> {
  return db.query.standingCosts.findMany({ orderBy: [schema.standingCosts.name] });
}

/** The costs that apply to a month: started by it and not ended before it. */
export async function standingCostsIn(month: string): Promise<StandingCost[]> {
  return db.query.standingCosts.findMany({
    where: and(lte(schema.standingCosts.fromMonth, month), or(isNull(schema.standingCosts.toMonth), gte(schema.standingCosts.toMonth, month))),
    orderBy: [schema.standingCosts.name],
  });
}

export async function addStandingCost(input: { name: string; amountCents: number; categoryId: string | null; vendorId: string | null; fromMonth: string; toMonth: string | null; notes: string | null }, user: { id: string }): Promise<string> {
  const id = newId();
  await db.insert(schema.standingCosts).values({ id, ...input, createdBy: user.id });
  return id;
}

export async function updateStandingCost(id: string, input: { name: string; amountCents: number; categoryId: string | null; vendorId: string | null; fromMonth: string; toMonth: string | null; notes: string | null }): Promise<void> {
  await db.update(schema.standingCosts).set({ ...input, updatedAt: new Date().toISOString() }).where(eq(schema.standingCosts.id, id));
}

/** Ends a cost at a month rather than deleting it, so past accounts keep their figure. */
export async function endStandingCost(id: string, lastMonth: string): Promise<void> {
  await db.update(schema.standingCosts).set({ toMonth: lastMonth, updatedAt: new Date().toISOString() }).where(eq(schema.standingCosts.id, id));
}

export async function deleteStandingCost(id: string): Promise<void> {
  await db.delete(schema.standingCosts).where(eq(schema.standingCosts.id, id));
}
