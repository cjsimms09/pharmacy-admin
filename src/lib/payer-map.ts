import "server-only";
import { db } from "@/db";
import { groupIntoFills, type Fill, type ClaimRow } from "./fills";
import { allPayerLinks, linkFor, type PayerLinkRow } from "./payer-links";

/**
 * The line from a claim to the money: BIN and group, to plan, to PBM, to contract, to rate sheet.
 *
 * Every link in that chain already existed in this system and none of them were joined. The claims
 * knew the BIN. A listing knew which PBM a BIN belongs to. A register knew what kind of plan a
 * BIN-and-group is. A folder held the contracts. A rate table held what each network pays. Five
 * true things about the same payer, in five places, and no way to ask the one question worth
 * asking: who pays us well, and who does not.
 *
 * ── Why the chain is reported, not just the answer ──
 *
 * The chain breaks, and where it breaks decides what to do about it. A BIN nobody can name is a
 * chase. A BIN named but with no contract on file is a document to go and get. A contract on file
 * with no rate sheet behind it is a reading job. Reporting only "unknown" for all three would put
 * three different jobs in one bucket and none of them would get done.
 *
 * ── Why margin is per fill ──
 *
 * A prescription billed to a primary and then a secondary is one bottle and two rows carrying the
 * same acquisition cost. Ranked per claim, the primary of every coordinated fill sinks its payer to
 * the bottom of the table on money the pharmacy was in fact paid. So every figure here is worked
 * out over fills.
 */

export type ChainGap = "no_pbm" | "bin_ambiguous" | "no_plan_class" | "no_contract" | "no_rates";

export type PayerLink = {
  bin: string | null;
  groupNumber: string | null;
  /** Who the listing says this BIN belongs to. Several where the BIN is shared. */
  pbmNames: string[];
  /** The one name to use, where it is not in doubt. */
  pbmName: string | null;
  /** What the plan register says this BIN-and-group is: commercial, Medicaid, cash discount… */
  classification: string | null;
  sponsorName: string | null;
  /** Contracts on file for that PBM. */
  contracts: { fileName: string | null; documentName: string; documentType: string | null; effectiveYear: number | null }[];
  /** Rate sheets held for that PBM. */
  rateSheets: { lineOfBusiness: string; network: string; brandRate: string | null; genericRate: string | null; effectiveDate: string | null }[];
  /** The confirmed link, where somebody has settled this one. */
  link: { pbmName: string; contractFileName: string | null; basis: string | null; confirmedBy: string } | null;
  /** Where the chain stops, in the order it stops. */
  gaps: ChainGap[];
  fills: number;
  revenueCents: number;
  costCents: number;
  marginCents: number;
};

export type PayerScore = {
  pbmName: string;
  bins: string[];
  fills: number;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  /** Margin as a share of what came in. The comparable figure across payers of different sizes. */
  marginPercent: number | null;
  /** What one fill is worth on average, which is what decides whether a plan is worth being in. */
  marginPerFillCents: number;
  fillsAtALoss: number;
  /** True where the chain is complete: named, classified, contract and rates on file. */
  fullyMapped: boolean;
  gaps: ChainGap[];
};

export type NdcReimbursement = {
  ndc11: string;
  name: string | null;
  fills: number;
  unitsDispensed: number;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginPerUnitMicros: number;
  /** The payer that pays best for it, and the one that pays worst. */
  bestPayer: { name: string; marginCents: number; fills: number } | null;
  worstPayer: { name: string; marginCents: number; fills: number } | null;
  /** How far apart those two are, per fill. The size of the prize for steering or appealing. */
  spreadPerFillCents: number | null;
};

const nameOf = (f: Fill): string => f.payers.map((p) => p.name ?? p.bin ?? "unnamed").join(" + ");

/** The one payer that carried a fill, for ranking. A coordinated fill is credited to the primary. */
const payerKey = (f: Fill): { key: string; bin: string | null } => {
  const p = f.payers[0];
  return { key: p.name ?? p.bin ?? "unnamed", bin: p.bin };
};

export async function payerMap(): Promise<{
  links: PayerLink[];
  scores: PayerScore[];
  ndcs: NdcReimbursement[];
  fills: Fill[];
  totals: { fills: number; revenueCents: number; costCents: number; marginCents: number; mappedFills: number };
}> {
  const [claims, bins, groups, contracts, rates, confirmed] = await Promise.all([
    db.query.claims.findMany(),
    db.query.payerBins.findMany(),
    db.query.planGroups.findMany(),
    db.query.contractDocs.findMany(),
    db.query.networkRates.findMany(),
    allPayerLinks(),
  ]);
  // What somebody has already settled, keyed by the claim it came from, so it can be read here
  // rather than searched for again.
  const keyOfClaim = new Map<string, { pcn: string | null; contractId: string | null }>();
  for (const c of claims) keyOfClaim.set(`${c.bin ?? ""}|${(c.groupNumber ?? "").toUpperCase()}`, { pcn: c.pcn, contractId: c.networkId });

  const fills = groupIntoFills(
    claims.map(
      (c): ClaimRow => ({
        id: c.id,
        rxNumber: c.rxNumber,
        fillNumber: c.fillNumber,
        dateFilled: c.dateFilled,
        ndc11: c.ndc11,
        itemName: c.itemName,
        bin: c.bin,
        groupNumber: c.groupNumber,
        pbmName: c.pbmName,
        payerLabel: c.payerLabel,
        quantityThousandths: c.quantityThousandths,
        remitCents: c.remitCents,
        copayCents: c.copayCents,
        acquisitionCents: c.acquisitionCents,
        status: c.status,
        unmatchedReversal: (c.remitCents ?? 0) < 0 && !c.reversalKey,
      }),
    ),
  );

  // ── The chain, per BIN and group actually billed ──
  const binsByNumber = new Map<string, typeof bins>();
  for (const b of bins) binsByNumber.set(b.bin, [...(binsByNumber.get(b.bin) ?? []), b]);
  const groupKey = (bin: string | null, g: string | null) => `${bin ?? ""}|${(g ?? "").toUpperCase()}`;
  const planByKey = new Map(groups.map((g) => [groupKey(g.bin, g.groupNumber), g]));
  const contractsByPbm = new Map<string, typeof contracts>();
  for (const c of contracts) contractsByPbm.set(c.pbmName, [...(contractsByPbm.get(c.pbmName) ?? []), c]);
  const ratesByPbm = new Map<string, typeof rates>();
  for (const r of rates) ratesByPbm.set(r.pbmName, [...(ratesByPbm.get(r.pbmName) ?? []), r]);

  const linkBy = new Map<string, PayerLink>();
  for (const f of fills) {
    for (const p of f.payers) {
      const g = p.groupNumber;
      const key = groupKey(p.bin, g);
      let e = linkBy.get(key);
      if (!e) {
        const candidates = p.bin ? (binsByNumber.get(p.bin) ?? []) : [];
        const names = [...new Set(candidates.map((c) => c.pbmName))];
        const plan = planByKey.get(key) ?? null;
        /*
         * A confirmed link beats every guess, including an unambiguous listing.
         *
         * It is the one answer a person actually gave, and it is the only one that can settle a
         * BIN shared by several PBMs — which is precisely where a wrong answer sends an appeal to
         * the wrong agreement.
         */
        const extra = keyOfClaim.get(key) ?? { pcn: null, contractId: null };
        const hit: PayerLinkRow | null = linkFor(confirmed, { bin: p.bin, pcn: extra.pcn, groupNumber: g, contractId: extra.contractId });
        const settled = hit?.pbmName ?? (names.length === 1 ? names[0] : (plan?.pbmName ?? null));
        const forPbm = settled ? (contractsByPbm.get(settled) ?? []) : [];
        const rateRows = settled ? (ratesByPbm.get(settled) ?? []) : [];
        const gaps: ChainGap[] = [];
        if (!settled) gaps.push(names.length > 1 ? "bin_ambiguous" : "no_pbm");
        // A link that names the contract closes that gap outright, whatever the checklist holds.
        const linkedContract = hit?.contractFileName ?? null;
        if (!plan || plan.classification === "unknown") gaps.push("no_plan_class");
        if (settled && !linkedContract && forPbm.filter((c) => c.fileName).length === 0) gaps.push("no_contract");
        if (settled && rateRows.length === 0) gaps.push("no_rates");
        e = {
          bin: p.bin,
          groupNumber: g,
          pbmNames: names,
          pbmName: settled,
          classification: plan?.classification ?? null,
          sponsorName: plan?.sponsorName ?? null,
          contracts: forPbm.map((c) => ({ fileName: c.fileName, documentName: c.documentName, documentType: c.documentType, effectiveYear: c.effectiveYear })),
          link: hit ? { pbmName: hit.pbmName, contractFileName: hit.contractFileName, basis: hit.basis, confirmedBy: hit.confirmedBy } : null,
          rateSheets: rateRows.map((r) => ({ lineOfBusiness: r.lineOfBusiness, network: r.network, brandRate: r.brandRate, genericRate: r.genericRate, effectiveDate: r.effectiveDate })),
          gaps,
          fills: 0,
          revenueCents: 0,
          costCents: 0,
          marginCents: 0,
        };
        linkBy.set(key, e);
      }
      // A coordinated fill's money is credited to the payer that paid it, split by remit.
      const share = f.remitCents === 0 ? 1 / f.payers.length : p.remitCents / Math.max(1, f.remitCents);
      e.fills += 1 / f.payers.length;
      e.revenueCents += Math.round(f.revenueCents * share);
      e.costCents += Math.round((f.acquisitionCents ?? 0) * share);
      e.marginCents += Math.round((f.marginCents ?? 0) * share);
    }
  }
  const links = [...linkBy.values()].sort((a, b) => b.revenueCents - a.revenueCents);

  // ── The league table, per payer, over fills ──
  const scoreBy = new Map<string, PayerScore>();
  for (const f of fills) {
    const { key, bin } = payerKey(f);
    let e = scoreBy.get(key);
    if (!e) {
      const link = links.find((l) => l.bin === bin) ?? null;
      e = {
        pbmName: key,
        bins: [],
        fills: 0,
        revenueCents: 0,
        costCents: 0,
        marginCents: 0,
        marginPercent: null,
        marginPerFillCents: 0,
        fillsAtALoss: 0,
        fullyMapped: link ? link.gaps.length === 0 : false,
        gaps: link?.gaps ?? ["no_pbm"],
      };
      scoreBy.set(key, e);
    }
    if (bin && !e.bins.includes(bin)) e.bins.push(bin);
    e.fills++;
    e.revenueCents += f.revenueCents;
    e.costCents += f.acquisitionCents ?? 0;
    if (f.marginCents !== null) {
      e.marginCents += f.marginCents;
      if (f.marginCents < 0) e.fillsAtALoss++;
    }
  }
  const scores = [...scoreBy.values()]
    .map((s) => ({
      ...s,
      marginPercent: s.revenueCents > 0 ? Math.round((s.marginCents / s.revenueCents) * 1000) / 10 : null,
      marginPerFillCents: s.fills > 0 ? Math.round(s.marginCents / s.fills) : 0,
    }))
    .sort((a, b) => b.marginPerFillCents - a.marginPerFillCents);

  // ── Per drug, and who pays best and worst for it ──
  const ndcBy = new Map<string, { r: NdcReimbursement; byPayer: Map<string, { marginCents: number; fills: number }> }>();
  for (const f of fills) {
    if (!f.ndc11 || f.marginCents === null) continue;
    let e = ndcBy.get(f.ndc11);
    if (!e) {
      e = {
        r: {
          ndc11: f.ndc11,
          name: f.itemName,
          fills: 0,
          unitsDispensed: 0,
          revenueCents: 0,
          costCents: 0,
          marginCents: 0,
          marginPerUnitMicros: 0,
          bestPayer: null,
          worstPayer: null,
          spreadPerFillCents: null,
        },
        byPayer: new Map(),
      };
      ndcBy.set(f.ndc11, e);
    }
    if (!e.r.name && f.itemName) e.r.name = f.itemName;
    e.r.fills++;
    e.r.unitsDispensed += (f.quantityThousandths ?? 0) / 1000;
    e.r.revenueCents += f.revenueCents;
    e.r.costCents += f.acquisitionCents ?? 0;
    e.r.marginCents += f.marginCents;
    const who = nameOf(f);
    const p = e.byPayer.get(who) ?? { marginCents: 0, fills: 0 };
    p.marginCents += f.marginCents;
    p.fills++;
    e.byPayer.set(who, p);
  }
  const ndcs = [...ndcBy.values()]
    .map(({ r, byPayer }) => {
      const ranked = [...byPayer.entries()]
        .map(([name, v]) => ({ name, marginCents: v.marginCents, fills: v.fills, perFill: Math.round(v.marginCents / v.fills) }))
        .sort((a, b) => b.perFill - a.perFill);
      const best = ranked[0] ?? null;
      const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;
      return {
        ...r,
        unitsDispensed: Math.round(r.unitsDispensed * 100) / 100,
        marginPerUnitMicros: r.unitsDispensed > 0 ? Math.round((r.marginCents * 10_000) / r.unitsDispensed) : 0,
        bestPayer: best ? { name: best.name, marginCents: best.marginCents, fills: best.fills } : null,
        worstPayer: worst ? { name: worst.name, marginCents: worst.marginCents, fills: worst.fills } : null,
        // Only meaningful where two payers have actually been seen for the same drug.
        spreadPerFillCents: best && worst ? best.perFill - worst.perFill : null,
      };
    })
    .sort((a, b) => b.marginCents - a.marginCents);

  const totals = {
    fills: fills.length,
    revenueCents: fills.reduce((n, f) => n + f.revenueCents, 0),
    costCents: fills.reduce((n, f) => n + (f.acquisitionCents ?? 0), 0),
    marginCents: fills.reduce((n, f) => n + (f.marginCents ?? 0), 0),
    mappedFills: fills.filter((f) => {
      const l = links.find((x) => x.bin === f.payers[0].bin);
      return l !== undefined && l.gaps.length === 0;
    }).length,
  };

  return { links, scores, ndcs, fills, totals };
}

/** What each broken link means, in the words of the job it creates. */
export const GAP_MEANS: Record<ChainGap, string> = {
  no_pbm: "no PBM name — nothing says who this BIN belongs to",
  bin_ambiguous: "the BIN is shared by several PBMs; the PCN or group decides which",
  no_plan_class: "not classified — nothing says whether it is commercial, Medicaid or a cash programme",
  no_contract: "no contract on file for that PBM",
  no_rates: "no rate sheet, so nothing says what they agreed to pay",
};
