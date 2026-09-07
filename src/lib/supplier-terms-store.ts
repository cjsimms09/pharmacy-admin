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

/**
 * The programme that prices a purchase, where a supplier runs more than one at once.
 *
 * McKesson runs two: a compliance ladder that pays on the items its catalogue marks as contract
 * items, and a purchase-ratio ladder that pays on generics generally. Only the first can price a
 * particular line, because only the first says which lines it applies to — so where several are in
 * force, the one whose eligibility is the catalogue's own rebate flag wins, and the latest
 * effective date breaks any remaining tie. Returning whichever happened to sort first would have
 * meant a generic priced against a ladder that pays nothing below a seventy-five percent ratio.
 */
export async function currentRebateProgram(supplierId: string, on = todayIso()): Promise<{ row: RebateProgramRow; terms: RebateTermsT } | null> {
  const rows = (await rebateProgramsFor(supplierId)).filter(
    (r) => r.effectiveFrom <= on && (r.effectiveTo === null || r.effectiveTo >= on),
  );
  const withTerms = rows
    .map((row) => ({ row, terms: readRebateTerms(row.termsJson) }))
    .filter((x): x is { row: RebateProgramRow; terms: RebateTermsT } => x.terms !== null);
  if (withTerms.length === 0) return null;
  return (
    withTerms
      .sort((a, b) => {
        const flag = (x: typeof a) => (x.terms.eligibility === "catalog_rebate_flag" ? 0 : 1);
        return flag(a) - flag(b) || b.row.effectiveFrom.localeCompare(a.row.effectiveFrom);
      })[0] ?? null
  );
}

/** Every programme in force on a date — a supplier can run more than one. */
export async function rebateProgramsInForce(supplierId: string, on = todayIso()): Promise<{ row: RebateProgramRow; terms: RebateTermsT }[]> {
  return (await rebateProgramsFor(supplierId))
    .filter((r) => r.effectiveFrom <= on && (r.effectiveTo === null || r.effectiveTo >= on))
    .map((row) => ({ row, terms: readRebateTerms(row.termsJson) }))
    .filter((x): x is { row: RebateProgramRow; terms: RebateTermsT } => x.terms !== null);
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

  /*
   * One supplier can run more than one programme at once, so a version is identified by its name
   * as well as its date.
   *
   * McKesson pays on two ladders: a generic compliance rate and a generic purchase ratio, both
   * effective the same month. Keyed on the date alone, filing the second silently replaced the
   * first — and the one lost was the compliance ladder, the only one that actually pays. Nothing
   * said so; the supplier's card simply showed one programme where there should have been two.
   */
  const same = await db.query.supplierRebatePrograms.findFirst({
    where: and(
      eq(schema.supplierRebatePrograms.supplierId, supplierId),
      eq(schema.supplierRebatePrograms.effectiveFrom, input.effectiveFrom),
      eq(schema.supplierRebatePrograms.name, name),
    ),
  });
  const json = JSON.stringify(parsed.data);
  if (same) {
    await db
      .update(schema.supplierRebatePrograms)
      .set({ name, termsJson: json, termsVersion: TERMS_VERSION, notes: input.notes?.trim() || null, documentId: input.documentId ?? same.documentId, updatedAt: new Date().toISOString() })
      .where(eq(schema.supplierRebatePrograms.id, same.id));
    return same.id;
  }
  // Close only the earlier version *of this programme*, not every programme the supplier runs.
  await db
    .update(schema.supplierRebatePrograms)
    .set({ effectiveTo: dayBefore(input.effectiveFrom), updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.supplierRebatePrograms.supplierId, supplierId),
        eq(schema.supplierRebatePrograms.name, name),
        isNull(schema.supplierRebatePrograms.effectiveTo),
        lt(schema.supplierRebatePrograms.effectiveFrom, input.effectiveFrom),
      ),
    );
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

/**
 * Removing a rebate programme or a return policy that should not be there.
 *
 * Versioned records are normally never deleted — a rebate paid last quarter was earned under last
 * quarter's ladder, and losing it means losing the ability to explain a payment. But that argument
 * only holds for records of something that happened. A duplicate created by a filing bug is a
 * record of nothing, and leaving it in place with no way out means the supplier's page shows six
 * ladders where there are three and no arithmetic on the screen can be trusted.
 *
 * So it deletes, it is audited by the caller, and it says what it removed.
 */
export async function deleteRebateProgram(id: string): Promise<{ name: string; effectiveFrom: string }> {
  const row = await db.query.supplierRebatePrograms.findFirst({ where: eq(schema.supplierRebatePrograms.id, id) });
  if (!row) throw new Error("That programme is no longer on file.");
  await db.delete(schema.supplierRebatePrograms).where(eq(schema.supplierRebatePrograms.id, id));
  return { name: row.name, effectiveFrom: row.effectiveFrom };
}

export async function deleteReturnPolicy(id: string): Promise<{ name: string; effectiveFrom: string }> {
  const row = await db.query.supplierReturnPolicies.findFirst({ where: eq(schema.supplierReturnPolicies.id, id) });
  if (!row) throw new Error("That policy is no longer on file.");
  await db.delete(schema.supplierReturnPolicies).where(eq(schema.supplierReturnPolicies.id, id));
  return { name: row.name, effectiveFrom: row.effectiveFrom };
}

/**
 * Programmes that are the same ladder filed twice, so a page can offer to clear them up.
 *
 * Two rows count as duplicates when they hold the same terms and take effect on the same day. That
 * is a filing accident, not two agreements — and it is worth finding rather than waiting for
 * somebody to notice that the supplier's page has grown a second copy of everything.
 */
export async function duplicateRebatePrograms(supplierId: string): Promise<{ keep: RebateProgramRow; drop: RebateProgramRow[] }[]> {
  const rows = await rebateProgramsFor(supplierId);
  const groups = new Map<string, RebateProgramRow[]>();
  for (const r of rows) {
    const key = `${r.effectiveFrom}|${r.termsJson}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: { keep: RebateProgramRow; drop: RebateProgramRow[] }[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    /*
     * Keep the most recently filed copy.
     *
     * These duplicates exist because the same report was read twice under names that differed only
     * in the spelling of the supplier — "McKesson generics (OneStop) rebate" against "Mckesson …".
     * The terms are identical, so which row survives changes nothing about the arithmetic; what it
     * changes is the name on the card, and the newest copy carries the current one. Nothing else in
     * the site points at a programme by id, so there is no reference to preserve.
     */
    const sorted = [...g].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    out.push({ keep: sorted[0], drop: sorted.slice(1) });
  }
  return out;
}

/**
 * Records that a supplier pays no rebates at all, or takes that answer back.
 *
 * "Nobody has typed the terms in" and "there are none" look identical to every screen unless one of
 * them is written down, and they want opposite things: the first is work outstanding, the second is
 * a finished question. IPC and IPD pay nothing here, and their absence was being reported forever.
 *
 * No arithmetic changes — a supplier with no ladder was already compared at gross. What changes is
 * that the site stops calling a settled fact a gap.
 */
export async function setNoRebates(supplierId: string, none: boolean, user: { name: string }): Promise<string> {
  const supplier = await db.query.suppliers.findFirst({ where: eq(schema.suppliers.id, supplierId) });
  if (!supplier) return "That supplier is not on the register.";
  if (none && (await rebateProgramsFor(supplierId)).length > 0) {
    return `${supplier.name} has a rebate schedule on file. Remove it first — saying they pay nothing while a ladder still discounts their prices would leave two answers standing.`;
  }
  await db
    .update(schema.suppliers)
    .set(
      none
        ? { noRebates: true, noRebatesBy: user.name, noRebatesAt: new Date().toISOString() }
        : { noRebates: false, noRebatesBy: null, noRebatesAt: null },
    )
    .where(eq(schema.suppliers.id, supplierId));
  return none
    ? `Recorded: ${supplier.name} pays no rebates. Their prices are compared as they stand, and the site will stop asking for a schedule.`
    : `${supplier.name}'s rebate terms are outstanding again.`;
}
