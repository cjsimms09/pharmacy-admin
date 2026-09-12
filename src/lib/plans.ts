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
   * Out of scope because the Kansas legislature put it out of scope, which is not the same reason.
   *
   * I changed this to `true` on the strength of Rutledge v. PCMA, 592 U.S. 80 (2020) — unanimous that
   * ERISA does not preempt a state law setting the rate a PBM must pay a pharmacy, expressly including
   * as applied to self-funded plans. That case is good law and the 10th Circuit left it standing in
   * PCMA v. Mulready, which struck down network-design rules and distinguished Rutledge on rates.
   *
   * The owner corrected it: "Kansas SB 20 specifically exempted ERISA plans." He is right, and it is
   * the question I failed to ask. Rutledge says what a state *may* reach. SB 20 says what Kansas
   * *chose* to reach, and it wrote the carve-out into the statute: the floor is NADAC plus the greater
   * of $10.50 or the Medicaid professional dispensing fee, in the commercial market, for plans not
   * subject to ERISA preemption.
   *
   * So the distinction is load-bearing after all, and in the dangerous direction — over-including a
   * self-funded plan in a filing is what gets a schedule dismissed. It cannot be read off a claim, and
   * the site is right to keep refusing to guess it.
   */
  commercial_self_funded: {
    label: "Commercial — self-funded (ERISA)",
    inScope: false,
    why: "Kansas SB 20 sets its floor for the commercial market only where the plan is not subject to ERISA preemption. Rutledge v. PCMA (2020) holds a state could reach these plans; Kansas did not.",
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
  /*
   * Commercial, funding not established — and therefore out of scope, which is the safe direction.
   *
   * "Out of scope" here means "not yet shown to be in scope", not "shown to be out of it". Some of
   * these plans are fully insured and the floor does reach them; the register simply cannot say
   * which yet. Defaulting the other way would put self-funded ERISA plans into a Kansas filing,
   * and over-including one is what gets a whole schedule dismissed.
   *
   * What it does buy is everything that does not depend on funding: the plan is known to be
   * commercial rather than Part D, so MAC appeals can route it, the payer can be ranked, and the
   * 396 plans that were sitting at "not yet determined" stop reading as unexamined.
   */
  commercial_unknown_funding: {
    label: "Commercial — funding not established",
    inScope: false,
    why:
      "Known to be a commercial plan rather than Medicare, Medicaid or a card, which is what the BIN and PCN can " +
      "establish. Whether the employer bought insurance from a state-regulated carrier or funds the plan itself " +
      "under ERISA is a separate question, and only a Form 5500 or the plan document settles it. Until one does, " +
      "this plan is left out of any Kansas floor filing — not because it is known to be preempted, but because it " +
      "is not yet known not to be.",
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
  /**
   * What this plan actually pays for, so the classification can be read off its own claims.
   *
   * The owner: *"when trying to classify plans, it would be nice to see current claims we have for
   * that plan it might help me classify them (ie copay cards)"*. He is describing the real tell. A
   * manufacturer copay card shows one brand drug over and over — BIN 019158 / CNRX is Wegovy — while
   * a benefit plan shows the whole shop. Naming the drugs turns a BIN into something recognisable.
   */
  topDrugs: { name: string; claims: number }[];
  /**
   * Fills where this plan was the only payer, against fills where it shared one.
   *
   * The decisive fact for a card, and the one the owner's own correction turned on: DST/CNRX is on
   * 26 of its 28 claims the *only* payer on the fill, which is what a card is not supposed to look
   * like. A card sits on top of a plan and pays down what the patient was left owing, so it should
   * arrive as a second payer; where it is the sole payer it is acting as the payer of record and
   * belongs in what payers owe. A secondary that never appears alone is the opposite reading.
   */
  soleFills: number;
  sharedFills: number;
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
      columns: {
        bin: true, pcn: true, groupNumber: true, remitCents: true, copayCents: true, planType: true,
        itemName: true, rxNumber: true, fillNumber: true,
      },
    }),
  ]);

  /*
   * How many payers each fill had, so a plan can be asked whether it ever pays alone.
   *
   * Counted once over every paid claim rather than per plan: a fill billed to two payers is two
   * claim rows with the same prescription and fill number, so the number of rows sharing that key
   * *is* the number of payers. Built before the loop because each plan needs to look its own fills
   * up in it.
   */
  const payersOnFill = new Map<string, number>();
  for (const c of claims) {
    const k = `${c.rxNumber}|${c.fillNumber ?? 0}`;
    payersOnFill.set(k, (payersOnFill.get(k) ?? 0) + 1);
  }

  type Stat = {
    claims: number; receivedCents: number; underFeeClaims: number; planTypes: Set<string>;
    drugs: Map<string, number>; sole: number; shared: number;
  };
  const stats = new Map<string, Stat>();
  const add = (k: string, c: (typeof claims)[number]) => {
    let e = stats.get(k);
    if (!e) {
      e = { claims: 0, receivedCents: 0, underFeeClaims: 0, planTypes: new Set(), drugs: new Map(), sole: 0, shared: 0 };
      stats.set(k, e);
    }
    e.claims++;
    const got = receivedCents(c.remitCents, c.copayCents);
    e.receivedCents += got ?? 0;
    if (got !== null && got < 1050) e.underFeeClaims++;
    if (c.planType) e.planTypes.add(c.planType);
    /*
     * The drug as the claim named it, not tidied. Two spellings of one product count apart, which
     * is honest: this is here to be recognised by eye, and "Wegovy Pref Pen" and "WEGOVY 1 MG/0.5
     * ML PEN" both read as Wegovy to a pharmacist while a normaliser guessing they are the same
     * would eventually merge two products that are not.
     */
    const name = (c.itemName ?? "").trim();
    if (name) e.drugs.set(name, (e.drugs.get(name) ?? 0) + 1);
    if ((payersOnFill.get(`${c.rxNumber}|${c.fillNumber ?? 0}`) ?? 1) > 1) e.shared++;
    else e.sole++;
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
        /* Four is enough to recognise a plan by and short enough to read on a phone. */
        topDrugs: s
          ? [...s.drugs.entries()]
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .slice(0, 4)
              .map(([name, n]) => ({ name, claims: n }))
          : [],
        soleFills: s?.sole ?? 0,
        sharedFills: s?.shared ?? 0,
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
    /*
     * The rule is right; the sentence was not usable.
     *
     * The owner, blocked by it: "keeps giving me this error and not letting me classify a plan". The
     * old wording explained the *principle* at length — why the Kansas floor turns on this finding —
     * and never named the control to touch. He read it as the site refusing him rather than as a
     * field he had not filled, which is exactly what it looks like when the only failing case is an
     * untouched dropdown two fields above the button.
     *
     * So it now says the one thing to do first. The reason follows, in a sentence, because he does
     * audit and a rule with no reason attached is a rule somebody works around. What it must never
     * become is a rule that waves the claim through: this class is the difference between a filing
     * that stands and one that collapses when a PBM asks how it was established.
     */
    throw new Error(
      `Pick a source in "How this was established" — the dropdown just above the Record button — and say what it ` +
        `shows in "What it says". ` +
        `${CLASS_INFO[input.classification].label} is one of the four classes that decide whether the Kansas floor ` +
        `reaches this plan, so an appeal built on it has to name the Form 5500, the plan document, the employer's own ` +
        `answer, or who confirmed it. Medicare, Medicaid, workers' compensation and the cards need none of this — the ` +
        `claim itself says what they are.`,
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
