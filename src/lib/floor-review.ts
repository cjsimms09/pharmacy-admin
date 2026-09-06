import { receivedCents, isPricingUnit } from "./money";
import {
  verifyClaim,
  SB20_MIN_DISPENSING_FEE_CENTS,
  type CheckId,
  type ClaimForFloor,
  type NadacRecord,
  type PlanScope,
  type Verdict,
} from "./reimbursement-rules";

/**
 * Running the statutory floor over every claim on file, and saying where the pharmacy stands.
 *
 * The floor engine was written, tested and then never called by anything. That is the worst state
 * for a piece of compliance software to be in: it looks finished, it passes its tests, and it has
 * never once told anybody a fact about their own business.
 *
 * ── The distinction this file exists to make ──
 *
 * A claim that does not produce a filing is one of two completely different things, and lumping
 * them together is what makes a reimbursement report useless.
 *
 * Out of scope: the floor genuinely does not apply. Filled before 1 July 2026, a Part D or
 * Medicaid plan, a reversal, a compound, a 340B dispensing. Nothing to fix and no money behind
 * it. These should be counted and then forgotten about.
 *
 * Blocked: the floor might well apply and something is stopping us knowing. The plan has not been
 * classified, no NADAC is loaded for that week, the export carries no unit of measure. Every one
 * of these has an action behind it, and — crucially — a number, because a claim blocked only on
 * plan classification can still be priced. "Forty-three claims worth $612 are waiting on eleven
 * plans nobody has classified" is a morning's work with a figure attached. "43 excluded" is not.
 *
 * So blockers are ranked by the money that would become filable if they were cleared, and each
 * one carries the thing to do about it.
 */

/** What a failed check means: nothing to be done, or something to be done. */
const FIXABLE: Record<CheckId, boolean> = {
  fill_date_in_scope: false, // The date is the date.
  plan_in_scope: true, // Only when the reason is "not yet determined" — narrowed below.
  claim_not_reversed: false,
  payment_received: true,
  no_later_adjustment: false,
  not_compound: false,
  not_340b: false,
  nadac_available: true,
  unit_of_measure_agrees: true,
  quantity_known: true,
  shortfall_material: false, // Paid at or above the floor is a good outcome, not a blocker.
};

const BLOCKER_ACTION: Partial<Record<CheckId, { label: string; action: string; href: string }>> = {
  plan_in_scope: {
    label: "The plan has not been classified",
    action:
      "Decide once, per plan, whether it is fully insured, self-funded, governmental, a church plan, Medicare, " +
      "Medicaid or a discount card. Every claim on that plan inherits the answer for ever, so this is a one-off " +
      "afternoon and it is the single highest-leverage task here.",
    href: "/plans",
  },
  nadac_available: {
    label: "No NADAC price in force on the fill date",
    action:
      "Load the CMS weekly file published around that week. Today's file carries only today's prices — where a " +
      "price has changed since, the earlier one is gone from it and has to come from the archive.",
    href: "/nadac",
  },
  unit_of_measure_agrees: {
    label: "The unit of measure is missing or disagrees with NADAC",
    action:
      "The claims export needs the unit of measure, and it has to mean the same thing NADAC means. Pricing each " +
      "against millilitres is wrong by orders of magnitude, so it is refused rather than approximated.",
    href: "/reports",
  },
  quantity_known: {
    label: "No dispensed quantity",
    action: "Add the quantity column to the claims export. Without it a claim cannot be priced at all.",
    href: "/reports",
  },
  payment_received: {
    label: "Nothing recorded as received",
    action:
      "The export needs both the amount paid and the patient pay amount — the two together are what the pharmacy " +
      "actually received, and leaving the copay out makes every shortfall read larger than it is.",
    href: "/reports",
  },
};

export type ReviewedClaim = {
  claimId: string;
  rxNumber: string;
  dateFilled: string;
  ndc11: string | null;
  itemName: string | null;
  payer: string | null;
  bin: string | null;
  groupNumber: string | null;
  receivedCents: number | null;
  floorCents: number | null;
  shortfallCents: number | null;
  verdict: Verdict;
  /** The fixable checks this claim failed. Empty where it is filable or genuinely out of scope. */
  blockedBy: CheckId[];
};

export type Blocker = {
  id: CheckId;
  label: string;
  action: string;
  href: string;
  /** Claims held back by this, whether or not anything else also holds them back. */
  claims: number;
  /** Claims where this is the *only* thing in the way — clear it and they become filable. */
  onlyThis: number;
  /** The shortfall behind those, where it can already be computed. The size of the prize. */
  onlyThisCents: number;
};

export type FloorReview = {
  examined: number;
  /** The floor genuinely does not apply. Counted, then forgotten about. */
  outOfScope: number;
  /** Paid at or above the floor. The good outcome, and worth showing so the report is believable. */
  paidAtOrAbove: number;
  filable: ReviewedClaim[];
  filableCents: number;
  blocked: ReviewedClaim[];
  /** Ranked by the money that would become filable if cleared. */
  blockers: Blocker[];
  /** Assumptions this review is making because the data cannot say. Never hidden. */
  caveats: string[];
  settings: {
    ksMedicaidDispensingFeeCents: number | null;
    materialityCents: number;
    dispensingFeeUsedCents: number;
  };
};

const DEFAULT_MATERIALITY_CENTS = 100;

/*
 * The natural key of a plan, and the scope a classification implies.
 *
 * Restated here rather than imported, because the register that owns them reaches the database
 * and this module must not: everything a filing asserts is decided in this file, so it has to be
 * runnable — and checkable by hand — with nothing behind it. The plan register's own tests hold
 * the same two facts, so a change to either would fail there.
 */
const planKey = (bin: string | null, groupNumber: string | null) => `${bin ?? ""}|${groupNumber ?? ""}`;

const SCOPE_OF: Record<string, PlanScope> = {
  commercial_fully_insured: "commercial_non_erisa",
  governmental: "commercial_non_erisa",
  church_plan: "commercial_non_erisa",
  commercial_self_funded: "commercial_erisa",
  medicare: "part_d",
  medicaid: "medicaid",
};

/** The parts of a claim row this needs, so the reviewer can be tested without a database. */
export type ClaimRow = {
  id: string;
  rxNumber: string;
  dateFilled: string;
  ndc11: string | null;
  itemName: string | null;
  payerLabel: string | null;
  pbmName: string | null;
  bin: string | null;
  groupNumber: string | null;
  quantityThousandths: number | null;
  quantityUnit: string | null;
  remitCents: number | null;
  copayCents: number | null;
};

export type PlanRow = { bin: string | null; groupNumber: string | null; classification: string | null };

/**
 * The whole review, as a pure function.
 *
 * Everything a filing would assert is decided here, so it can be checked by hand and tested
 * without a database. `floorReview` below is only the part that goes and fetches things.
 */
export function reviewClaims(
  claims: ClaimRow[],
  plans: PlanRow[],
  records: NadacRecord[],
  opts: { ksMedicaidDispensingFeeCents: number | null; materialityCents: number },
): FloorReview {
  const { ksMedicaidDispensingFeeCents, materialityCents } = opts;
  const classBy = new Map(plans.map((g) => [planKey(g.bin, g.groupNumber), g.classification]));

  const reviewed: ReviewedClaim[] = [];
  for (const c of claims) {
    // A claim with no NDC cannot be priced against anything and is not a floor question.
    if (!c.ndc11) continue;

      const cls = classBy.get(planKey(c.bin, c.groupNumber)) ?? undefined;
    const got = receivedCents(c.remitCents, c.copayCents);

    const forFloor: ClaimForFloor = {
      rxNumber: c.rxNumber,
      dateFilled: c.dateFilled,
      ndc11: c.ndc11,
      quantityThousandths: c.quantityThousandths,
      // The unit as the claim spells it, normalised the same way NADAC's is. A unit this does
      // not recognise stays null, which fails the check rather than guessing at a comparison.
      quantityUnit: c.quantityUnit && isPricingUnit(c.quantityUnit)
        ? (c.quantityUnit.trim().toUpperCase() as ClaimForFloor["quantityUnit"])
        : null,
      paidCents: got,
      /*
       * Three flags the export does not carry.
       *
       * Passing false is assuming in the pharmacy's favour, which is exactly what this codebase
       * refuses to do silently — so it is not silent. Each one is stated as a caveat on the
       * review and printed wherever the review is, and the fix is a column on the export rather
       * than a judgement here.
       */
      reversed: false,
      adjustedAfterPayment: false,
      isCompound: false,
      is340B: false,
      planScope: (cls ? SCOPE_OF[cls] : undefined) ?? "unknown",
    };

    const verdict = verifyClaim(forFloor, records, { ksMedicaidDispensingFeeCents, materialityCents });

    /*
     * What is actually holding this claim back — and two traps that both came out of the tests.
     *
     * The first: a permanent exclusion is dispositive. A claim filled in June is out of scope
     * whatever else is wrong with it, and it would also fail the NADAC check, because no NADAC
     * exists for a week the statute did not cover. Counting that as "blocked on NADAC" would put
     * it on a worklist and send somebody looking for a file that could never help.
     *
     * The second: "the scope is unknown" and "nobody has decided" are different. A discount card
     * and a workers' compensation plan both resolve to no scope the floor reaches — but they have
     * been classified, and the answer is no. Only a plan with no row at all, or one explicitly
     * left as unknown, is a task. Treating a classified discount card as an open question would
     * put it on the list for ever, since deciding it again changes nothing.
     */
    const permanentlyOut = verdict.filable ? [] : verdict.failed.filter((f) => !FIXABLE[f.id] && f.id !== "shortfall_material");
    const planUndetermined = cls === undefined || cls === "unknown";
    const blockedBy =
      verdict.filable || permanentlyOut.length > 0
        ? []
        : verdict.failed
            .filter((f) => FIXABLE[f.id])
            .filter((f) => f.id !== "plan_in_scope" || planUndetermined)
            .map((f) => f.id);

    reviewed.push({
      claimId: c.id,
      rxNumber: c.rxNumber,
      dateFilled: c.dateFilled,
      ndc11: c.ndc11,
      itemName: c.itemName,
      payer: c.payerLabel ?? c.pbmName,
      bin: c.bin,
      groupNumber: c.groupNumber,
      receivedCents: got,
      floorCents: verdict.floor?.floorCents ?? null,
      shortfallCents: verdict.shortfallCents,
      verdict,
      blockedBy,
    });
  }

  const filable = reviewed.filter((r) => r.verdict.filable);
  const blocked = reviewed.filter((r) => !r.verdict.filable && r.blockedBy.length > 0);

  /*
   * Paid at or above the floor: filable on every count except that nothing is owed.
   *
   * Shown deliberately. A report that only ever lists problems reads as a machine looking for
   * them; one that says "1,840 claims were paid correctly and 12 were not" is the one somebody
   * believes when it does find something.
   */
  const paidAtOrAbove = reviewed.filter(
    (r) =>
      !r.verdict.filable &&
      r.blockedBy.length === 0 &&
      r.verdict.failed.length === 1 &&
      r.verdict.failed[0].id === "shortfall_material",
  ).length;

  const outOfScope = reviewed.length - filable.length - blocked.length - paidAtOrAbove;

  const blockers: Blocker[] = [];
  for (const [id, meta] of Object.entries(BLOCKER_ACTION) as [CheckId, (typeof BLOCKER_ACTION)[CheckId]][]) {
    if (!meta) continue;
    const hit = blocked.filter((r) => r.blockedBy.includes(id));
    if (hit.length === 0) continue;
    const only = hit.filter((r) => r.blockedBy.length === 1);
    blockers.push({
      id,
      label: meta.label,
      action: meta.action,
      href: meta.href,
      claims: hit.length,
      onlyThis: only.length,
      onlyThisCents: only.reduce((n, r) => n + Math.max(0, r.shortfallCents ?? 0), 0),
    });
  }
  // Money first: the blocker with the largest recoverable sum behind it is the one to clear on a
  // Tuesday morning, and it is very often not the one holding back the most claims.
  blockers.sort((a, b) => b.onlyThisCents - a.onlyThisCents || b.onlyThis - a.onlyThis);

  const caveats = [
    "Claims from the daily transaction report have their reversals applied, and reversed claims are left out. " +
      "Claims from the one-row-per-fill export carry no reversal indicator and are assumed not reversed; a reversed " +
      "one would show as a shortfall that is not one.",
    "It carries no compound or 340B indicator either, and neither is priced against NADAC. Ask for both columns.",
    "Amounts are what the plan adjudicated, taken from the dispensing system, rather than what a remittance " +
      "confirms arrived. That is the payer's own figure, which is fair evidence — but a matched remittance is " +
      "stronger, and a later takeback would not show here.",
  ];

  return {
    examined: reviewed.length,
    outOfScope,
    paidAtOrAbove,
    filable,
    filableCents: filable.reduce((n, r) => n + Math.max(0, r.shortfallCents ?? 0), 0),
    blocked,
    blockers,
    caveats,
    settings: {
      ksMedicaidDispensingFeeCents,
      materialityCents,
      dispensingFeeUsedCents: Math.max(SB20_MIN_DISPENSING_FEE_CENTS, ksMedicaidDispensingFeeCents ?? 0),
    },
  };
}

/** Loads what the review needs and hands it to the pure reviewer above. */
export async function floorReview(): Promise<FloorReview> {
  const { db, schema } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { getSettings } = await import("./settings");
  const [claims, plans, s] = await Promise.all([
    // Paid claims only. A reversed claim is money the plan took back; pricing it against the
    // floor would report a shortfall on a claim the pharmacy was never paid for.
    db.query.claims.findMany({ where: eq(schema.claims.status, "paid"), orderBy: (c, { asc }) => [asc(c.dateFilled)] }),
    db.query.planGroups.findMany(),
    getSettings(),
  ]);

  /*
   * The prices for the drugs on these claims, and no others.
   *
   * This read the entire federal NADAC file — every NDC it has ever carried, at every date, with
   * every column — to price the pharmacy's own dispensings. Hundreds of thousands of rows fetched to
   * use a few thousand, on every load, growing with each weekly file rather than with the pharmacy.
   */
  const { inArray } = await import("drizzle-orm");
  const wanted = [...new Set(claims.map((c) => c.ndc11).filter((n): n is string => n !== null))];
  const records: NadacRecord[] = [];
  for (let i = 0; i < wanted.length; i += 400) {
    const got = await db.query.nadacPrices.findMany({
      where: inArray(schema.nadacPrices.ndc11, wanted.slice(i, i + 400)),
      columns: { ndc11: true, unitMicros: true, pricingUnit: true, effectiveOn: true, fileAsOf: true },
    });
    for (const p of got) {
      records.push({
        ndc11: p.ndc11,
        unitMicros: p.unitMicros,
        pricingUnit: p.pricingUnit as NadacRecord["pricingUnit"],
        effectiveOn: p.effectiveOn,
        fileAsOf: p.fileAsOf,
      });
    }
  }

  return reviewClaims(claims, plans, records, {
    ksMedicaidDispensingFeeCents: intOrNull(s.ks_medicaid_dispensing_fee_cents),
    materialityCents: intOrNull(s.floor_materiality_cents) ?? DEFAULT_MATERIALITY_CENTS,
  });
}

function intOrNull(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
