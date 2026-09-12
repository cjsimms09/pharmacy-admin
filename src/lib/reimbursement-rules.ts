/**
 * The Kansas SB 20 reimbursement floor, and the checks a claim must pass before it can be put
 * in front of the Insurance Department.
 *
 * Pure functions, no database. Everything a complaint asserts is computed here, so it has to be
 * verifiable in isolation and by hand.
 *
 * The statute (Kansas Consumer Prescription Protection and Accountability Act, SB 20, signed
 * 9 April 2026, effective 1 July 2026) sets a floor for commercial plans not preempted by ERISA:
 * NADAC plus the greater of $10.50 or the state Medicaid professional dispensing fee.
 *
 * Two rules govern this file:
 *
 *   Never price a claim we cannot price. Every path that cannot produce an exact figure returns
 *   an exclusion with a reason, not an approximation. A schedule of 200 claims is only as
 *   credible as its worst line.
 *
 *   Never assume scope. A claim is in scope only when something positively establishes it. An
 *   unknown plan type is "not yet checked", which is a reason to investigate and not a reason
 *   to file.
 */

import { extendedCents, type PricingUnit } from "./money";

/** The statutory minimum professional dispensing fee, in cents. */
export const SB20_MIN_DISPENSING_FEE_CENTS = 1050;

/** The date the floor began to apply. Claims filled before this are out of scope. */
export const SB20_EFFECTIVE_FROM = "2026-07-01";

export type PlanScope = "commercial_non_erisa" | "commercial_erisa" | "part_d" | "medicaid" | "unknown";

export type NadacRecord = {
  ndc11: string;
  unitMicros: number;
  pricingUnit: PricingUnit;
  effectiveOn: string;
  fileAsOf: string;
};

export type ClaimForFloor = {
  rxNumber: string;
  dateFilled: string;
  ndc11: string;
  /** Dispensed quantity × 1,000. */
  quantityThousandths: number | null;
  /** The claim's own unit of measure, to be checked against NADAC's pricing unit. */
  quantityUnit: PricingUnit | null;
  /** What was actually received, in cents — from the remittance, not the adjudicated amount. */
  paidCents: number | null;
  reversed: boolean;
  adjustedAfterPayment: boolean;
  isCompound: boolean;
  is340B: boolean;
  planScope: PlanScope;
};

export type FloorResult = {
  floorCents: number;
  ingredientFloorCents: number;
  dispensingFeeCents: number;
  nadac: NadacRecord;
};

/**
 * NADAC + the greater of $10.50 or the Kansas Medicaid professional dispensing fee.
 *
 * The Medicaid fee is passed in rather than hard-coded: it is set by the state and changes, and
 * a figure that drifts silently is worse than one that has to be entered.
 */
export function computeFloor(
  quantityThousandths: number,
  nadac: NadacRecord,
  ksMedicaidDispensingFeeCents: number | null,
): FloorResult {
  const ingredientFloorCents = extendedCents(nadac.unitMicros, quantityThousandths);
  const dispensingFeeCents = Math.max(SB20_MIN_DISPENSING_FEE_CENTS, ksMedicaidDispensingFeeCents ?? 0);
  return {
    floorCents: ingredientFloorCents + dispensingFeeCents,
    ingredientFloorCents,
    dispensingFeeCents,
    nadac,
  };
}

/**
 * Picks the NADAC in force on the fill date: the latest effective date on or before it.
 *
 * This is the check most likely to be got wrong silently. Pricing a July claim against today's
 * file produces a plausible number that is simply not what the statute required at the time.
 */
export function nadacInForce(records: NadacRecord[], ndc11: string, dateFilled: string): NadacRecord | null {
  const candidates = records
    .filter((r) => r.ndc11 === ndc11 && r.effectiveOn <= dateFilled)
    .sort((a, b) => (a.effectiveOn < b.effectiveOn ? 1 : a.effectiveOn > b.effectiveOn ? -1 : 0));
  return candidates[0] ?? null;
}

export type CheckId =
  | "fill_date_in_scope"
  | "plan_in_scope"
  | "claim_not_reversed"
  | "payment_received"
  | "no_later_adjustment"
  | "not_compound"
  | "not_340b"
  | "nadac_available"
  | "unit_of_measure_agrees"
  | "quantity_known"
  | "shortfall_material";

export type Check = { id: CheckId; passed: boolean; detail: string };

export type Verdict =
  | { filable: true; checks: Check[]; floor: FloorResult; shortfallCents: number }
  | { filable: false; checks: Check[]; failed: Check[]; floor: FloorResult | null; shortfallCents: number | null };

/**
 * Every check a claim must pass. All of them run — the result lists what failed rather than
 * stopping at the first, because "312 examined, 47 excluded for no payment yet, 8 for no NADAC"
 * is the answer worth having.
 */
export function verifyClaim(
  claim: ClaimForFloor,
  records: NadacRecord[],
  opts: { ksMedicaidDispensingFeeCents: number | null; materialityCents: number },
): Verdict {
  const checks: Check[] = [];
  const add = (id: CheckId, passed: boolean, detail: string) => checks.push({ id, passed, detail });

  add(
    "fill_date_in_scope",
    claim.dateFilled >= SB20_EFFECTIVE_FROM,
    claim.dateFilled >= SB20_EFFECTIVE_FROM
      ? `Filled ${claim.dateFilled}, on or after the ${SB20_EFFECTIVE_FROM} effective date.`
      : `Filled ${claim.dateFilled}, before the floor took effect on ${SB20_EFFECTIVE_FROM}.`,
  );

  add(
    "plan_in_scope",
    claim.planScope === "commercial_non_erisa",
    {
      commercial_non_erisa: "Commercial plan, not ERISA-preempted.",
      commercial_erisa: "Self-funded ERISA plan — preempted, the state floor does not reach it.",
      part_d: "Medicare Part D — federally preempted.",
      medicaid: "Medicaid — governed separately, not by this floor.",
      unknown: "Plan type not yet established. Determine it before filing; do not assume.",
    }[claim.planScope],
  );

  add(
    "claim_not_reversed",
    !claim.reversed,
    claim.reversed ? "This claim was reversed, so there is no dispensing to be paid for." : "The claim stands and was not reversed.",
  );

  add(
    "payment_received",
    claim.paidCents !== null,
    claim.paidCents !== null
      ? "Payment received and matched to this claim."
      : "No payment matched yet. An adjudicated amount is not evidence of what was paid.",
  );

  add(
    "no_later_adjustment",
    !claim.adjustedAfterPayment,
    claim.adjustedAfterPayment ? "A later adjustment or takeback changed this claim." : "No adjustment after payment.",
  );

  add(
    "not_compound",
    !claim.isCompound,
    claim.isCompound
      ? "Compounded prescription — priced by a different method, so the NADAC floor does not apply."
      : "Not a compounded prescription, so the NADAC floor applies.",
  );
  add(
    "not_340b",
    !claim.is340B,
    claim.is340B
      ? "Dispensed under 340B — acquisition cost is not comparable to NADAC."
      : "Not a 340B dispensing, so NADAC is the right benchmark.",
  );

  add(
    "quantity_known",
    claim.quantityThousandths !== null && claim.quantityThousandths > 0,
    claim.quantityThousandths
      ? "A dispensed quantity is recorded, so the claim can be priced."
      : "Quantity is missing or zero, so this claim cannot be priced at all.",
  );

  const nadac = nadacInForce(records, claim.ndc11, claim.dateFilled);
  add(
    "nadac_available",
    nadac !== null,
    nadac
      ? `NADAC effective ${nadac.effectiveOn} (CMS file as of ${nadac.fileAsOf}).`
      : `No NADAC for ${claim.ndc11} in force on ${claim.dateFilled}.`,
  );

  add(
    "unit_of_measure_agrees",
    nadac !== null && claim.quantityUnit !== null && claim.quantityUnit === nadac.pricingUnit,
    !nadac
      ? "Cannot compare units without a NADAC record."
      : claim.quantityUnit === null
        ? "The claim carries no unit of measure."
        : claim.quantityUnit === nadac.pricingUnit
          ? `Both in ${nadac.pricingUnit}.`
          : `Claim is in ${claim.quantityUnit}, NADAC prices per ${nadac.pricingUnit}. Pricing across units would be wrong by orders of magnitude.`,
  );

  const priceable = nadac !== null && claim.quantityThousandths !== null && claim.quantityThousandths > 0 && claim.quantityUnit === nadac.pricingUnit;
  const floor = priceable ? computeFloor(claim.quantityThousandths!, nadac!, opts.ksMedicaidDispensingFeeCents) : null;
  const shortfallCents = floor && claim.paidCents !== null ? floor.floorCents - claim.paidCents : null;

  add(
    "shortfall_material",
    shortfallCents !== null && shortfallCents >= opts.materialityCents,
    shortfallCents === null
      ? "Shortfall cannot be computed."
      : shortfallCents < 0
        ? "Paid at or above the floor — nothing owed."
        : shortfallCents < opts.materialityCents
          ? `Shortfall below the materiality threshold.`
          : `Paid below the statutory floor.`,
  );

  const failed = checks.filter((c) => !c.passed);
  if (failed.length === 0 && floor && shortfallCents !== null) {
    return { filable: true, checks, floor, shortfallCents };
  }
  return { filable: false, checks, failed, floor, shortfallCents };
}
