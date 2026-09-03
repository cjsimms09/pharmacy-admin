import "server-only";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { parseCents, parseQuantityThousandths, isPricingUnit, receivedCents } from "./money";
import { readSheetAsObjects, excelSerialToIso } from "./xlsx";
import { parseCsv, buildPbmResolver } from "./reference";
import { SB20_MIN_DISPENSING_FEE_CENTS } from "./reimbursement-rules";
import { CLASS_INFO, planKey } from "./plans";

/**
 * Loading a PioneerRx export and attaching every claim to the payer that priced it.
 *
 * Column names are matched loosely because a report writer will rename things, but a column that
 * is not recognised is reported rather than ignored — a silently dropped column is how a claims
 * file starts producing wrong totals that look right.
 *
 * Nothing is inferred. A quantity that will not parse stays null, and a null quantity means the
 * claim cannot be priced, which is a state the rest of the system already knows how to carry.
 */

/**
 * What each field can be called. First match wins, so the exact PioneerRx name leads.
 * Comparison is on a normalised key: lowercase, alphanumeric only.
 */
const COLUMNS = {
  rxNumber: ["rx number", "rxnumber", "prescription number", "rx"],
  fillNumber: ["fill number", "refill number", "refill", "fill"],
  dateFilled: ["date filled", "datefilled", "date of service", "fill date"],
  ndc11: ["dispensed item ndc", "ndc", "dispensed ndc", "item ndc"],
  itemName: ["dispensed item name", "item name", "drug name", "dispensed item"],
  bin: ["primary third party bin", "bin", "bin number", "iin"],
  pcn: ["primary third party pcn", "pcn", "processor control number"],
  groupNumber: ["primary group number", "group number", "group", "group id"],
  networkId: ["primary network reimbursement", "network reimbursement id", "network reimbursement", "network id"],
  planId: ["primary received edi plan id", "plan id", "received edi plan id"],
  planType: ["primary plan type", "plan type"],
  pharmacyServiceType: ["primary third party pharmacy service type", "pharmacy service type"],
  basisOfReimbursement: ["primary basis of reimbursement", "basis of reimbursement", "basis of reimbursement determination"],
  basisOfCostDetermination: ["primary basis of cost determination", "basis of cost determination"],
  payerLabel: ["primary third party", "payer", "third party", "plan name", "primary"],
  quantity: ["dispensed quantity", "quantity dispensed", "qty dispensed", "quantity"],
  quantityUnit: ["quantity unit of measure", "unit of measure", "uom", "dispensing unit"],
  daysSupply: ["days supply", "dayssupply", "day supply"],
  remit: ["primary remit amount", "remit amount", "total amount paid", "amount paid"],
  copay: ["primary copay amount", "copay amount", "patient pay amount", "copay"],
  awp: ["dispensed awp", "awp"],
  acquisition: ["acquisition cost", "acquisition", "cost"],
  grossProfit: ["gross profit", "profit"],
  ingredientPaid: ["ingredient cost paid", "ingredient paid"],
  dispensingFeePaid: ["dispensing fee paid", "dispense fee paid"],
  daw: ["daw", "product selection code", "daw code"],
} as const;

type FieldName = keyof typeof COLUMNS;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Maps the file's headers onto our fields, and reports what went unused. */
export function mapColumns(headers: string[]): { map: Partial<Record<FieldName, string>>; unmapped: string[] } {
  const byNorm = new Map<string, string>();
  for (const h of headers) if (h.trim()) byNorm.set(norm(h), h);

  const map: Partial<Record<FieldName, string>> = {};
  const used = new Set<string>();
  for (const [field, names] of Object.entries(COLUMNS) as [FieldName, readonly string[]][]) {
    for (const n of names) {
      const hit = byNorm.get(norm(n));
      if (hit && !used.has(hit)) {
        map[field] = hit;
        used.add(hit);
        break;
      }
    }
  }
  return { map, unmapped: headers.filter((h) => h.trim() && !used.has(h)) };
}

/** Accepts an ISO date, a US date, or the Excel serial PioneerRx actually sends. */
export function parseClaimDate(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  if (/^\d+(\.\d+)?$/.test(s)) return excelSerialToIso(Number(s));
  return null;
}

/** NDCs arrive with or without hyphens, and sometimes short of a leading zero. */
export function normalizeClaimNdc(raw: string | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  if (d.length === 11) return d;
  if (d.length === 10) return `0${d}`; // a leading zero lost to a numeric cell
  return null;
}

export type ImportReport = {
  importId: string;
  rowsRead: number;
  claimsAdded: number;
  duplicates: number;
  skipped: number;
  skipReasons: Record<string, number>;
  unmappedColumns: string[];
  unresolvedBins: string[];
  periodFrom: string | null;
  periodTo: string | null;
};

/**
 * Reads a claims export and stores it.
 *
 * A claim is identified by prescription number, fill number and date filled. Re-importing an
 * overlapping export is therefore safe and counted as duplicates rather than doubling the money.
 */
export async function importClaims(file: Buffer, fileName: string, userId: string): Promise<ImportReport> {
  const rows = /\.csv$/i.test(fileName)
    ? parseCsv(file.toString("utf8"))
    : readSheetAsObjects(file);

  const headers = rows.length ? Object.keys(rows[0]) : [];
  const { map, unmapped } = mapColumns(headers);

  const resolver = buildPbmResolver(
    await db.query.payerBins.findMany({ columns: { pbmName: true, aliases: true } }),
    null,
  );
  const binRows = await db.query.payerBins.findMany({ columns: { bin: true, pbmName: true } });
  const byBin = new Map<string, Set<string>>();
  for (const b of binRows) {
    if (!byBin.has(b.bin)) byBin.set(b.bin, new Set());
    byBin.get(b.bin)!.add(b.pbmName);
  }

  const importId = newId();
  const skipReasons: Record<string, number> = {};
  const unresolvedBins = new Set<string>();
  const skip = (why: string) => { skipReasons[why] = (skipReasons[why] ?? 0) + 1; };

  let added = 0;
  let duplicates = 0;
  let from: string | null = null;
  let to: string | null = null;

  const existing = new Set(
    (await db.query.claims.findMany({ columns: { rxNumber: true, fillNumber: true, dateFilled: true } }))
      .map((c) => `${c.rxNumber}|${c.fillNumber ?? ""}|${c.dateFilled}`),
  );

  await db.insert(schema.claimImports).values({
    id: importId, fileName, rowsRead: rows.length, createdBy: userId,
  });

  for (const r of rows) {
    const g = (f: FieldName) => (map[f] ? r[map[f]!] : undefined);

    const rxNumber = (g("rxNumber") ?? "").trim();
    const dateFilled = parseClaimDate(g("dateFilled"));
    if (!rxNumber) { skip("no prescription number"); continue; }
    if (!dateFilled) { skip("no readable fill date"); continue; }

    const fillRaw = (g("fillNumber") ?? "").trim();
    const fillNumber = /^\d+$/.test(fillRaw) ? Number(fillRaw) : null;

    const key = `${rxNumber}|${fillNumber ?? ""}|${dateFilled}`;
    if (existing.has(key)) { duplicates++; continue; }
    existing.add(key);

    if (!from || dateFilled < from) from = dateFilled;
    if (!to || dateFilled > to) to = dateFilled;

    const bin = (g("bin") ?? "").replace(/\D/g, "") || null;
    const payerLabel = (g("payerLabel") ?? "").trim() || null;
    const resolved = resolvePayer(bin, payerLabel, byBin, resolver);
    if (bin && !resolved.pbmName) unresolvedBins.add(bin);

    const unitRaw = (g("quantityUnit") ?? "").trim().toUpperCase();

    await db.insert(schema.claims).values({
      id: newId(),
      importId,
      rxNumber,
      fillNumber,
      dateFilled,
      ndc11: normalizeClaimNdc(g("ndc11")),
      itemName: (g("itemName") ?? "").trim() || null,
      bin,
      pcn: (g("pcn") ?? "").trim() || null,
      groupNumber: (g("groupNumber") ?? "").trim() || null,
      networkId: (g("networkId") ?? "").trim() || null,
      planId: (g("planId") ?? "").trim() || null,
      planType: (g("planType") ?? "").trim() || null,
      pharmacyServiceType: (g("pharmacyServiceType") ?? "").trim() || null,
      basisOfReimbursement: (g("basisOfReimbursement") ?? "").trim() || null,
      basisOfCostDetermination: (g("basisOfCostDetermination") ?? "").trim() || null,
      payerLabel,
      pbmName: resolved.pbmName,
      matchMethod: resolved.method,
      payerAmbiguous: resolved.ambiguous,
      quantityThousandths: parseQuantityThousandths(g("quantity")),
      quantityUnit: isPricingUnit(unitRaw) ? unitRaw : null,
      daysSupply: /^\d+$/.test((g("daysSupply") ?? "").trim()) ? Number(g("daysSupply")) : null,
      remitCents: parseCents(g("remit")),
      copayCents: parseCents(g("copay")),
      awpCents: parseCents(g("awp")),
      acquisitionCents: parseCents(g("acquisition")),
      grossProfitCents: parseCents(g("grossProfit")),
      ingredientPaidCents: parseCents(g("ingredientPaid")),
      dispensingFeePaidCents: parseCents(g("dispensingFeePaid")),
      daw: (g("daw") ?? "").trim() || null,
      rawJson: JSON.stringify(r),
    });
    added++;
  }

  const skipped = Object.values(skipReasons).reduce((a, b) => a + b, 0);
  await db.update(schema.claimImports).set({
    claimsAdded: added,
    duplicates,
    skipped,
    skipReasons: JSON.stringify(skipReasons),
    unmappedColumns: JSON.stringify(unmapped),
    periodFrom: from,
    periodTo: to,
  }).where(sql`${schema.claimImports.id} = ${importId}`);

  return {
    importId, rowsRead: rows.length, claimsAdded: added, duplicates, skipped,
    skipReasons, unmappedColumns: unmapped, unresolvedBins: [...unresolvedBins].sort(),
    periodFrom: from, periodTo: to,
  };
}

export type PayerMatch = {
  pbmName: string | null;
  method: "bin" | "bin_and_name" | "name" | "unresolved";
  ambiguous: boolean;
};

/**
 * Settles which payer priced a claim.
 *
 * The BIN comes first. Where a BIN is shared — sixty of them are — the payer name on the export
 * is run through the same resolver the reference data uses, and is accepted only if it names one
 * of the BIN's own candidates. A name that disagrees with the BIN does not win; the claim is
 * marked ambiguous instead, because a claim attached to the wrong contract is worse than one
 * attached to none.
 */
export function resolvePayer(
  bin: string | null,
  payerLabel: string | null,
  byBin: Map<string, Set<string>>,
  resolver: { resolve: (s: string) => { name: string } },
): PayerMatch {
  const candidates = bin ? [...(byBin.get(bin) ?? [])] : [];
  const named = payerLabel ? resolver.resolve(payerLabel).name : null;

  if (candidates.length === 1) return { pbmName: candidates[0], method: "bin", ambiguous: false };

  if (candidates.length > 1) {
    if (named && candidates.includes(named)) return { pbmName: named, method: "bin_and_name", ambiguous: false };
    return { pbmName: null, method: "unresolved", ambiguous: true };
  }

  // No BIN listing entry. The name alone is weaker evidence, so it is recorded as such.
  if (named && named !== payerLabel) return { pbmName: named, method: "name", ambiguous: false };
  return { pbmName: null, method: "unresolved", ambiguous: false };
}

/**
 * Claims worth looking at first, and why.
 *
 * Two flags, both deliberately conservative. Below cost uses the gross profit the system itself
 * computed, so it is the pharmacy's own figure rather than ours. Under the statutory fee only
 * marks commercial claims that received less in total than the Kansas dispensing fee alone —
 * before any ingredient cost — which is a floor no contract can argue its way under. Neither is
 * a filing; both are a reason to look.
 */
export async function claimFlags() {
  const rows = await db.query.claims.findMany({
    orderBy: (c, { asc }) => [asc(c.dateFilled)],
  });

  const belowCost = rows.filter((c) => c.grossProfitCents !== null && c.grossProfitCents < 0);

  // Which claims are candidates for the statutory floor is a question about the plan, not about
  // the claim. PioneerRx's plan type cannot answer it: a cash discount programme adjudicates as
  // "Standard" and a low payment on one is correct, not a shortfall. So the register decides,
  // and a plan nobody has classified is held back rather than counted either way.
  const groups = await db.query.planGroups.findMany();
  const byKey = new Map(groups.map((g) => [planKey(g.bin, g.groupNumber), g.classification]));
  const classOf = (c: { bin: string | null; groupNumber: string | null }) => byKey.get(planKey(c.bin, c.groupNumber));

  const inScope = rows.filter((c) => {
    const cls = classOf(c);
    return cls !== undefined && CLASS_INFO[cls].inScope;
  });
  const undetermined = rows.filter((c) => {
    const cls = classOf(c);
    return cls === undefined || cls === "unknown";
  });

  const under = (xs: typeof rows) =>
    xs.filter((c) => {
      const got = receivedCents(c.remitCents, c.copayCents);
      return got !== null && got < SB20_MIN_DISPENSING_FEE_CENTS;
    });
  const underFee = under(inScope);
  const underFeeUndetermined = under(undetermined);

  const sum = (xs: { grossProfitCents: number | null }[]) =>
    xs.reduce((s, x) => s + (x.grossProfitCents ?? 0), 0);

  const shortfall = (xs: typeof rows) =>
    xs.reduce((s, c) => s + (SB20_MIN_DISPENSING_FEE_CENTS - (receivedCents(c.remitCents, c.copayCents) ?? 0)), 0);

  return {
    total: rows.length,
    belowCost,
    belowCostTotalCents: sum(belowCost),
    inScope: inScope.length,
    undetermined: undetermined.length,
    underFeeUndetermined: underFeeUndetermined.length,
    underFeeUndeterminedShortfallCents: shortfall(underFeeUndetermined),
    underFee,
    underFeeShortfallCents: shortfall(underFee),
    unpriceable: rows.filter((c) => c.quantityThousandths === null).length,
    // Two different problems, needing two different actions. A BIN shared by several PBMs is
    // settled by reading the PCN or network off the claim. A BIN absent from the listing means
    // we hold no contract reference for that payer at all, which is a chase, not a lookup.
    ambiguousPayer: rows.filter((c) => c.payerAmbiguous).length,
    unlistedBins: [...new Set(rows.filter((c) => !c.pbmName && !c.payerAmbiguous && c.bin).map((c) => c.bin!))].sort(),
    unlistedClaims: rows.filter((c) => !c.pbmName && !c.payerAmbiguous).length,
  };
}

/** Claims grouped by the payer that priced them — the view a contract review works from. */
export async function claimsByPayer() {
  const rows = await db.query.claims.findMany();
  type Row = { pbmName: string; claims: number; receivedCents: number; profitCents: number; belowCost: number; bins: Set<string>; networks: Set<string> };
  const map = new Map<string, Row>();
  for (const c of rows) {
    const name = c.pbmName ?? (c.payerLabel ? `${c.payerLabel} (unmatched)` : "Unidentified payer");
    let e = map.get(name);
    if (!e) {
      e = { pbmName: name, claims: 0, receivedCents: 0, profitCents: 0, belowCost: 0, bins: new Set(), networks: new Set() };
      map.set(name, e);
    }
    e.claims++;
    e.receivedCents += receivedCents(c.remitCents, c.copayCents) ?? 0;
    e.profitCents += c.grossProfitCents ?? 0;
    if ((c.grossProfitCents ?? 0) < 0) e.belowCost++;
    if (c.bin) e.bins.add(c.bin);
    if (c.networkId) e.networks.add(c.networkId);
  }
  return [...map.values()]
    .map((e) => ({ ...e, bins: [...e.bins].sort(), networks: [...e.networks].sort() }))
    .sort((a, b) => b.claims - a.claims);
}

export async function claimImports() {
  return db.query.claimImports.findMany({ orderBy: (i, { desc }) => [desc(i.createdAt)] });
}
