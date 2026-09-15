import "server-only";
import { computeFloor, nadacInForce, SB20_MIN_DISPENSING_FEE_CENTS, SB20_EFFECTIVE_FROM, type NadacRecord } from "./reimbursement-rules";
import type { Fill } from "./fills";

/**
 * Every dispensing measured against NADAC plus the dispensing fee.
 *
 * The floor review already answered "which claims can I file on", which is a narrow question: it
 * counts only plans the Kansas statute reaches, and stays silent about everything else. That
 * silence covers most of the money. A Part D plan paying below acquisition is not a filing, but it
 * is still a plan paying below what the government reckons the drug costs — and knowing that is
 * what a contract negotiation, a network decision or a decision to stop stocking is made of.
 *
 * So every fill is measured, and what can be *done* about each is said separately from what is
 * *true* of it. A plan the floor reaches and that paid under it is money owed. A plan the floor
 * cannot reach that paid under it is a rate to argue commercially. A discount card paying under it
 * is the price, and nothing at all.
 *
 * ── What it will not do ──
 *
 * A fill with no NADAC on file for its date is not compared. NADAC is published weekly and pricing
 * a July claim against today's file produces a plausible figure that is simply not what applied at
 * the time — the most likely way to be confidently wrong here. The same for a fill with no
 * quantity: a per-unit benchmark cannot be extended without one.
 */

export type NadacStanding = {
  key: string;
  rxNumber: string;
  fillNumber: number | null;
  dateFilled: string;
  ndc11: string | null;
  itemName: string | null;
  payer: string;
  /** What the plans, the patient and anything later actually brought in. */
  receivedCents: number;
  /** NADAC for the quantity dispensed, at the price in force on the fill date. */
  nadacCents: number;
  /** The greater of $10.50 and the Kansas Medicaid dispensing fee. */
  dispensingFeeCents: number;
  /** NADAC plus that fee: the benchmark. */
  benchmarkCents: number;
  /** Received less the benchmark. Negative is paid under it. */
  againstBenchmarkCents: number;
  /** The NADAC date actually used, so a comparison can be checked. */
  nadacOn: string;
  /** Whether the Kansas floor can reach this plan at all. */
  inScope: boolean;
  classification: string | null;
  /** What can be done about it, in the words of the action. */
  standing: "owed" | "argue" | "the price" | "unclassified";
};

const STANDING_MEANS: Record<NadacStanding["standing"], string> = {
  owed: "The Kansas floor reaches this plan and it paid under it. This is a shortfall to claim.",
  argue:
    "The floor cannot reach this plan — it is federally governed or preempted — so this is not a claim. It is a rate paying below the benchmark, which is what a contract conversation is made of.",
  "the price": "A discount or savings card sets the price rather than paying a rate, so paying under the benchmark is not a shortfall.",
  unclassified: "Nothing says what kind of plan this is, so nothing can say whether the floor reaches it. Classify it and this answers itself.",
};

export { STANDING_MEANS, SB20_MIN_DISPENSING_FEE_CENTS, SB20_EFFECTIVE_FROM };

export type AgainstNadac = {
  rows: NadacStanding[];
  /** Fills that could not be compared, and why — never silently dropped. */
  notCompared: { reason: "no NADAC held for that date" | "no quantity on the claim" | "no NDC on the claim" | "the pharmacy's own cash price, which no benchmark applies to"; fills: number }[];
  owedCents: number;
  argueCents: number;
  /** How many of the compared fills are paid at or above the benchmark. */
  atOrAbove: number;
};

export async function againstNadac(fills: Fill[]): Promise<AgainstNadac> {
  const { db } = await import("@/db");
  const { getSettings } = await import("./settings");
  const { planLookup, CLASS_INFO } = await import("./plans");

  /*
   * Only the prices for the drugs actually on these fills.
   *
   * This used to read the whole NADAC table — every NDC the federal file carries, at every date it
   * has ever carried one — to price a couple of hundred dispensings. Hundreds of thousands of rows
   * across the wire and into memory, on every single load of the claims screen, to use a few hundred
   * of them. The screen took seconds to open and got slower every week as more NADAC files landed.
   *
   * The fills say which NDCs matter before anything is fetched, so ask for those.
   */
  const { inArray } = await import("drizzle-orm");
  const { schema } = await import("@/db");
  const wanted = [...new Set(fills.map((f) => f.ndc11).filter((n): n is string => n !== null))];

  const nadacRows: { ndc11: string; unitMicros: number; effectiveOn: string; pricingUnit: NadacRecord["pricingUnit"]; fileAsOf: string }[] = [];
  // Chunked, because a query with thousands of bound parameters is its own kind of slow.
  for (let i = 0; i < wanted.length; i += 400) {
    const got = await db.query.nadacPrices.findMany({
      where: inArray(schema.nadacPrices.ndc11, wanted.slice(i, i + 400)),
      columns: { ndc11: true, unitMicros: true, effectiveOn: true, pricingUnit: true, fileAsOf: true },
    });
    for (const r of got) {
      nadacRows.push({
        ndc11: r.ndc11,
        unitMicros: r.unitMicros,
        effectiveOn: r.effectiveOn,
        pricingUnit: r.pricingUnit as NadacRecord["pricingUnit"],
        fileAsOf: r.fileAsOf,
      });
    }
  }

  const [groups, s] = await Promise.all([db.query.planGroups.findMany(), getSettings()]);
  const records: NadacRecord[] = nadacRows;
  const lookup = planLookup(groups);

  const feeRaw = Number((s.ks_medicaid_dispensing_fee_cents ?? "").trim());
  const ksFee = Number.isFinite(feeRaw) && feeRaw > 0 ? feeRaw : null;

  const rows: NadacStanding[] = [];
  const missing = {
    "no NADAC held for that date": 0,
    "no quantity on the claim": 0,
    "no NDC on the claim": 0,
    "the pharmacy's own cash price, which no benchmark applies to": 0,
  };

  for (const f of fills) {
    /*
     * The pharmacy's own cash programme is not measured against the benchmark.
     *
     * NADAC plus the dispensing fee is a test of whether a *payer* paid enough. On a fill the
     * pharmacy priced itself there is no payer, no floor for the state to enforce and nobody to
     * argue with — the number is what it chose to charge. Measuring it produces a list of
     * "shortfalls" against itself, which is noise on the one screen that has to stay actionable.
     */
    if (f.cashPlan) {
      missing["the pharmacy's own cash price, which no benchmark applies to"]++;
      continue;
    }
    if (!f.ndc11) {
      missing["no NDC on the claim"]++;
      continue;
    }
    if (!f.quantityThousandths || f.quantityThousandths <= 0) {
      missing["no quantity on the claim"]++;
      continue;
    }
    const nadac = nadacInForce(records, f.ndc11, f.dateFilled);
    if (!nadac) {
      missing["no NADAC held for that date"]++;
      continue;
    }
    const floor = computeFloor(f.quantityThousandths, nadac, ksFee);
    const primary = f.payers[0];
    const cls = lookup({ bin: primary.bin, pcn: primary.pcn ?? null, groupNumber: primary.groupNumber })?.classification ?? null;
    const inScope = cls ? CLASS_INFO[cls as keyof typeof CLASS_INFO]?.inScope === true : false;
    const against = f.revenueCents - floor.floorCents;

    const standing: NadacStanding["standing"] =
      cls === null || cls === "unknown"
        ? "unclassified"
        : cls === "discount_card" || cls === "copay_card"
          ? "the price"
          : inScope
            ? "owed"
            : "argue";

    rows.push({
      key: f.key,
      rxNumber: f.rxNumber,
      fillNumber: f.fillNumber,
      dateFilled: f.dateFilled,
      ndc11: f.ndc11,
      itemName: f.itemName,
      payer: f.payers.map((p) => p.name ?? p.bin ?? "—").join(" then "),
      receivedCents: f.revenueCents,
      nadacCents: floor.ingredientFloorCents,
      dispensingFeeCents: floor.dispensingFeeCents,
      benchmarkCents: floor.floorCents,
      againstBenchmarkCents: against,
      nadacOn: nadac.effectiveOn,
      inScope,
      classification: cls,
      standing,
    });
  }

  rows.sort((a, b) => a.againstBenchmarkCents - b.againstBenchmarkCents);
  return {
    rows,
    notCompared: (Object.entries(missing) as [keyof typeof missing, number][])
      .filter(([, n]) => n > 0)
      .map(([reason, fills]) => ({ reason, fills })),
    owedCents: rows.filter((r) => r.standing === "owed" && r.againstBenchmarkCents < 0).reduce((n, r) => n + -r.againstBenchmarkCents, 0),
    argueCents: rows.filter((r) => r.standing === "argue" && r.againstBenchmarkCents < 0).reduce((n, r) => n + -r.againstBenchmarkCents, 0),
    atOrAbove: rows.filter((r) => r.againstBenchmarkCents >= 0).length,
  };
}
