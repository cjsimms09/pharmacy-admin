import "server-only";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { query } from "./pioneer-sql";
import type { PioneerPlanRow } from "./plan-evidence";

/**
 * Reading PioneerRx's own answer to "what kind of plan is this".
 *
 * The site had classified nine plans out of two hundred and eleven, and the Kansas floor cannot
 * fire on a plan nobody has classified — so 1,436 claims and $191,569.70 of reimbursement sat
 * behind that one gap. Meanwhile PioneerRx, on the same machine, had been carrying a plan type on
 * these payers for years and nothing here had ever looked at it. This is that.
 *
 * ── Two sources, not one, because they are not worth the same ──
 *
 * `ThirdParty.ThirdPartyPlan` is the plan reference PioneerRx ships: 1,851 rows of BIN and PCN with
 * a plan name ("Bc/bs Kansas Pdp", "Careplus D Humana Pdp", "Cwa"), the processor behind it, and a
 * type. Nobody at this pharmacy typed any of it.
 *
 * `ThirdParty.ThirdParty` is this pharmacy's own third-party records — 286 of them — carrying
 * whatever type somebody here set when the payer was first billed. Right far more often than not,
 * but a person's answer rather than a document's.
 *
 * Both are stored, each row saying which it is, and `plan-evidence.ts` weighs them differently. A
 * feed that flattened them would have thrown away the only thing that makes one better than the
 * other.
 *
 * ── What this feed refuses to conclude ──
 *
 * "Standard" is PioneerRx's default. It is on GoodRx, on this pharmacy's own cash plan, and on
 * Bc/bs Kansas — three plans of three different kinds. It is stored verbatim because that is what
 * the database says, and it is worth exactly nothing as evidence; the reasoning is in
 * `plan-evidence.ts` beside the line that ignores it. The temptation to count the 535 September
 * claims sitting on a "Standard" plan as classified was the largest available piece of fiction in
 * this whole exercise, and it would have arrived with "PioneerRx" written next to it.
 *
 * ── Patient data ──
 *
 * Neither query names a patient column, and neither could: `pioneer-sql.ts` refuses a query that
 * names one and refuses `select *` outright. These two tables are payer reference data — a plan
 * name, a BIN, a processor. There is no person in them.
 */

/** PioneerRx's shipped plan reference: BIN, PCN, plan name, processor, type. */
const PLAN_FILE_SQL = `
  select p.BIN as bin, p.PCN as pcn, p.PlanName as planName, p.Processor as processor,
         p.CarrierCode as carrierCode, p.IsActive as isActive, t.ThirdPartyPlanTypeText as planType
  from ThirdParty.ThirdPartyPlan p
  left join ThirdParty.ThirdPartyPlanType t on t.ThirdPartyPlanTypeID = p.ThirdPartyPlanTypeID
  where p.BIN is not null and p.BIN <> ''`;

/**
 * The pharmacy's own third-party records.
 *
 * `ThirdParty.PlanType` is the richer of the two type tables — nine values against the plan file's
 * five, including "Government", "Medicare Part B" and "Cash/AR" — so it is the one read here, and
 * the plan name is picked up from whichever plan-file row the third party is linked to, because
 * "Maxorplus Super (upshaw)" is a name a person can recognise and "005377 (10000019)" is not.
 */
const PHARMACY_SQL = `
  select tp.BIN as bin, tp.PCN as pcn,
         coalesce(nullif(tpp.PlanName, ''), tp.ThirdPartyName) as planName,
         tpp.Processor as processor, tp.PlanGroupCode as carrierCode,
         case when tp.IsDeleted = 1 then 0 else 1 end as isActive,
         pt.PlanTypeText as planType
  from ThirdParty.ThirdParty tp
  left join ThirdParty.PlanType pt on pt.PlanTypeID = tp.PlanTypeID
  left join ThirdParty.ThirdPartyPlan tpp on tpp.ThirdPartyPlanID = tp.ThirdPartyPlanID
  where tp.BIN is not null and tp.BIN <> ''`;

const text = (v: unknown) => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

/**
 * Replaces the landing table with what PioneerRx says today.
 *
 * A wholesale replace rather than an upsert. This table holds no decision of anybody's — it is a
 * copy of another system's opinion, and a plan PioneerRx has deleted should stop being cited as
 * evidence rather than linger because nothing came along to overwrite it. Every finding built on it
 * lives in `plan_groups` with the sentence that produced it, so nothing is lost by rebuilding this.
 */
export async function pullPlanTypes(): Promise<{ planFile: number; pharmacy: number; typed: number }> {
  const readAt = new Date().toISOString();
  const rows: (typeof schema.pioneerPlanTypes.$inferInsert)[] = [];

  for (const [source, sql] of [["plan_file", PLAN_FILE_SQL], ["pharmacy", PHARMACY_SQL]] as const) {
    const r = await query(sql, {}, 20_000);
    for (const row of r.rows) {
      const bin = text(row.bin);
      if (!bin) continue;
      rows.push({
        id: newId(),
        bin,
        // Upper-cased on the way in. PioneerRx holds "kspartd" and "KSPARTD" as separate records
        // for the same route, and a lookup that distinguishes them finds neither.
        pcn: (text(row.pcn) ?? "").toUpperCase(),
        source,
        planName: text(row.planName),
        processor: text(row.processor),
        carrierCode: text(row.carrierCode),
        planType: text(row.planType),
        isActive: Number(row.isActive ?? 1) === 1,
        readAt,
      });
    }
  }

  await db.delete(schema.pioneerPlanTypes);
  for (let i = 0; i < rows.length; i += 200) await db.insert(schema.pioneerPlanTypes).values(rows.slice(i, i + 200));

  const planFile = rows.filter((r) => r.source === "plan_file").length;
  // What is actually worth having: rows carrying a type that is not PioneerRx's "Standard" default.
  const typed = rows.filter((r) => r.planType && !/^(standard|documentary)$/i.test(r.planType)).length;
  return { planFile, pharmacy: rows.length - planFile, typed };
}

const norm = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();

/**
 * Everything PioneerRx holds that bears on one BIN and PCN.
 *
 * A row with no PCN stands for the whole BIN, and is included — that is how the plan file records a
 * processor running one line of business, and dropping it would lose "Bc/bs Federal Employees" on
 * BIN 610239 and "Careplus D Humana Pdp" on 015581, which are two of the clearest answers in the
 * file. `plan-evidence.ts` still requires the rows it uses to agree, so a blank-PCN row cannot
 * outvote the specific ones; it can only speak where they are silent.
 */
export function pioneerRowsFor(all: PioneerPlanRow[], bin: string | null, pcn: string | null): PioneerPlanRow[] {
  const b = norm(bin);
  if (!b) return [];
  const p = norm(pcn);
  const mine = all.filter((r) => norm(r.bin) === b);
  const exact = mine.filter((r) => norm(r.pcn) === p);
  return exact.length ? exact : mine.filter((r) => norm(r.pcn) === "");
}

/** The whole landing table, in the shape the pure evidence code takes. Read once per page. */
export async function allPioneerPlanRows(): Promise<PioneerPlanRow[]> {
  const rows = await db.query.pioneerPlanTypes.findMany({
    columns: { bin: true, pcn: true, source: true, planName: true, processor: true, planType: true, isActive: true },
  });
  return rows;
}
