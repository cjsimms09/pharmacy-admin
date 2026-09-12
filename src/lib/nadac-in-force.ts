import "server-only";
import { db } from "@/db";
import type { NadacRecord } from "./reimbursement-rules";

/**
 * The NADAC row in force for every fill, straight from the database.
 *
 * Two pages used to answer "what was NADAC on the day this was dispensed" by loading NADAC rows
 * into memory and searching them: one loaded every row the table has ever held (a million and a
 * half on a year of weekly files: twenty seconds), the other every row for every NDC dispensed.
 * SQLite can answer the question itself, per distinct (NDC, date) pair among the claims, with one
 * index seek each: the newest effective date at or before the fill date. Thirty thousand claims
 * come back as a few thousand rows in well under a second, and the result grows with the
 * pharmacy's dispensing rather than with the federal file.
 *
 * What comes back is exactly the set `nadacInForce()` would pick from, so the callers' pure
 * reasoning is unchanged.
 */
export async function nadacRecordsForClaims(opts: { since?: string; status?: "paid" } = {}): Promise<NadacRecord[]> {
  const client = (db as unknown as { $client: { execute: (q: { sql: string; args: (string | number)[] }) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const where = ["c.ndc11 is not null"];
  const args: (string | number)[] = [];
  if (opts.status) {
    where.push("c.status = ?");
    args.push(opts.status);
  }
  if (opts.since) {
    where.push("c.date_filled >= ?");
    args.push(opts.since);
  }
  const r = await client.execute({
    sql:
      "select n.ndc11, n.unit_micros, n.pricing_unit, n.effective_on, n.file_as_of " +
      "from (select distinct ndc11, date_filled from claims c where " + where.join(" and ") + ") c " +
      "join nadac_prices n on n.ndc11 = c.ndc11 and n.effective_on = " +
      "(select max(p.effective_on) from nadac_prices p where p.ndc11 = c.ndc11 and p.effective_on <= c.date_filled) " +
      "group by n.ndc11, n.effective_on",
    args,
  });
  return r.rows.map((row) => ({
    ndc11: String(row.ndc11),
    unitMicros: Number(row.unit_micros),
    pricingUnit: String(row.pricing_unit ?? "EA") as NadacRecord["pricingUnit"],
    effectiveOn: String(row.effective_on),
    fileAsOf: String(row.file_as_of ?? row.effective_on),
  }));
}
