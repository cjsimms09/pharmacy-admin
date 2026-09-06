import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { PlanClass } from "@/db/schema";
import { newId } from "./crypto";
import { receivedCents } from "./money";
import type { PlanScope } from "./reimbursement-rules";

/**
 * Deciding which plans the Kansas floor can actually reach.
 *
 * Under SB 20 this is the whole question. NADAC plus the greater of $10.50 or the Medicaid
 * dispensing fee is a statutory floor, so verifying it needs no contract, no rate schedule and
 * no MAC list — only the quantity dispensed, the NADAC in force, what was received, and whether
 * the plan is one the state can regulate.
 *
 * That last part is not on the claim. PioneerRx sends a plan type, but it describes how the
 * claim was processed rather than how the plan is funded, and the two disagree: Medicare
 * contract numbers appear under "Standard", and a discount card is indistinguishable from
 * commercial insurance at the claim level. So the determination is made once per plan, by a
 * person, with its evidence recorded — and inherited by every claim on that plan.
 */

/** Whether the state floor reaches a plan of this class, and why. */
export const CLASS_INFO: Record<PlanClass, { label: string; inScope: boolean; why: string }> = {
  commercial_fully_insured: {
    label: "Commercial — fully insured",
    inScope: true,
    why: "A state-regulated insurer bears the risk, so Kansas can set the floor and the Insurance Department can enforce it.",
  },
  commercial_self_funded: {
    label: "Commercial — self-funded (ERISA)",
    inScope: false,
    why: "The employer bears the risk and ERISA preempts state regulation of the plan. The floor does not reach it.",
  },
  governmental: {
    label: "Governmental plan",
    inScope: true,
    why: "A city, county, school district or state plan is excluded from ERISA by definition, so preemption does not apply even when the plan is self-funded.",
  },
  church_plan: {
    label: "Church plan",
    inScope: true,
    why: "Exempt from ERISA unless it has elected in, so preemption does not apply.",
  },
  medicare: { label: "Medicare", inScope: false, why: "Part D and MA-PD are federally governed; state pricing rules do not apply." },
  medicaid: { label: "Medicaid", inScope: false, why: "Priced under the state plan, not by this floor." },
  workers_comp: { label: "Workers' compensation", inScope: false, why: "Priced under the workers' compensation fee schedule." },
  discount_card: { label: "Discount card / cash", inScope: false, why: "Not insurance. There is no plan for the state to regulate and no payer to owe a floor, and a low payment on one is the price rather than a shortfall." },
  copay_card: {
    label: "Manufacturer copay / savings card",
    inScope: false,
    why:
      "Not a plan. It sits on top of a plan and pays down what the patient was left owing on a brand drug, so it " +
      "arrives as a second claim on a fill that already has a payer. Nothing owes a floor, and it is not a payer to " +
      "be ranked — it covers whatever is put to it, which flatters the brand plan underneath it.",
  },
  unknown: { label: "Not yet determined", inScope: false, why: "Nobody has established how this plan is funded. Investigate before treating it either way." },
};

/** Maps a plan class onto the scope the verification gate understands. */
export function planScopeOf(cls: PlanClass): PlanScope {
  switch (cls) {
    case "commercial_fully_insured":
    case "governmental":
    case "church_plan":
      return "commercial_non_erisa";
    case "commercial_self_funded":
      return "commercial_erisa";
    case "medicare":
      return "part_d";
    case "medicaid":
      return "medicaid";
    default:
      return "unknown";
  }
}

/** The natural key of a plan: who processes it, under which group. */
export const planKey = (bin: string | null, groupNumber: string | null) => `${bin ?? ""}|${groupNumber ?? ""}`;

/**
 * Creates a register row for every plan appearing in the claims, leaving existing rows alone.
 *
 * Deliberately does not classify anything. A first guess written into the register would be
 * indistinguishable from a determination a person made, and the whole value of this table is
 * that its contents were established rather than assumed.
 */
export async function syncPlanGroups(): Promise<{ added: number; total: number }> {
  const claims = await db.query.claims.findMany({
    columns: { bin: true, groupNumber: true, payerLabel: true, pbmName: true },
  });
  const existing = await db.query.planGroups.findMany({ columns: { bin: true, groupNumber: true } });
  const have = new Set(existing.map((e) => planKey(e.bin, e.groupNumber)));

  const seen = new Map<string, { bin: string | null; groupNumber: string | null; payerLabel: string | null; pbmName: string | null }>();
  for (const c of claims) {
    const k = planKey(c.bin, c.groupNumber);
    if (!seen.has(k)) seen.set(k, { bin: c.bin, groupNumber: c.groupNumber, payerLabel: c.payerLabel, pbmName: c.pbmName });
  }

  let added = 0;
  for (const [k, v] of seen) {
    if (have.has(k)) continue;
    await db.insert(schema.planGroups).values({ id: newId(), ...v });
    added++;
  }
  return { added, total: seen.size };
}

export type PlanRow = {
  id: string;
  bin: string | null;
  groupNumber: string | null;
  payerLabel: string | null;
  pbmName: string | null;
  sponsorName: string | null;
  classification: PlanClass;
  basis: string | null;
  sourceUrl: string | null;
  decidedOn: string | null;
  claims: number;
  receivedCents: number;
  underFeeClaims: number;
  planTypes: string[];
};

/** The register, with each plan's claim volume so the unresolved ones can be worked by size. */
export async function planRegister(): Promise<PlanRow[]> {
  const [groups, claims] = await Promise.all([
    db.query.planGroups.findMany(),
    db.query.claims.findMany({
      where: eq(schema.claims.status, "paid"),
      columns: { bin: true, groupNumber: true, remitCents: true, copayCents: true, planType: true },
    }),
  ]);
  const stats = new Map<string, { claims: number; receivedCents: number; underFeeClaims: number; planTypes: Set<string> }>();
  for (const c of claims) {
    const k = planKey(c.bin, c.groupNumber);
    let e = stats.get(k);
    if (!e) { e = { claims: 0, receivedCents: 0, underFeeClaims: 0, planTypes: new Set() }; stats.set(k, e); }
    e.claims++;
    const got = receivedCents(c.remitCents, c.copayCents);
    e.receivedCents += got ?? 0;
    if (got !== null && got < 1050) e.underFeeClaims++;
    if (c.planType) e.planTypes.add(c.planType);
  }

  return groups
    .map((g) => {
      const s = stats.get(planKey(g.bin, g.groupNumber));
      return {
        id: g.id,
        bin: g.bin,
        groupNumber: g.groupNumber,
        payerLabel: g.payerLabel,
        pbmName: g.pbmName,
        sponsorName: g.sponsorName,
        classification: g.classification,
        basis: g.basis,
        sourceUrl: g.sourceUrl,
        decidedOn: g.decidedOn,
        claims: s?.claims ?? 0,
        receivedCents: s?.receivedCents ?? 0,
        underFeeClaims: s?.underFeeClaims ?? 0,
        planTypes: s ? [...s.planTypes].sort() : [],
      };
    })
    .sort((a, b) => b.claims - a.claims);
}

/**
 * Records a determination.
 *
 * A classification other than unknown must state how it was established. An unsourced
 * determination is the thing that collapses a filing under questioning, so the register will not
 * hold one.
 */
export async function classifyPlan(
  id: string,
  input: { classification: PlanClass; sponsorName?: string; basis?: string; sourceUrl?: string; notes?: string },
  user: { id: string; name: string },
): Promise<void> {
  const basis = (input.basis ?? "").trim();
  if (input.classification !== "unknown" && basis.length < 10) {
    throw new Error("Say how this was established — a Form 5500 filing, the plan document, or who confirmed it. A determination without a basis cannot be relied on.");
  }
  await db
    .update(schema.planGroups)
    .set({
      classification: input.classification,
      sponsorName: (input.sponsorName ?? "").trim() || null,
      basis: basis || null,
      sourceUrl: (input.sourceUrl ?? "").trim() || null,
      notes: (input.notes ?? "").trim() || null,
      decidedBy: input.classification === "unknown" ? null : user.name,
      decidedOn: input.classification === "unknown" ? null : new Date().toISOString().slice(0, 10),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.planGroups.id, id));
}

/** How far the determination has got, and how much money is still unclassified. */
export async function registerProgress() {
  const rows = await planRegister();
  const by = (f: (r: PlanRow) => boolean) => rows.filter(f);
  const sum = (rs: PlanRow[]) => rs.reduce((s, r) => s + r.claims, 0);

  const decided = by((r) => r.classification !== "unknown");
  const inScope = by((r) => CLASS_INFO[r.classification].inScope);
  const unknown = by((r) => r.classification === "unknown");

  return {
    plans: rows.length,
    decided: decided.length,
    unknown: unknown.length,
    claimsDecided: sum(decided),
    claimsUnknown: sum(unknown),
    inScopePlans: inScope.length,
    inScopeClaims: sum(inScope),
    inScopeUnderFee: inScope.reduce((s, r) => s + r.underFeeClaims, 0),
    unknownByVolume: unknown.slice(0, 10),
  };
}

/** Claims whose plan is in scope for the floor — the set a filing would be drawn from. */
export async function inScopeClaims() {
  const groups = await db.query.planGroups.findMany();
  const inScope = new Set(
    groups.filter((g) => CLASS_INFO[g.classification].inScope).map((g) => planKey(g.bin, g.groupNumber)),
  );
  const claims = await db.query.claims.findMany({ where: eq(schema.claims.status, "paid") });
  return claims.filter((c) => inScope.has(planKey(c.bin, c.groupNumber)));
}

/**
 * Classifies a plan found by the BIN and group on a claim, rather than by a register row id.
 *
 * The register is keyed on id because that is what a list of rows has. The place somebody is
 * actually standing when the answer occurs to them is a claim — or the payer tree, which shows the
 * BIN and group and nothing else. Asking them to carry a group number to another screen is how it
 * never gets done.
 *
 * The basis requirement is not relaxed. An unsourced ERISA determination is the thing that
 * collapses a filing under questioning, so anything the floor turns on still has to say how it was
 * established. The exception is a copay or discount card, where the evidence is the claim itself:
 * the payer's own name on it is what says so, and that is recorded as the basis.
 */
export async function classifyPlanByKey(
  bin: string | null,
  groupNumber: string | null,
  classification: PlanClass,
  user: { id: string; name: string },
  basis?: string,
): Promise<{ claims: number; created: boolean }> {
  const key = (b: string | null, g: string | null) => `${(b ?? "").trim()}|${(g ?? "").trim().toUpperCase()}`;
  const rows = await db.query.planGroups.findMany();
  const row = rows.find((r) => key(r.bin, r.groupNumber) === key(bin, groupNumber)) ?? null;

  const selfEvident = classification === "copay_card" || classification === "discount_card";
  const said = (basis ?? "").trim();
  const useBasis = said || (selfEvident ? `The payer on the claim identifies itself as one: ${row?.payerLabel ?? bin ?? "on the claim"}. Recorded by ${user.name}.` : "");

  if (!row) {
    /*
     * A plan billed but never registered.
     *
     * The register is built by sweeping the claims, so this only happens for a plan seen since the
     * last sweep. Creating the row here rather than refusing means the answer is not lost for the
     * sake of an ordering nobody outside this code knows about.
     */
    const { newId } = await import("./crypto");
    const claims = await db.query.claims.findMany({ columns: { id: true, bin: true, groupNumber: true } });
    const mine = claims.filter((c) => key(c.bin, c.groupNumber) === key(bin, groupNumber));
    if (classification !== "unknown" && useBasis.length < 10) {
      throw new Error("Say how this was established — a Form 5500 filing, the plan document, or who confirmed it. A determination without a basis cannot be relied on.");
    }
    await db.insert(schema.planGroups).values({
      id: newId(),
      bin,
      groupNumber,
      classification,
      basis: useBasis || null,
      decidedBy: classification === "unknown" ? null : user.name,
      decidedOn: classification === "unknown" ? null : new Date().toISOString().slice(0, 10),
    });
    return { claims: mine.length, created: true };
  }

  await classifyPlan(row.id, { classification, basis: useBasis }, user);
  const claims = await db.query.claims.findMany({ columns: { id: true, bin: true, groupNumber: true } });
  return { claims: claims.filter((c) => key(c.bin, c.groupNumber) === key(bin, groupNumber)).length, created: false };
}
