import "server-only";
import { db } from "@/db";
import { groupIntoFills, type Fill, type ClaimRow } from "./fills";
import { laterPayments } from "./claim-payments";
import { allPayerLinks, linkFor, type PayerLinkRow } from "./payer-links";
import { planKey, planLookup } from "./plan-key";

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
  /** The processor control number. One BIN carries a commercial PCN and a Part D one side by side. */
  pcn: string | null;
  groupNumber: string | null;
  /** Who the listing says this BIN belongs to. Several where the BIN is shared. */
  pbmNames: string[];
  /** The one name to use, where it is not in doubt. */
  pbmName: string | null;
  /** What the plan register says this BIN, PCN and group is: commercial, Medicaid, cash discount… */
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

/**
 * Payers that pay a patient's share rather than a plan benefit.
 *
 * A copay card is a payer. It adjudicates through its own BIN, it pays real money, it has terms
 * behind it, and it can reject or underpay like anything else — so it is counted, ranked and
 * tracked like anything else. What it is not is *comparable* to a plan on margin per fill: it pays
 * whatever residual is put to it, so a table that sorts it against a PBM sorts on the wrong thing
 * and always puts it top.
 *
 * So they are ranked among their own kind rather than left out, and the money they contribute is
 * held separately from the plan's own payment — otherwise a brand plan paying badly is flattered by
 * having its shortfall filled in by the manufacturer, and looks like a plan worth keeping.
 */
export const SUBSIDY_CLASSES = new Set(["copay_card", "discount_card"]);

export type PayerScore = {
  pbmName: string;
  /**
   * True where this payer pays a patient's share rather than a plan benefit.
   *
   * Still a payer, still ranked and tracked — but ranked among its own kind, because margin per
   * fill compares nothing meaningful between a card that covers whatever residual is put to it and
   * a plan that prices a drug.
   */
  isSubsidy: boolean;
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
  /**
   * What this payer paid on fills it shared with a card, and what the card put in beside it.
   *
   * The number that stops a brand plan being flattered: a plan paying eight dollars towards a
   * six-hundred-dollar pen looks respectable once a manufacturer has quietly filled in the rest.
   */
  sharedWithCardFills: number;
  cardSupportBesideThisCents: number;
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

export async function payerMap(): ReturnType<typeof loadPayerMap> {
  const { held } = await import("./held");
  return held("payer-map", loadPayerMap);
}

async function loadPayerMap(): Promise<{
  links: PayerLink[];
  scores: PayerScore[];
  ndcs: NdcReimbursement[];
  fills: Fill[];
  totals: { fills: number; revenueCents: number; costCents: number; marginCents: number; mappedFills: number };
  /** Copay and savings card money: counted, named, and deliberately not ranked. */
  subsidy: { fills: number; revenueCents: number; sources: string[] };
}> {
  const [claims, bins, groups, contracts, rates, confirmed] = await Promise.all([
    db.query.claims.findMany(),
    db.query.payerBins.findMany(),
    db.query.planGroups.findMany(),
    db.query.contractDocs.findMany(),
    db.query.networkRates.findMany(),
    allPayerLinks(),
  ]);
  // Money that reached these fills after the day they were transmitted.
  const later = await laterPayments();
  // What somebody has already settled, keyed by the claim it came from, so it can be read here
  // rather than searched for again.
  // The network reimbursement id, per plan. The fill carries the BIN, PCN and group; the claim
  // row carries the id of the contract that priced it, so it is joined on the plan key here.
  const contractOfPlan = new Map<string, string | null>();
  for (const c of claims) {
    const k = planKey(c.bin, c.pcn, c.groupNumber);
    if (c.networkId || !contractOfPlan.has(k)) contractOfPlan.set(k, c.networkId);
  }

  const fills = groupIntoFills(
    claims.map(
      (c): ClaimRow => ({
        id: c.id,
        rxNumber: c.rxNumber,
        fillNumber: c.fillNumber,
        dateFilled: c.dateFilled,
      soldOn: c.completedAt ?? c.soldOn ?? null,
        ndc11: c.ndc11,
        itemName: c.itemName,
        bin: c.bin,
        pcn: c.pcn,
        groupNumber: c.groupNumber,
        pbmName: c.pbmName,
        payerLabel: c.payerLabel,
        quantityThousandths: c.quantityThousandths,
        remitCents: c.remitCents,
        copayCents: c.copayCents,
        patientTotalCents: c.patientTotalCents,
        acquisitionCents: c.acquisitionCents,
        status: c.status,
        onAccount: c.onAccount,
        unmatchedReversal: (c.remitCents ?? 0) < 0 && !c.reversalKey,
      }),
    ),
    later,
  );

  // ── The chain, per BIN, PCN and group actually billed ──
  const binsByNumber = new Map<string, typeof bins>();
  for (const b of bins) binsByNumber.set(b.bin, [...(binsByNumber.get(b.bin) ?? []), b]);
  const planOf = planLookup(groups);
  const contractsByPbm = new Map<string, typeof contracts>();
  for (const c of contracts) contractsByPbm.set(c.pbmName, [...(contractsByPbm.get(c.pbmName) ?? []), c]);
  const ratesByPbm = new Map<string, typeof rates>();
  for (const r of rates) ratesByPbm.set(r.pbmName, [...(ratesByPbm.get(r.pbmName) ?? []), r]);

  const linkBy = new Map<string, PayerLink>();
  for (const f of fills) {
    for (const p of f.payers) {
      const g = p.groupNumber;
      const key = planKey(p.bin, p.pcn, g);
      let e = linkBy.get(key);
      if (!e) {
        const candidates = p.bin ? (binsByNumber.get(p.bin) ?? []) : [];
        const names = [...new Set(candidates.map((c) => c.pbmName))];
        const plan = planOf(p) ?? null;
        /*
         * A confirmed link beats every guess, including an unambiguous listing.
         *
         * It is the one answer a person actually gave, and it is the only one that can settle a
         * BIN shared by several PBMs — which is precisely where a wrong answer sends an appeal to
         * the wrong agreement.
         */
        const hit: PayerLinkRow | null = linkFor(confirmed, { bin: p.bin, pcn: p.pcn, groupNumber: g, contractId: contractOfPlan.get(key) ?? null });
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
          pcn: p.pcn,
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
  // Which plan is a subsidy rather than a plan, so it can be kept out of the ranking.
  const isSubsidy = (p: { bin: string | null; pcn: string | null; groupNumber: string | null }) => {
    const cls = planOf(p)?.classification;
    return cls !== undefined && SUBSIDY_CLASSES.has(cls);
  };
  const scoreBy = new Map<string, PayerScore>();
  for (const f of fills) {
    const { key, bin } = payerKey(f);
    let e = scoreBy.get(key);
    if (!e) {
      const link = links.find((l) => l.bin === bin) ?? null;
      const primary = f.payers[0];
      e = {
        pbmName: key,
        isSubsidy: isSubsidy(primary),
        sharedWithCardFills: 0,
        cardSupportBesideThisCents: 0,
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
    // What a card put in beside this payer on the same fill, held apart from this payer's own money.
    const cardBeside = f.payers
      .slice(1)
      .filter((p) => isSubsidy(p))
      .reduce((n, p) => n + p.remitCents, 0);
    if (cardBeside > 0) {
      e.sharedWithCardFills++;
      e.cardSupportBesideThisCents += cardBeside;
    }
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

  /*
   * What copay and savings cards brought in, counted rather than ranked.
   *
   * Real money, and it should be visible — but it is a subsidy on a fill, not a plan paying for a
   * drug, and putting it in the same table as a PBM answers no question anybody has.
   */
  const subsidy = {
    fills: scores.filter((s) => s.isSubsidy).reduce((n, s) => n + s.fills, 0),
    revenueCents: scores.filter((s) => s.isSubsidy).reduce((n, s) => n + s.revenueCents, 0),
    sources: scores.filter((s) => s.isSubsidy).map((s) => s.pbmName),
  };

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

  return { links, scores, ndcs, fills, totals, subsidy };
}

/** What each broken link means, in the words of the job it creates. */
export const GAP_MEANS: Record<ChainGap, string> = {
  no_pbm: "no PBM name — nothing says who this BIN belongs to",
  bin_ambiguous: "the BIN is shared by several PBMs; the PCN or group decides which",
  no_plan_class: "not classified — nothing says whether it is commercial, Medicaid or a cash programme",
  no_contract: "no contract on file for that PBM",
  no_rates: "no rate sheet, so nothing says what they agreed to pay",
};

/**
 * The hierarchy as it actually is: company, then BIN, then group, then contract id.
 *
 * The first cut of this flattened everything to "a payer", which is wrong at every level and wrong
 * in a way that costs money.
 *
 * A **company** — Express Scripts, Caremark, Optum — runs many BINs. A **BIN** is a processing
 * route, not a plan: the same BIN carries a fully-insured commercial plan the Kansas floor applies
 * to and a self-funded ERISA plan it cannot touch. The **group number** is what separates those,
 * and it is the level a plan is actually classified at. And the **contract id** printed on the
 * claim — PioneerRx calls it the network reimbursement id — is the thing that names which agreement
 * priced the fill, which is what an appeal has to cite.
 *
 * Four levels, and each answers a different question. Which company is worth negotiating with.
 * Which route is underpaying. Which employer's plan is the problem. And which contract to open.
 * Collapsed into one, none of those can be asked — and a rate argued from the wrong level is an
 * argument lost.
 */

export type ContractNode = {
  contractId: string | null;
  /** The contract document this id has been linked to, once somebody confirmed it. */
  contractFileName: string | null;
  fills: number;
  revenueCents: number;
  marginCents: number;
  /** True where nothing says which agreement priced these fills. */
  unlinked: boolean;
};

export type GroupNode = {
  /** The processor control number the plan bills under. Two PCNs under one BIN are two plans. */
  pcn: string | null;
  groupNumber: string | null;
  /** What the plan register says this BIN, PCN and group is — the level ERISA or Part D is decided at. */
  classification: string | null;
  sponsorName: string | null;
  contracts: ContractNode[];
  fills: number;
  revenueCents: number;
  marginCents: number;
};

export type BinNode = {
  bin: string | null;
  groups: GroupNode[];
  fills: number;
  revenueCents: number;
  marginCents: number;
  /** True where one BIN carries plans of more than one kind, which is the usual case. */
  mixedClassification: boolean;
};

export type CompanyNode = {
  company: string;
  /** False where nothing has named the company yet. */
  named: boolean;
  bins: BinNode[];
  fills: number;
  revenueCents: number;
  marginCents: number;
  marginPerFillCents: number;
};

export async function payerTree(): Promise<{ companies: CompanyNode[]; unnamedRevenueCents: number }> {
  const { held } = await import("./held");
  return held("payer-tree", loadPayerTree);
}

async function loadPayerTree(): Promise<{ companies: CompanyNode[]; unnamedRevenueCents: number }> {
  const [claims, bins, groups, confirmed] = await Promise.all([
    db.query.claims.findMany(),
    db.query.payerBins.findMany(),
    db.query.planGroups.findMany(),
    allPayerLinks(),
  ]);
  const later = await laterPayments();

  const fills = groupIntoFills(
    claims.map(
      (c): ClaimRow => ({
        id: c.id,
        rxNumber: c.rxNumber,
        fillNumber: c.fillNumber,
        dateFilled: c.dateFilled,
      soldOn: c.completedAt ?? c.soldOn ?? null,
        ndc11: c.ndc11,
        itemName: c.itemName,
        bin: c.bin,
        pcn: c.pcn,
        groupNumber: c.groupNumber,
        pbmName: c.pbmName,
        payerLabel: c.payerLabel,
        quantityThousandths: c.quantityThousandths,
        remitCents: c.remitCents,
        copayCents: c.copayCents,
        patientTotalCents: c.patientTotalCents,
        acquisitionCents: c.acquisitionCents,
        status: c.status,
        onAccount: c.onAccount,
        unmatchedReversal: (c.remitCents ?? 0) < 0 && !c.reversalKey,
      }),
    ),
    later,
  );

  // The claim carries the contract id; the fill carries the payers. Join on the claim.
  const contractByClaim = new Map<string, string | null>();
  for (const c of claims) {
    contractByClaim.set(`${c.rxNumber}|${c.fillNumber ?? ""}|${c.dateFilled}|${c.bin ?? ""}`, c.networkId);
  }

  const companyOfBin = new Map<string, string[]>();
  for (const b of bins) companyOfBin.set(b.bin, [...new Set([...(companyOfBin.get(b.bin) ?? []), b.pbmName])]);
  const planOf = planLookup(groups);

  type Acc = { fills: number; revenueCents: number; marginCents: number };
  const add = (a: Acc, share: number, f: Fill) => {
    a.fills += share;
    a.revenueCents += Math.round(f.revenueCents * share);
    a.marginCents += Math.round((f.marginCents ?? 0) * share);
  };

  const companies = new Map<string, { node: CompanyNode; bins: Map<string, { node: BinNode; groups: Map<string, { node: GroupNode; contracts: Map<string, ContractNode> }> }> }>();

  for (const f of fills) {
    const share = 1 / f.payers.length;
    for (const p of f.payers) {
      const contractId = contractByClaim.get(`${f.rxNumber}|${f.fillNumber ?? ""}|${f.dateFilled}|${p.bin ?? ""}`) ?? null;
      const link = linkFor(confirmed, { bin: p.bin, pcn: p.pcn, groupNumber: p.groupNumber, contractId });
      const listed = p.bin ? (companyOfBin.get(p.bin) ?? []) : [];
      const plan = planOf(p) ?? null;
      /*
       * The company, settled in the order the answers can be trusted.
       *
       * A confirmed link is somebody's decision. A listing naming exactly one PBM is a fact about
       * the BIN. A listing naming several is not an answer at all, and the plan register may know
       * which. Falling back to the label the claim printed is a last resort — it is whatever the
       * switch happened to echo — so it is marked as unnamed rather than treated as settled.
       */
      const settled = link?.pbmName ?? (listed.length === 1 ? listed[0] : (plan?.pbmName ?? null));
      const company = settled ?? p.name ?? p.bin ?? "not yet named";

      let c = companies.get(company);
      if (!c) {
        c = {
          node: { company, named: settled !== null, bins: [], fills: 0, revenueCents: 0, marginCents: 0, marginPerFillCents: 0 },
          bins: new Map(),
        };
        companies.set(company, c);
      }
      add(c.node, share, f);

      const binKey = p.bin ?? "";
      let b = c.bins.get(binKey);
      if (!b) {
        b = { node: { bin: p.bin, groups: [], fills: 0, revenueCents: 0, marginCents: 0, mixedClassification: false }, groups: new Map() };
        c.bins.set(binKey, b);
      }
      add(b.node, share, f);

      // Two PCNs under one BIN and group are two plans, and are never folded together.
      const gKey = `${(p.pcn ?? "").trim().toUpperCase()}|${(p.groupNumber ?? "").trim().toUpperCase()}`;
      let g = b.groups.get(gKey);
      if (!g) {
        g = {
          node: {
            pcn: p.pcn,
            groupNumber: p.groupNumber,
            classification: plan?.classification ?? null,
            sponsorName: plan?.sponsorName ?? null,
            contracts: [],
            fills: 0,
            revenueCents: 0,
            marginCents: 0,
          },
          contracts: new Map(),
        };
        b.groups.set(gKey, g);
      }
      add(g.node, share, f);

      const cid = contractId;
      const cKey = cid ?? "";
      let ct = g.contracts.get(cKey);
      if (!ct) {
        ct = {
          contractId: cid,
          contractFileName: link?.contractFileName ?? null,
          fills: 0,
          revenueCents: 0,
          marginCents: 0,
          unlinked: !link?.contractFileName,
        };
        g.contracts.set(cKey, ct);
      }
      ct.fills += share;
      ct.revenueCents += Math.round(f.revenueCents * share);
      ct.marginCents += Math.round((f.marginCents ?? 0) * share);
    }
  }

  const out: CompanyNode[] = [];
  for (const c of companies.values()) {
    for (const b of c.bins.values()) {
      for (const g of b.groups.values()) {
        g.node.contracts = [...g.contracts.values()].sort((x, y) => y.revenueCents - x.revenueCents);
        b.node.groups.push(g.node);
      }
      b.node.groups.sort((x, y) => y.revenueCents - x.revenueCents);
      // One BIN carrying an ERISA plan and a fully-insured one is the usual case, and the reason
      // the floor can never be decided at BIN level.
      const kinds = new Set(b.node.groups.map((g) => g.classification).filter(Boolean));
      b.node.mixedClassification = kinds.size > 1;
      c.node.bins.push(b.node);
    }
    c.node.bins.sort((x, y) => y.revenueCents - x.revenueCents);
    c.node.marginPerFillCents = c.node.fills > 0 ? Math.round(c.node.marginCents / c.node.fills) : 0;
    out.push(c.node);
  }
  out.sort((a, b) => b.revenueCents - a.revenueCents);

  return { companies: out, unnamedRevenueCents: out.filter((c) => !c.named).reduce((n, c) => n + c.revenueCents, 0) };
}
