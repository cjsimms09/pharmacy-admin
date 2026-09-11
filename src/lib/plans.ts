import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { PlanClass } from "@/db/schema";
import { planKey, planLookup } from "./plan-key";
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
  /*
   * A reimbursement floor reaches a self-funded plan. The Supreme Court settled it, unanimously.
   *
   * This said the opposite — "ERISA preempts state regulation of the plan. The floor does not reach
   * it" — and on that basis held the majority of the pharmacy's commercial volume out of scope. It
   * also made the fully-insured/self-funded question the gate on the whole classification backlog,
   * because that question needs a plan document or a Form 5500 and cannot be read off a claim.
   *
   * Rutledge v. PCMA, 592 U.S. 80 (2020), 8-0: Arkansas Act 900 required PBMs to reimburse pharmacies
   * at or above acquisition cost, and ERISA did not preempt it — expressly including as applied to
   * self-funded ERISA plans. A law that regulates the *rate* a PBM pays is cost regulation, not plan
   * administration, and has no impermissible connection with an ERISA plan.
   *
   * Kansas SB 20 is that kind of law: every Kansas pharmacy reimbursed at or above NADAC, plus a
   * dispensing fee, in force 1 July 2026.
   *
   * The 10th Circuit — which covers Kansas — did strike down much of Oklahoma's PBM act in PCMA v.
   * Mulready, 78 F.4th 1183 (10th Cir. 2023), cert. denied 30 June 2025. But Mulready is about
   * *network design*: any-willing-pharmacy, mail-order incentives, network adequacy. It distinguished
   * Rutledge and left state authority over rates standing.
   *
   * So the floor applies, and the distinction this class exists to draw does not decide it. The class
   * is kept because it is a true fact about a plan and matters elsewhere — appeals procedure and who
   * enforces are not the same question as whether the rate is owed.
   *
   * This is a reading of two cases, not advice. It is worth putting past the PSAO or an attorney
   * before an appeal is written on it.
   */
  commercial_self_funded: {
    label: "Commercial — self-funded (ERISA)",
    inScope: true,
    why: "The employer bears the risk, but a reimbursement floor regulates the rate rather than the plan — Rutledge v. PCMA (2020, 8-0) upheld exactly this against a self-funded ERISA plan, and Mulready left state authority over rates standing. Enforcement runs through the PBM, not the Insurance Department.",
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

/** The natural key of a plan and the lookup that applies it, from plan-key.ts so the floor review can share them. */
export { planKey, planLookup } from "./plan-key";
const norm = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();

/**
 * Creates a register row for every plan appearing in the claims, leaving existing rows alone.
 *
 * Deliberately does not classify anything. A first guess written into the register would be
 * indistinguishable from a determination a person made, and the whole value of this table is
 * that its contents were established rather than assumed.
 */
export async function syncPlanGroups(): Promise<{ added: number; total: number }> {
  const claims = await db.query.claims.findMany({
    columns: { bin: true, pcn: true, groupNumber: true, payerLabel: true, pbmName: true, cashPlan: true },
  });
  const existing = await db.query.planGroups.findMany();
  const have = new Set(existing.map((e) => planKey(e.bin, e.pcn, e.groupNumber)));
  const lookup = planLookup(existing);

  const seen = new Map<string, { bin: string | null; pcn: string | null; groupNumber: string | null; payerLabel: string | null; pbmName: string | null }>();
  for (const c of claims) {
    if (c.cashPlan) continue;
    const k = planKey(c.bin, c.pcn, c.groupNumber);
    if (!seen.has(k)) seen.set(k, { bin: c.bin, pcn: c.pcn, groupNumber: c.groupNumber, payerLabel: c.payerLabel, pbmName: c.pbmName });
  }

  let added = 0;
  for (const [k, v] of seen) {
    if (have.has(k)) continue;
    /*
     * A row for a PCN whose BIN and group were classified before the PCN was kept starts unknown
     * and says so: the earlier decision still governs its claims through the fallback, and the
     * note is the prompt to confirm it for this PCN — which is exactly the case where the earlier
     * decision may be wrong.
     */
    const prior = lookup({ bin: v.bin, pcn: null, groupNumber: v.groupNumber });
    const notes = prior && prior.classification !== "unknown" && norm(prior.pcn) === "" ? `BIN ${v.bin ?? "—"} group ${v.groupNumber ?? "—"} was classified ${prior.classification} before the PCN was kept; confirm it for PCN ${v.pcn ?? "(blank)"}.` : null;
    await db.insert(schema.planGroups).values({ id: newId(), ...v, notes });
    added++;
  }
  return { added, total: seen.size };
}

export type PlanRow = {
  id: string;
  bin: string | null;
  pcn: string | null;
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
  const { held } = await import("./held");
  return held("plan-register", loadPlanRegister);
}

async function loadPlanRegister(): Promise<PlanRow[]> {
  const [groups, claims] = await Promise.all([
    db.query.planGroups.findMany(),
    db.query.claims.findMany({
      where: eq(schema.claims.status, "paid"),
      columns: { bin: true, pcn: true, groupNumber: true, remitCents: true, copayCents: true, planType: true },
    }),
  ]);
  type Stat = { claims: number; receivedCents: number; underFeeClaims: number; planTypes: Set<string> };
  const stats = new Map<string, Stat>();
  const add = (k: string, c: (typeof claims)[number]) => {
    let e = stats.get(k);
    if (!e) { e = { claims: 0, receivedCents: 0, underFeeClaims: 0, planTypes: new Set() }; stats.set(k, e); }
    e.claims++;
    const got = receivedCents(c.remitCents, c.copayCents);
    e.receivedCents += got ?? 0;
    if (got !== null && got < 1050) e.underFeeClaims++;
    if (c.planType) e.planTypes.add(c.planType);
  };
  for (const c of claims) {
    add(planKey(c.bin, c.pcn, c.groupNumber), c);
    // A row with no PCN stands for every PCN under its BIN and group, so it is measured on all of them.
    add(`${norm(c.bin)}|*|${norm(c.groupNumber)}`, c);
  }

  return groups
    .map((g) => {
      const s = stats.get(norm(g.pcn) === "" ? `${norm(g.bin)}|*|${norm(g.groupNumber)}` : planKey(g.bin, g.pcn, g.groupNumber));
      return {
        id: g.id,
        bin: g.bin,
        pcn: g.pcn,
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
/**
 * Which classifications somebody has to justify, and which the claim justifies itself.
 *
 * The basis requirement exists because an unsourced ERISA determination collapses under
 * questioning: it is the finding that decides whether the Kansas floor reaches a plan, and it will
 * be argued about. Applying that rule to every class was over-reach, and it stopped the work it was
 * meant to protect — being refused when marking an obvious Part D plan as Medicare teaches somebody
 * that the register is not worth using.
 *
 * So it is required for the four that decide whether the floor applies: the three that put a plan
 * in scope, and the ERISA exclusion that takes it out. The rest identify themselves on the claim —
 * a Part D BIN, a state Medicaid processor, a card that names itself — and the payer's own name is
 * recorded as the basis.
 */
/**
 * The four ways this finding is ever actually established, offered rather than typed.
 *
 * The requirement was right and the blank box was not: a rule that has to be satisfied before the
 * work can proceed, answered by free text with a ten-character minimum, is a rule people learn to
 * write "checked it" against. These are the sources an appeal can stand on, so they are the
 * choices — and the detail beside them is what makes the record checkable a year later.
 */
export const BASIS_KINDS = [
  { key: "form_5500", label: "A Form 5500 filing", detail: "plan year and what the Schedule A shows" },
  { key: "plan_document", label: "The plan document", detail: "which section, and what it says" },
  { key: "employer", label: "The employer's own answer", detail: "who said it, and when" },
  { key: "confirmed", label: "Confirmed by", detail: "who confirmed it, and how" },
] as const;

export type BasisKind = (typeof BASIS_KINDS)[number]["key"];

/** The basis as it is stored: the source, then what was actually seen. */
export function composeBasis(kind: string | null | undefined, detail: string | null | undefined): string {
  const k = BASIS_KINDS.find((b) => b.key === (kind ?? "").trim());
  const d = (detail ?? "").trim();
  if (!k) return d;
  return d ? `${k.label} — ${d}` : k.label;
}

export function needsBasis(cls: PlanClass): boolean {
  return cls === "commercial_fully_insured" || cls === "commercial_self_funded" || cls === "governmental" || cls === "church_plan";
}

export async function classifyPlan(
  id: string,
  input: { classification: PlanClass; sponsorName?: string; basis?: string; sourceUrl?: string; notes?: string },
  user: { id: string; name: string },
): Promise<void> {
  const basis = (input.basis ?? "").trim();
  if (needsBasis(input.classification) && basis.length < 10) {
    throw new Error(
      `Marking a plan as ${CLASS_INFO[input.classification].label} decides whether the Kansas floor reaches it, and ` +
        "that is the finding an appeal turns on — so say how it was established: a Form 5500 filing, the plan " +
        "document, the employer's own answer, or who confirmed it. Medicare, Medicaid, workers' compensation and " +
        "cards need no basis; the claim itself says what they are.",
    );
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
  const lookup = planLookup(groups);
  const claims = await db.query.claims.findMany({ where: eq(schema.claims.status, "paid") });
  return claims.filter((c) => {
    const g = lookup({ bin: c.bin, pcn: c.pcn, groupNumber: c.groupNumber });
    return g !== undefined && CLASS_INFO[g.classification].inScope;
  });
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
  pcn: string | null,
  groupNumber: string | null,
  classification: PlanClass,
  user: { id: string; name: string },
  basis?: string,
): Promise<{ claims: number; created: boolean }> {
  const key = (b: string | null, p: string | null, g: string | null) => planKey(b, p, g);
  const rows = await db.query.planGroups.findMany();
  const row = rows.find((r) => key(r.bin, r.pcn, r.groupNumber) === key(bin, pcn, groupNumber)) ?? null;

  const selfEvident = !needsBasis(classification);
  const said = (basis ?? "").trim();
  const useBasis =
    said ||
    (selfEvident
      ? `The payer on the claim identifies itself as one: ${row?.payerLabel ?? bin ?? "on the claim"}. Recorded by ${user.name}.`
      : "");

  if (!row) {
    /*
     * A plan billed but never registered.
     *
     * The register is built by sweeping the claims, so this only happens for a plan seen since the
     * last sweep. Creating the row here rather than refusing means the answer is not lost for the
     * sake of an ordering nobody outside this code knows about.
     */
    const { newId } = await import("./crypto");
    const claims = await db.query.claims.findMany({ columns: { id: true, bin: true, pcn: true, groupNumber: true } });
    const mine = claims.filter((c) => key(c.bin, c.pcn, c.groupNumber) === key(bin, pcn, groupNumber));
    if (needsBasis(classification) && useBasis.length < 10) {
      throw new Error(
        `Marking a plan as ${CLASS_INFO[classification].label} decides whether the Kansas floor reaches it, so say how ` +
          "it was established. Medicare, Medicaid, workers' compensation and cards need no basis.",
      );
    }
    await db.insert(schema.planGroups).values({
      id: newId(),
      bin,
      pcn,
      groupNumber,
      classification,
      basis: useBasis || null,
      decidedBy: classification === "unknown" ? null : user.name,
      decidedOn: classification === "unknown" ? null : new Date().toISOString().slice(0, 10),
    });
    return { claims: mine.length, created: true };
  }

  await classifyPlan(row.id, { classification, basis: useBasis }, user);
  const claims = await db.query.claims.findMany({ columns: { id: true, bin: true, pcn: true, groupNumber: true } });
  return { claims: claims.filter((c) => key(c.bin, c.pcn, c.groupNumber) === key(bin, pcn, groupNumber)).length, created: false };
}
