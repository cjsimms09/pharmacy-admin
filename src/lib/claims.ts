import "server-only";
import { sql, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "./crypto";
import { parseCents, parseQuantityThousandths, isPricingUnit, receivedCents } from "./money";
import { readSheetAsObjects, excelSerialToIso } from "./xlsx";
import { parseCsv, buildPbmResolver } from "./reference";
import { SB20_MIN_DISPENSING_FEE_CENTS } from "./reimbursement-rules";
import { fillKey } from "./fills";
import { remitCheck } from "./remit-check";
import { CLASS_INFO, planLookup } from "./plans";
import { readNdc } from "./ndc";
import { heldNdcs } from "./ndc-held";
import type { Transaction } from "./rx-transactions";

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
/**
 * Every header this recognises, per field, first match winning.
 *
 * Exported because the question "what do I ask the report writer for" has to be answerable before
 * anybody has a file to check. The names leading each list are PioneerRx's own, so a report built
 * from them imports without anybody renaming a column.
 */
export const COLUMNS = {
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
  const us2 = /^(\d{1,2})\/(\d{1,2})\/(\d{2})(?!\d)/.exec(s);
  if (us2) return `20${us2[3]}-${us2[1].padStart(2, "0")}-${us2[2].padStart(2, "0")}`;
  if (/^\d+(\.\d+)?$/.test(s)) return excelSerialToIso(Number(s));
  return null;
}

/**
 * NDCs arrive with or without hyphens, and sometimes as ten bare digits.
 *
 * The hyphenated forms convert exactly. A bare ten-digit code is settled only against the NDCs
 * the site already holds (pass `isKnown`), because "0" in front is right for one of the three
 * FDA layouts and wrong for the other two — see ndc.ts. Unresolved comes back null, and the
 * import counts it, rather than filing the claim under a product it may not be.
 */
export function normalizeClaimNdc(raw: string | undefined, isKnown?: (ndc11: string) => boolean): string | null {
  return readNdc(raw, isKnown).ndc11;
}

export type ImportReport = {
  importId: string;
  rowsRead: number;
  claimsAdded: number;
  duplicates: number;
  /** Reversals held but never paired, matched to the claims they cancel by this load. */
  reversalsPaired?: number;
  /** What the report itself said this file came to: total sales, and total gross profit. */
  reportSalesCents?: number | null;
  reportGrossProfitCents?: number | null;
  /** The same gross profit added from the rows this reader got out of the file. */
  readGrossProfitCents?: number;
  /**
   * Rows already held that this file re-stated.
   *
   * Written whether or not the figures actually moved — the site does not know what the previous
   * file said, only what this one says, and the last word is the right one. Compared against
   * `duplicates` it is also the check that a re-sent report landed: the two should match, and a
   * restated count well below the duplicate count means rows did not line up and somebody should
   * look before trusting the totals.
   */
  restated?: number;
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
  const pending: (typeof schema.claims.$inferInsert)[] = [];
  let from: string | null = null;
  let to: string | null = null;

  const existing = new Set(
    (await db.query.claims.findMany({ columns: { rxNumber: true, fillNumber: true, dateFilled: true } }))
      .map((c) => `${c.rxNumber}|${c.fillNumber ?? ""}|${c.dateFilled}`),
  );
  // For settling a bare ten-digit NDC against a product we already know (see ndc.ts).
  const held = await heldNdcs();
  const isKnown = (n: string) => held.has(n);

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

    // The claim is kept whether or not its NDC can be read — the money is real either way — but
    // an NDC that cannot be settled is counted so the gap is visible on the import line.
    const ndc = readNdc(g("ndc11"), isKnown);
    if (ndc.ndc11 === null && (g("ndc11") ?? "").trim()) skip(`kept without an NDC: ${ndc.reason}`);

    pending.push({
      id: newId(),
      importId,
      rxNumber,
      fillNumber,
      dateFilled,
      ndc11: ndc.ndc11,
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

    // Batched: one statement per claim made a year of history take minutes, and the connection
    // is serialized, so those were minutes with the whole site stopped.
    if (pending.length >= 300) {
      await db.insert(schema.claims).values(pending);
      pending.length = 0;
    }
  }
  if (pending.length > 0) await db.insert(schema.claims).values(pending);

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

export type TransactionImportReport = ImportReport & {
  reversed: number;
  unmatchedReversals: number;
  /** Paid claims stored from this file that had not been picked up when the report was drawn. */
  notYetSold: number;
  /** Claims held without a sale date that this file showed sold. */
  nowSold: number;
  period: { from: string; to: string } | null;
  problems: string[];
};

/**
 * Reads the daily "Rx Transaction Details By Submission Type" report and stores it.
 *
 * Every row is a transaction; the parser reads them and planTransactions decides what each one
 * does: a paid row becomes a claim, a reversal marks the claim it cancels as reversed (whether
 * that claim is in this file or was stored on an earlier day), and a rejected row is counted. A
 * paid row with no completed date — transmitted, not yet picked up — is stored too, with the sale
 * date blank, because the report is drawn by transmission day and the row will not come round
 * again once it sells (see planTransactions). Every transaction key, including a reversal's, is
 * stored, so the same day's report arriving twice changes nothing the second time — except that a
 * re-sent row now carrying a completed date fills the sale date in.
 *
 * The drug name is not in the report. It is filled in from the supplier catalogues, then from
 * NADAC, by NDC — so a claim reads as "ATORVASTATIN 40MG TAB" on every page rather than an NDC.
 */
export async function importRxTransactions(file: Buffer, fileName: string, userId: string): Promise<TransactionImportReport> {
  const { parseRxTransactions, planTransactions, mdyToIso } = await import("./rx-transactions");
  const parsed = parseRxTransactions(file.toString("utf8"));
  const importId = newId();
  const rowsRead = parsed.rows.length;

  /*
   * A ten-digit NDC with no hyphens is settled here, not in the reader.
   *
   * The reader is pure and cannot know which products the site holds; this can. A bare code that
   * matches exactly one NDC already in the catalogues, NADAC or the claims is that product. One
   * that matches none or several stays without an NDC — the claim is still stored with its money,
   * it simply cannot be priced until somebody looks — and the count says how many.
   */
  const bare = parsed.rows.filter((t) => t.ndc11 === null && t.ndcBare10);
  if (bare.length > 0) {
    const held = await heldNdcs();
    let unresolved = 0;
    for (const t of bare) {
      const r = readNdc(t.ndcBare10, (n) => held.has(n));
      if (r.ndc11) t.ndc11 = r.ndc11;
      else unresolved++;
    }
    if (unresolved > 0) parsed.reasons["kept without an NDC: 10-digit NDC with no hyphens matched no product we hold, or more than one"] = unresolved;
  }

  /*
   * The report's own bottom line, and ours over the rows we actually read.
   *
   * Kept side by side because together they answer "did we read all of it" — a question nothing
   * inside our own arithmetic can ask. A row set aside for a status this reader does not recognise
   * makes the file quietly short by exactly its gross profit, and the load otherwise looks perfect.
   */
  const readGrossProfitCents = parsed.rows.reduce((n, t) => n + (t.grossProfitCents ?? 0), 0);
  await db.insert(schema.claimImports).values({
    id: importId,
    fileName,
    rowsRead,
    createdBy: userId,
    reportSalesCents: parsed.grandTotal?.salesCents ?? null,
    reportAcquisitionCents: parsed.grandTotal?.acquisitionCents ?? null,
    reportGrossProfitCents: parsed.grandTotal?.grossProfitCents ?? null,
    readGrossProfitCents,
  });

  const base: TransactionImportReport = {
    importId, rowsRead, claimsAdded: 0, duplicates: 0, skipped: parsed.skipped, skipReasons: { ...parsed.reasons },
    unmappedColumns: [], unresolvedBins: [], periodFrom: parsed.period?.from ?? null, periodTo: parsed.period?.to ?? null,
    reversed: 0, unmatchedReversals: 0, notYetSold: 0, nowSold: 0, period: parsed.period, problems: [...parsed.problems],
  };
  const finish = async (r: TransactionImportReport) => {
    await db.update(schema.claimImports).set({
      claimsAdded: r.claimsAdded, duplicates: r.duplicates, skipped: r.skipped, skipReasons: JSON.stringify(r.skipReasons),
      unmappedColumns: JSON.stringify([]), periodFrom: r.periodFrom, periodTo: r.periodTo,
    }).where(sql`${schema.claimImports.id} = ${importId}`);
    return r;
  };
  if (parsed.rows.length === 0) return finish(base);

  // What is already held: every transaction key (paid rows and the reversals that cancelled
  // them), and the paid claims a reversal in this file might cancel.
  const held = await db.query.claims.findMany({
    where: eq(schema.claims.source, "transaction_report"),
    columns: { id: true, transactionKey: true, reversalKey: true, status: true, completedAt: true, rxNumber: true, fillNumber: true, bin: true, ndc11: true, remitCents: true, copayCents: true },
  });
  const keys = new Set<string>();
  const unsold = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const c of held) {
    if (c.transactionKey) {
      keys.add(c.transactionKey);
      byKey.set(c.transactionKey, c.id);
      if (!c.completedAt) unsold.set(c.transactionKey, c.id);
    }
    if (c.reversalKey) keys.add(c.reversalKey);
  }
  const paid = held.filter((c) => c.status === "paid");

  const plan = planTransactions(parsed.rows, { keys, paid, unsold, byKey }, { ignoreBins: ["028249"] });
  const skipReasons = { ...parsed.reasons };
  for (const s of plan.skipped) skipReasons[s.why] = (skipReasons[s.why] ?? 0) + 1;

  const resolver = buildPbmResolver(await db.query.payerBins.findMany({ columns: { pbmName: true, aliases: true } }), null);
  const binRows = await db.query.payerBins.findMany({ columns: { bin: true, pbmName: true } });
  const byBin = new Map<string, Set<string>>();
  for (const b of binRows) {
    if (!byBin.has(b.bin)) byBin.set(b.bin, new Set());
    byBin.get(b.bin)!.add(b.pbmName);
  }
  const names = await drugNamesByNdc([
    ...plan.insertPaid, ...plan.insertReversedPaid.map((x) => x.paid), ...plan.insertUnmatchedReversal,
  ].map((t) => t.ndc11).filter((x): x is string => !!x));
  const unresolvedBins = new Set<string>();
  const reversedOn = parsed.period?.from ?? new Date().toISOString().slice(0, 10);

  const toClaim = (t: Transaction, status: "paid" | "reversed", reversal?: Transaction): typeof schema.claims.$inferInsert => {
    const resolved = resolvePayer(t.bin, t.payerLabel, byBin, resolver);
    if (t.bin && !resolved.pbmName) unresolvedBins.add(t.bin);
    return {
      id: newId(), importId, rxNumber: t.rxNumber, fillNumber: t.fillNumber, dateFilled: t.dateFilled,
      ndc11: t.ndc11, itemName: t.ndc11 ? names.get(t.ndc11) ?? null : null,
      bin: t.bin, pcn: t.pcn, groupNumber: t.groupNumber, networkId: t.networkId,
      payerLabel: t.payerLabel, pbmName: resolved.pbmName, matchMethod: resolved.method, payerAmbiguous: resolved.ambiguous,
      quantityThousandths: t.quantityThousandths, quantityUnit: null,
      // The report now carries it; without it no contract rate written per days-supply band applies.
      daysSupply: t.daysSupply,
      remitCents: t.remitCents, copayCents: t.copayCents, patientTotalCents: t.patientTotalCents,
      acquisitionCents: t.acquisitionCents, grossProfitCents: t.grossProfitCents,
      expectedFacilitatorCents: t.expectedFacilitatorCents ?? null,
      cashPlan: t.cashPlan === true,
      onAccount: t.onAccount === true,
      ingredientPaidCents: t.ingredientPaidCents, dispensingFeePaidCents: t.dispensingFeeCents,
      status, reversedOn: status === "reversed" ? reversedOn : null,
      completedAt: t.completedAt ? mdyToIso(t.completedAt) : null,
      transactionKey: t.transactionKey, reversalKey: reversal?.transactionKey ?? (status === "reversed" && !reversal ? t.transactionKey : null),
      source: "transaction_report", rawJson: JSON.stringify(t.raw),
    };
  };

  const inserts: (typeof schema.claims.$inferInsert)[] = [
    ...plan.insertPaid.map((t) => toClaim(t, "paid")),
    ...plan.insertReversedPaid.map(({ paid, reversal }) => toClaim(paid, "reversed", reversal)),
    ...plan.insertUnmatchedReversal.map((t) => toClaim(t, "reversed")),
  ];
  for (let i = 0; i < inserts.length; i += 300) await db.insert(schema.claims).values(inserts.slice(i, i + 300));
  for (const r of plan.reverseExisting) {
    await db.update(schema.claims).set({ status: "reversed", reversedOn, reversalKey: r.reversal.transactionKey }).where(eq(schema.claims.id, r.claimId));
  }
  for (const s of plan.markSold) {
    await db.update(schema.claims).set({ completedAt: mdyToIso(s.completedAt) }).where(eq(schema.claims.id, s.claimId));
  }
  /*
   * What the report now says about a claim already held, written over what it used to say.
   *
   * Only the report's own figures — never this site's status, its reversal pairing or the payments
   * matched to it. Re-sending a corrected file is how a restated gross profit and a newly added
   * column reach rows that were loaded before either existed, and without this the pharmacy would
   * have had to delete its claims and start again to get the truth in.
   */
  let restated = 0;
  for (const r of plan.refresh) {
    const changed =
      r.txn.grossProfitCents !== null || r.txn.expectedFacilitatorCents !== null || r.txn.patientTotalCents !== null;
    if (!changed) continue;
    await db
      .update(schema.claims)
      .set({
        remitCents: r.txn.remitCents,
        copayCents: r.txn.copayCents,
        patientTotalCents: r.txn.patientTotalCents,
        acquisitionCents: r.txn.acquisitionCents,
        grossProfitCents: r.txn.grossProfitCents,
        expectedFacilitatorCents: r.txn.expectedFacilitatorCents ?? null,
        dispensingFeePaidCents: r.txn.dispensingFeeCents,
        ingredientPaidCents: r.txn.ingredientPaidCents,
        quantityThousandths: r.txn.quantityThousandths,
        cashPlan: r.txn.cashPlan === true,
        onAccount: r.txn.onAccount === true,
        rawJson: JSON.stringify(r.txn.raw),
      })
      .where(eq(schema.claims.id, r.claimId));
    restated++;
  }

  /*
   * Reversals that could not be paired as they arrived, paired now against everything held.
   *
   * Cheap, and it is the only thing that can rescue a pair stranded by an earlier load — where the
   * claim stands as live revenue and nothing about it looks wrong.
   */
  const repaired = await repairReversals();

  const dates = inserts.map((c) => c.dateFilled).sort();
  return finish({
    ...base,
    claimsAdded: plan.insertPaid.length,
    duplicates: plan.duplicates,
    skipped: parsed.skipped + plan.skipped.length,
    skipReasons,
    unresolvedBins: [...unresolvedBins].sort(),
    periodFrom: parsed.period?.from ?? dates[0] ?? null,
    periodTo: parsed.period?.to ?? dates[dates.length - 1] ?? null,
    reversed: plan.insertReversedPaid.length + plan.reverseExisting.length,
    unmatchedReversals: plan.insertUnmatchedReversal.length,
    notYetSold: plan.insertPaid.filter((t) => !t.completedAt).length,
    nowSold: plan.markSold.length,
    restated,
    reversalsPaired: repaired.paired,
    reportSalesCents: parsed.grandTotal?.salesCents ?? null,
    reportGrossProfitCents: parsed.grandTotal?.grossProfitCents ?? null,
    readGrossProfitCents,
  });
}

/**
 * Marks claims reversed where the reversal that cancels them is already held but never got paired.
 *
 * Pairing happens as a file is read, which works only while both halves are in the same file or the
 * claim was stored before its reversal arrived. Everything else leaves the pair stranded: a reversal
 * loaded before its claim, a file re-sent so that the reversal row is skipped as a duplicate before
 * it can be matched, or an import that failed halfway. The claim then stands as live revenue for
 * ever, and nothing about it looks wrong.
 *
 * Rx 331488 is what this is for. It ran for sixty tablets at $1,204.25, was reversed, and re-ran for
 * thirty at $607.38 — a $30.62 fill. With the reversal stranded, both runs counted: $1,811.63 of
 * revenue against one bottle, and a $658.11 profit on a script that made thirty dollars.
 *
 * Run after every import, and safe to run at any time: it only ever matches a reversal to a claim
 * whose figures it exactly negates, and only where that leaves no ambiguity.
 */
/**
 * A held reversal, and the live claim it cancels — as a rule, apart from the database.
 *
 * Extracted so the case that produced it can be reproduced: a daily file carrying a reversal and a
 * rebill but not the original run, then a wider file carrying all three. The reversal is stored
 * matching nothing; the original arrives later and is stored live; and the reversal is skipped as a
 * duplicate before it can pair with it. Both runs then count, one bottle is billed twice, and
 * nothing on the screen looks wrong.
 */
export type Pairable = {
  id: string;
  rxNumber: string;
  fillNumber: number | null;
  bin: string | null;
  ndc11: string | null;
  status: string;
  remitCents: number | null;
  copayCents: number | null;
  transactionKey: string | null;
  reversalKey: string | null;
};

/** A reversal held that was never matched to anything: negative, reversed, pointing at itself. */
export function isStrandedReversal(c: Pairable): boolean {
  return (c.remitCents ?? 0) < 0 && c.status === "reversed" && c.reversalKey !== null && c.reversalKey === c.transactionKey;
}

/**
 * The live claim a stranded reversal cancels, or null with the reason it could not be told.
 *
 * Exactly one, or nothing. Two claims a reversal could equally well cancel is not an answer, and
 * cancelling the wrong run of a prescription deletes revenue that was really earned.
 */
export function claimCancelledBy(rev: Pairable, live: Pairable[]): { hit: Pairable } | { hit: null; why: string } {
  const same = (a: Pairable, b: Pairable) =>
    a.rxNumber === b.rxNumber && a.fillNumber === b.fillNumber && a.bin === b.bin && a.ndc11 === b.ndc11;
  const sameFill = live.filter((c) => c.status === "paid" && same(c, rev));
  const hits = sameFill.filter((c) => c.remitCents === -(rev.remitCents ?? 0) && c.copayCents === -(rev.copayCents ?? 0));
  if (hits.length === 1) return { hit: hits[0] };
  return {
    hit: null,
    why:
      sameFill.length === 0
        ? "no live claim is held for that prescription, fill, BIN and NDC — it reverses a dispensing from before this feed began"
        : hits.length === 0
          ? `${sameFill.length} live claim${sameFill.length === 1 ? " is" : "s are"} held for that fill but none has figures this exactly cancels`
          : `${hits.length} live claims match it equally well, and cancelling the wrong one would delete revenue that was really earned`,
  };
}

export async function repairReversals(): Promise<{ paired: number; strays: number; stillStranded: { rxNumber: string; dateFilled: string; amountCents: number; why: string }[] }> {
  const rows = await db.query.claims.findMany({
    where: eq(schema.claims.source, "transaction_report"),
    columns: {
      id: true, rxNumber: true, fillNumber: true, bin: true, ndc11: true, status: true,
      remitCents: true, copayCents: true, transactionKey: true, reversalKey: true, dateFilled: true,
    },
  });

  const key = (c: { rxNumber: string; fillNumber: number | null; bin: string | null; ndc11: string | null }) =>
    [c.rxNumber, c.fillNumber ?? "", c.bin ?? "", c.ndc11 ?? ""].join("|");

  /*
   * A reversal already recorded as one: negative money, held as reversed, pointing at itself
   * because nothing was found to pair it with when it arrived.
   */
  /*
   * A reversal is only stranded if nothing has since been cancelled by it.
   *
   * Once a later file brings in the run it cancels, the pairing marks that claim reversed and points
   * it at this row — but this row stays on file, still shaped like an orphan. Reporting it as
   * stranded afterwards is a complaint about work already done, and it is exactly the sort of
   * false alarm that teaches somebody to stop reading the list.
   */
  const strays = rows.filter((c) => isStrandedReversal(c) && !rows.some((o) => o.id !== c.id && o.reversalKey === c.transactionKey));
  if (strays.length === 0) return { paired: 0, strays: 0, stillStranded: [] };

  const live = new Map<string, typeof rows>();
  for (const c of rows) {
    if (c.status !== "paid") continue;
    const k = key(c);
    live.set(k, [...(live.get(k) ?? []), c]);
  }

  const used = new Set<string>();
  const stillStranded: { rxNumber: string; dateFilled: string; amountCents: number; why: string }[] = [];
  let paired = 0;
  for (const rev of strays) {
    const found = claimCancelledBy(rev, (live.get(key(rev)) ?? []).filter((c) => !used.has(c.id)));
    /*
     * Exactly one, or nothing. Two claims a reversal could equally well cancel is not an answer,
     * and cancelling the wrong run of a prescription deletes revenue that was really earned.
     *
     * Where it cannot pair, it says why. A repair that quietly does nothing is indistinguishable
     * from one that had nothing to do, and the pharmacist is left pressing a button and hoping.
     */
    if (found.hit === null) {
      stillStranded.push({ rxNumber: rev.rxNumber, dateFilled: rev.dateFilled, amountCents: rev.remitCents ?? 0, why: found.why });
      continue;
    }
    const hit = found.hit;
    used.add(hit.id);
    await db
      .update(schema.claims)
      .set({ status: "reversed", reversedOn: rev.dateFilled, reversalKey: rev.transactionKey })
      .where(eq(schema.claims.id, hit.id));
    paired++;
  }
  return { paired, strays: strays.length, stillStranded: stillStranded.slice(0, 20) };
}

/**
 * Re-reads every claim held from the row the report actually sent, and restates what it says.
 *
 * A fix to this reader does nothing for claims already stored. They were read by the old one, and
 * they keep its answers for ever — the patient's residual taken from the wrong column, a facilitator
 * payment in a column nothing knew about, the cash programme dropped, a reversal left unpaired so a
 * bottle counts twice. The pharmacy would otherwise have to delete its claims and start again to
 * get the truth in, which is not a thing anybody should have to do.
 *
 * The row as it arrived is kept against every claim, so nothing has to be re-sent: this reads that
 * row again through the current reader and writes back what it now says. Only figures the report
 * itself printed are touched — never a status, a reversal pairing, or a payment matched to a claim.
 *
 * Then it says whether the books balance, which is the only way to know it worked.
 */
export async function recheckHeldClaims(): Promise<{
  read: number;
  restated: number;
  reversalsPaired: number;
  /** Reversals held that had never been matched to anything, before this ran. */
  reversalsHeld: number;
  /** The ones that still could not be paired, and why — so a repair that did nothing says so. */
  stillStranded: { rxNumber: string; dateFilled: string; amountCents: number; why: string }[];
  paymentsMatched: number;
  before: { differenceCents: number; fillsOff: number };
  after: { differenceCents: number; fillsOff: number };
}> {
  const before = (await claimFlags({ all: true })).balance;

  const rows = await db.query.claims.findMany({
    where: eq(schema.claims.source, "transaction_report"),
    columns: {
      id: true, rawJson: true, bin: true, payerLabel: true,
      remitCents: true, copayCents: true, patientTotalCents: true, acquisitionCents: true,
      grossProfitCents: true, expectedFacilitatorCents: true, cashPlan: true, quantityThousandths: true,
    },
  });

  /* The report prints money as "$1,204.25" and a negative as "($1,204.25)". Blank is not zero. */
  const money = (v: string | undefined): number | null => {
    if (v === undefined) return null;
    const t = String(v).trim();
    if (t === "") return null;
    const n = Number(t.replace(/[$,()\s]/g, ""));
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100) * (/^\(.*\)$/.test(t) ? -1 : 1);
  };

  const { CASH_BINS, CASH_LABEL } = await import("./rx-transactions");
  const { parseQuantityThousandths } = await import("./money");

  let read = 0;
  let restated = 0;
  for (const r of rows) {
    if (!r.rawJson) continue;
    read++;
    let raw: Record<string, string>;
    try {
      raw = JSON.parse(r.rawJson) as Record<string, string>;
    } catch {
      continue; // A row whose text cannot be read is left as it was rather than guessed at.
    }

    const next = {
      remitCents: money(raw["Amount"]) ?? r.remitCents,
      copayCents: money(raw["Copay"]) ?? r.copayCents,
      patientTotalCents: money(raw["Total"]) ?? r.patientTotalCents,
      acquisitionCents: money(raw["Acq. Inv. Cost"]) ?? r.acquisitionCents,
      grossProfitCents: money(raw["GrossProfit"]) ?? r.grossProfitCents,
      // Only where the report actually carried the column; absence is not a promise of zero.
      expectedFacilitatorCents: raw["Est. MTF"] !== undefined ? money(raw["Est. MTF"]) : r.expectedFacilitatorCents,
      quantityThousandths: parseQuantityThousandths(raw["QTY"] ?? "") ?? r.quantityThousandths,
      cashPlan: CASH_BINS.has(r.bin ?? "") || CASH_LABEL.test(raw["Third Party"] ?? r.payerLabel ?? ""),
    };

    const changed = (Object.keys(next) as (keyof typeof next)[]).some((k) => next[k] !== (r as Record<string, unknown>)[k]);
    if (!changed) continue;
    await db.update(schema.claims).set(next).where(eq(schema.claims.id, r.id));
    restated++;
  }

  const reversals = await repairReversals();
  const { matchOrphanPayments } = await import("./claim-payments");
  const { matched } = await matchOrphanPayments();

  const after = (await claimFlags({ all: true })).balance;
  return {
    read,
    restated,
    reversalsPaired: reversals.paired,
    reversalsHeld: reversals.strays,
    stillStranded: reversals.stillStranded,
    paymentsMatched: matched,
    before: { differenceCents: before.differenceCents, fillsOff: before.fillsOff },
    after: { differenceCents: after.differenceCents, fillsOff: after.fillsOff },
  };
}

/** Drug names by NDC from what we already hold: the supplier catalogues first, then NADAC. */
async function drugNamesByNdc(ndcs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = [...new Set(ndcs)];
  for (let i = 0; i < want.length; i += 300) {
    const slice = want.slice(i, i + 300);
    const items = await db.query.supplierItems.findMany({ where: inArray(schema.supplierItems.ndc11, slice), columns: { ndc11: true, description: true } });
    for (const it of items) if (it.description && !out.has(it.ndc11)) out.set(it.ndc11, it.description);
    const missing = slice.filter((n) => !out.has(n));
    if (missing.length) {
      const nad = await db.query.nadacPrices.findMany({ where: inArray(schema.nadacPrices.ndc11, missing), columns: { ndc11: true, description: true } });
      for (const n of nad) if (n.description && !out.has(n.ndc11)) out.set(n.ndc11, n.description);
    }
  }
  return out;
}

/** A one-line account of a transaction-report import, for the inbox and the claims page. */
export function describeTransactionImport(r: TransactionImportReport): string {
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const bits = [`${r.claimsAdded.toLocaleString()} paid claim${r.claimsAdded === 1 ? "" : "s"} added`];
  if (r.reversed) bits.push(`${r.reversed} reversed`);
  if (r.unmatchedReversals) bits.push(`${r.unmatchedReversals} reversal${r.unmatchedReversals === 1 ? "" : "s"} matched no claim we hold (kept, marked reversed)`);
  if (r.notYetSold) bits.push(`${r.notYetSold} of them not yet picked up when the report ran (kept; a return to stock comes in as a reversal)`);
  if (r.nowSold) bits.push(`${r.nowSold} held earlier now shown sold`);
  if (r.duplicates) bits.push(`${r.duplicates} already held`);
  if (r.reversalsPaired)
    bits.push(
      `${r.reversalsPaired} reversal${r.reversalsPaired === 1 ? "" : "s"} held from an earlier load finally matched the claim${r.reversalsPaired === 1 ? "" : "s"} they cancel, which had been standing as live revenue`,
    );
  if (r.restated) bits.push(`${r.restated} of those re-read from this file, so a figure the report has since corrected replaces the one held`);
  const other = Object.entries(r.skipReasons).filter(([k]) => !/not yet sold/.test(k));
  if (other.length) bits.push(other.map(([k, v]) => `${v} ${k}`).join(", "));
  if (r.period) bits.push(`claims transmitted ${r.period.from}${r.period.to !== r.period.from ? ` to ${r.period.to}` : ""}`);
  /*
   * The report's own answer, said out loud, and whether we got all of it.
   *
   * This is the only total in the building that nothing here computed, so it is worth printing even
   * when it agrees — and when it does not, the difference is exactly the rows that were set aside.
   */
  if (r.reportSalesCents !== null && r.reportSalesCents !== undefined) {
    const short =
      r.reportGrossProfitCents !== null && r.reportGrossProfitCents !== undefined && r.readGrossProfitCents !== undefined
        ? r.reportGrossProfitCents - r.readGrossProfitCents
        : 0;
    /*
     * The bridge from what this reader made of the file to what the report says the file came to.
     *
     * Every row is either read or set aside for a named reason, and the gross profit of the ones set
     * aside is exactly the difference between the two totals. Stated in full, because "our figure
     * and theirs differ" is only alarming until you can point at the rows, and on the live file the
     * whole of the difference is five rows carrying a status this reader does not know.
     */
    bits.push(
      `the report's own total for this file is ${money(r.reportSalesCents)} taken and ${money(r.reportGrossProfitCents ?? 0)} made` +
        (Math.abs(short) <= 2
          ? ", every penny of which this reader accounted for"
          : short < 0
            ? `, and this reader read ${money(r.readGrossProfitCents ?? 0)} of gross profit across the rows it could read — ${money(-short)} more, which is what sits on the rows it set aside and did not count`
            : `, and this reader accounted for ${money(r.readGrossProfitCents ?? 0)} of that — ${money(short)} sits on rows it could not read`),
    );
  }
  if (r.unresolvedBins.length) bits.push(`BINs not on the listing: ${r.unresolvedBins.join(", ")}`);
  return bits.join(". ") + "." + (r.problems.length ? " " + r.problems.join(" ") : "");
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
/**
 * Which claims a screen is asking about.
 *
 * The claims screen used to answer for every claim ever loaded, on every render — grouping thousands
 * of fills, pricing each against the whole federal NADAC table, and parsing the raw text of every row
 * — to show one day's work. It got slower every week, by design, because the answer grew with the
 * archive rather than with the question.
 *
 * A fill never spans two dates, so narrowing by the day dispensed splits nothing: every row of a
 * dispensing shares its date. That makes a day a safe unit to load.
 */
export type ClaimScope = {
  /** Inclusive, as YYYY-MM-DD. Both absent means the most recent day that has any claims. */
  from?: string | null;
  to?: string | null;
  /** A prescription number, with or without its fill suffix. */
  rx?: string | null;
  /** Any part of a payer's name or BIN. */
  payer?: string | null;
  /**
   * Every claim held, whatever the date.
   *
   * Has to be asked for. A screen answering about one day and a reconciliation answering about the
   * whole archive are different questions, and the difference between them is the sort of thing that
   * is invisible until a total is quietly a day's worth instead of a year's.
   */
  all?: boolean;
};

/** The most recent day this pharmacy dispensed anything, which is where the screen opens. */
export async function latestClaimDay(): Promise<string | null> {
  const rows = await db.query.claims.findMany({
    columns: { dateFilled: true },
    orderBy: (c, { desc }) => [desc(c.dateFilled)],
    limit: 1,
  });
  return rows[0]?.dateFilled ?? null;
}

export async function claimFlags(scope: ClaimScope = {}) {
  const { and, gte, lte, like, or } = await import("drizzle-orm");

  /*
   * Resolved once, here, so every figure on the screen is drawn from the same population — and so a
   * screen that shows one day cannot quietly report a balance struck over all of history.
   */
  const day = scope.all || scope.from || scope.to ? null : await latestClaimDay();
  const from = scope.from ?? day;
  const to = scope.to ?? day;

  const rx = (scope.rx ?? "").trim().replace(/-.*$/, "");
  const payer = (scope.payer ?? "").trim();

  const where = and(
    ...[
      from ? gte(schema.claims.dateFilled, from) : null,
      to ? lte(schema.claims.dateFilled, to) : null,
      rx ? like(schema.claims.rxNumber, `%${rx}%`) : null,
      payer
        ? or(like(schema.claims.pbmName, `%${payer}%`), like(schema.claims.payerLabel, `%${payer}%`), like(schema.claims.bin, `%${payer}%`))
        : null,
    ].filter((x): x is NonNullable<typeof x> => x !== null),
  );

  const rows = await db.query.claims.findMany({
    where,
    orderBy: (c, { asc }) => [asc(c.dateFilled)],
  });

  /*
   * Losses are counted per dispensing, not per transmission.
   *
   * A prescription billed to a primary plan and then a secondary appears twice in the report, and
   * both rows carry the same acquisition cost, because it is the same bottle. Read as two claims,
   * the cost is counted twice and the primary row alone — a plan paying eight dollars towards a
   * six-hundred-dollar pen — reads as a catastrophic loss. And a reversal matching no claim held
   * reverses a dispensing from before this feed began, whose revenue was never counted here, so
   * subtracting it invents a loss out of a correction to a figure the site never had.
   *
   * Both together put a real day $459 in the red on this pharmacy's first live file.
   */
  const { groupIntoFills, fillsAtALoss, coordinationEffect } = await import("./fills");
  const { laterPayments } = await import("./claim-payments");
  const later = await laterPayments();
  const heldKeys = new Set(rows.filter((c) => c.status === "paid").map((c) => c.transactionKey ?? c.id));
  const fills = groupIntoFills(
    rows.map((c) => ({
      id: c.id,
      rxNumber: c.rxNumber,
      fillNumber: c.fillNumber,
      dateFilled: c.dateFilled,
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
      grossProfitCents: c.grossProfitCents,
      expectedFacilitatorCents: c.expectedFacilitatorCents,
      cashPlan: c.cashPlan,
      onAccount: c.onAccount,
      status: c.status,
      // A reversal kept because it matched nothing: negative money against a fill never counted.
      unmatchedReversal: (c.remitCents ?? 0) < 0 && !c.reversalKey,
    })),
    later,
  );
  void heldKeys;
  const lossFills = fillsAtALoss(fills);
  const coordination = coordinationEffect(fills);

  // Kept for the per-claim view, which is still how somebody looks a single claim up.
  const belowCost = rows.filter((c) => c.grossProfitCents !== null && c.grossProfitCents < 0);

  // Which claims are candidates for the statutory floor is a question about the plan, not about
  // the claim. PioneerRx's plan type cannot answer it: a cash discount programme adjudicates as
  // "Standard" and a low payment on one is correct, not a shortfall. So the register decides,
  // and a plan nobody has classified is held back rather than counted either way.
  const groups = await db.query.planGroups.findMany();
  const lookup = planLookup(groups);
  const classOf = (c: { bin: string | null; pcn?: string | null; groupNumber: string | null }) => lookup(c)?.classification;

  /*
   * The cash programme is not a plan, and no question about plans applies to it.
   *
   * It has no classification to be missing, no floor to fall under and nobody to appeal to — the
   * pharmacy set the price. Counting it among the unclassified would put every cash fill on a list
   * of things somebody has to go and settle, which is a list of work that does not exist.
   */
  const thirdParty = rows.filter((c) => !c.cashPlan);
  const inScope = thirdParty.filter((c) => {
    const cls = classOf(c);
    return cls !== undefined && CLASS_INFO[cls].inScope;
  });
  const undetermined = thirdParty.filter((c) => {
    const cls = classOf(c);
    return cls === undefined || cls === "unknown";
  });

  /*
   * Under the fee, judged on the bottle rather than on the transmission.
   *
   * A fill billed to a primary and then a secondary is two rows, and the secondary's row reads
   * "$0 paid, $0 owing" because the primary paid. Read row by row that is a claim paid nothing,
   * under the fee by the whole $10.50, and this screen invented exactly that shortfall on every
   * coordinated fill it held. What was received for the bottle is the fill's own figure, every
   * payer and the patient together and any money that reached it later, and a fill is counted
   * once however many rows it took.
   */
  const fillOf = new Map(fills.map((f) => [f.key, f]));
  const keyOf = (c: (typeof rows)[number]) => fillKey({ rxNumber: c.rxNumber, fillNumber: c.fillNumber, dateFilled: c.dateFilled, ndc11: c.ndc11 });
  const under = (xs: typeof rows) => {
    const seen = new Set<string>();
    return xs.filter((c) => {
      const k = keyOf(c);
      if (seen.has(k)) return false;
      const f = fillOf.get(k);
      const got = f ? f.revenueCents : receivedCents(c.remitCents, c.copayCents);
      if (got === null || got >= SB20_MIN_DISPENSING_FEE_CENTS) return false;
      seen.add(k);
      return true;
    });
  };
  const underFee = under(inScope);
  const underFeeUndetermined = under(undetermined);

  const sum = (xs: { grossProfitCents: number | null }[]) =>
    xs.reduce((s, x) => s + (x.grossProfitCents ?? 0), 0);

  const shortfall = (xs: typeof rows) =>
    xs.reduce((s, c) => {
      const f = fillOf.get(keyOf(c));
      const got = f ? f.revenueCents : (receivedCents(c.remitCents, c.copayCents) ?? 0);
      return s + Math.max(0, SB20_MIN_DISPENSING_FEE_CENTS - got);
    }, 0);

  return {
    total: rows.length,
    /** Claims on somebody else's plan. Every classification and floor figure is drawn from these. */
    thirdParty: thirdParty.length,
    /** Fills the pharmacy priced itself, and what they made. Business it fully controls. */
    cashFills: fills.filter((f) => f.cashPlan).length,
    cashMarginCents: fills.filter((f) => f.cashPlan).reduce((n, f) => n + (f.marginCents ?? 0), 0),
    belowCost,
    belowCostTotalCents: sum(belowCost),
    /** One row per dispensing, with every payer that priced it. */
    fills,
    /** BIN and network for the rows in scope, so the payer table needs no query of its own. */
    networks: rows.map((c) => ({ bin: c.bin, networkId: c.networkId })),
    /** The day range these figures were drawn from, so the screen can say what it is showing. */
    scope: { from, to, rx: rx || null, payer: payer || null },
    /*
     * The rows behind each fill, exactly as the report sent them.
     *
     * Column positions in this report are worked out by counting, and a report whose columns move
     * by one produces figures that are all individually plausible and collectively wrong — a
     * dispensing fee read as a patient total, a tax read as a quantity. Arguing about it from a
     * screen that shows only the conclusions is guesswork on both sides. This is the evidence: for
     * any fill, what arrived, field by field, with the name this reader gave each one.
     */
    rawByFill: (() => {
      /*
       * Only for the fills whose rows are actually on screen.
       *
       * This parses the stored text of every claim row, and it was doing it for every claim held to
       * render the fifty on the loss list. The other several thousand were parsed, turned into
       * objects, and thrown away on every load.
       */
      const wanted = new Set(lossFills.slice(0, 50).map((f) => f.key));
      const by = new Map<string, { payer: string | null; fields: { name: string; value: string }[] }[]>();
      for (const c of rows) {
        if (!c.rawJson) continue;
        if (!wanted.has([c.rxNumber.trim(), c.fillNumber ?? "", c.dateFilled, c.ndc11 ?? ""].join("|"))) continue;
        const key = [c.rxNumber.trim(), c.fillNumber ?? "", c.dateFilled, c.ndc11 ?? ""].join("|");
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(c.rawJson) as Record<string, unknown>;
        } catch {
          continue;
        }
        by.set(key, [
          ...(by.get(key) ?? []),
          {
            payer: c.pbmName ?? c.payerLabel,
            fields: Object.entries(parsed).map(([name, value]) => ({ name, value: String(value ?? "") })),
          },
        ]);
      }
      return by;
    })(),
    lossFills,
    /*
     * Fills where our arithmetic and the report's own gross profit disagree.
     *
     * Not a rounding quibble: it means a column is not where this reader thinks it is, and every
     * figure derived from that row is wrong in the same direction. It is the one check that can
     * catch a mis-read column from the inside, because the report computed its own answer from the
     * same row.
     */
    disagreeing: fills.filter((f) => f.agreesWithReport === false),
    /*
     * Fills where the report booked revenue this site has not found in the row — biggest first.
     *
     * PioneerRx computes its gross profit from the same row we read, so a gap means it counted
     * money we did not. The cause is not knowable from the fill and is deliberately not asserted:
     * one real gap was $146.18 of facilitator money, another $5.56 that no facilitator would ever
     * pay. What is knowable is the amount and the row it is on, and both are shown.
     */
    /*
     * Fills the plan promised a facilitator payment on that has not arrived — biggest first.
     *
     * These are not losses, they are unpaid. The report says at adjudication what the manufacturer
     * share will be; the money follows weeks later through the Medicare Transaction Facilitator.
     * Until it lands the fill sits in the red for the whole amount, and somebody looking at the
     * loss list has no way to tell a rate worth arguing about from a bill nobody has paid yet.
     */
    awaitingFacilitator: fills
      .filter((f) => (f.facilitatorOutstandingCents ?? 0) > 0)
      .sort((a, b) => (b.facilitatorOutstandingCents ?? 0) - (a.facilitatorOutstandingCents ?? 0)),
    awaitingFacilitatorCents: fills.reduce((n, f) => n + (f.facilitatorOutstandingCents ?? 0), 0),
    /*
     * ── Do the books balance? ─────────────────────────────────────────────────────
     *
     * Three totals that must agree, drawn three different ways:
     *
     *   ours      every dispensing's revenue less the cost of the bottle, taken once
     *   report    PioneerRx's own per-row gross profit, added over the live rows
     *   later     money that arrived after the day, which only ours can know about
     *
     *   ours − later = report
     *
     * This is the standing tripwire. Every arithmetic error this site has had was found by the
     * pharmacist reading a PDF and knowing the real answer — the smallest copay, a residual read
     * from the wrong column, a reversal left unpaired so one bottle counted twice. Each was a rule
     * inferred from a single example, and each survived because nothing independent contradicted
     * it. This does, on every fill, every day, without anybody having to look.
     */
    balance: (() => {
      const ours = fills.reduce((n, f) => n + (f.marginCents ?? 0), 0);
      const later = fills.reduce((n, f) => n + f.laterPaymentsCents, 0);
      const report = fills.reduce((n, f) => n + (f.reportedMarginCents ?? 0), 0);
      const off = fills.filter((f) => f.agreesWithReport === false);
      const unchecked = fills.filter((f) => f.agreesWithReport === null).length;
      return {
        ourMarginCents: ours,
        laterCents: later,
        reportMarginCents: report,
        differenceCents: ours - later - report,
        fillsOff: off.length,
        /** Fills the report gave nothing to check against: no gross profit, or no acquisition cost. */
        unchecked,
        balances: Math.abs(ours - later - report) <= 2 && off.length === 0,
      };
    })(),
    /*
     * Money on account: sold, counted, and not collected.
     *
     * Measured on the fill, never on the row, and the difference is the whole point.
     *
     * On the pharmacy's own first week five rows carried the AR status and not one of them was an
     * uncollected debt: each was the cost leg of a dispensing whose money came in on another
     * transmission, and one was reversed outright. Read row by row they look like $3,189.43 of
     * stock out of the door with nothing billed. Grouped into the fills they belong to, every one
     * was paid and the three that stood made $55.35 between them.
     *
     * So `receivableCents` is what a *fill* has billed and not collected, and `unbilledCostCents`
     * is cost on a fill that brought in nothing at all — the case that is genuinely a hole rather
     * than a coordination leg. Today both are quiet, which is the correct answer and not a reason
     * to stop asking: the row status alone would have raised a four-figure alarm on money that was
     * never missing.
     */
    onAccount: (() => {
      const rowsOn = fills.filter((f) => f.onAccount);
      const unbilled = rowsOn.filter((f) => (f.unbilledCostCents ?? 0) > 0);
      return {
        fills: rowsOn,
        count: rowsOn.length,
        /** Billed to an account and not yet collected. */
        receivableCents: rowsOn.reduce((n, f) => n + f.receivableCents, 0),
        /** Went out with no charge raised at all. */
        unbilled,
        unbilledCostCents: unbilled.reduce((n, f) => n + (f.unbilledCostCents ?? 0), 0),
      };
    })(),
    unreconciled: fills.filter((f) => f.unreconciledCents !== null).sort((a, b) => Math.abs(b.unreconciledCents!) - Math.abs(a.unreconciledCents!)),
    unreconciledCents: fills.reduce((n, f) => n + (f.unreconciledCents ?? 0), 0),
    lossFillsTotalCents: lossFills.reduce((n, f) => n + (f.marginCents ?? 0), 0),
    /** The plans' own remittances against what each fill was adjudicated for: the third balance. */
    remits: remitCheck(fills.filter((f) => !f.cashPlan)),
    /*
     * What these dispensings actually made, which is the only reason any of this is being counted.
     *
     * One row per bottle, cost taken once, the patient counted once, and anything that arrived
     * afterwards added. Fills whose acquisition cost never came through are left out of both sides
     * rather than counted as pure profit, and named, so the figure is of a knowable population.
     */
    pricedFills: fills.filter((f) => f.marginCents !== null).length,
    revenueCents: fills.filter((f) => f.marginCents !== null).reduce((n, f) => n + f.revenueCents, 0),
    marginCents: fills.reduce((n, f) => n + (f.marginCents ?? 0), 0),
    coordination,
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
/**
 * Every dispensing this site holds, grouped from the claim rows.
 *
 * One place, because three screens were each building this the same way and a fourth would have
 * made it four — and the whole point of the grouping is that the claims screen, the payer table
 * and the dashboard cannot be allowed to give different answers to the same question.
 */
export async function allFills() {
  const rows = await db.query.claims.findMany();
  const { groupIntoFills } = await import("./fills");
  const { laterPayments } = await import("./claim-payments");
  return groupIntoFills(
    rows.map((c) => ({
      id: c.id,
      rxNumber: c.rxNumber,
      fillNumber: c.fillNumber,
      dateFilled: c.dateFilled,
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
      grossProfitCents: c.grossProfitCents,
      expectedFacilitatorCents: c.expectedFacilitatorCents,
      cashPlan: c.cashPlan,
      onAccount: c.onAccount,
      status: c.status,
      // A reversal kept because it matched nothing: negative money against a fill never counted.
      unmatchedReversal: (c.remitCents ?? 0) < 0 && !c.reversalKey,
    })),
    await laterPayments(),
  );
}

/**
 * What each payer is actually worth to this pharmacy.
 *
 * Per dispensing, not per transmission — the same correction the rest of this file makes, because
 * otherwise this table answers the same question as the loss list and gives a different number.
 * Summing the report's per-row gross profit counted one bottle's cost against every plan that
 * priced it, which is how a copay card that paid $46.25 into a profitable fill came to be shown as
 * a $62.99 loss, and how CVS Caremark read $95.13 in the red on a day it was not.
 *
 * A fill with one payer is that payer's, whole. A fill that two plans coordinated on belongs to
 * neither of them alone, and there is no honest way to split one bottle between them — so it is
 * held out of the profit column entirely and shown separately, with each plan credited only with
 * the money it actually sent. Two figures that are true beat one that is tidy.
 */
export async function claimsByPayer(given?: { fills: Awaited<ReturnType<typeof allFills>>; networks: { bin: string | null; networkId: string | null }[] }) {
  /*
   * Given the fills the screen already grouped, rather than grouping them all over again.
   *
   * The claims page called this beside claimFlags, and between them they read every claim twice and
   * grouped every dispensing twice — the same work, done again, to answer a question about the same
   * rows. On a screen showing one day it was the difference between one query and thousands of rows.
   */
  const [rows, fills] = given
    ? [given.networks, given.fills]
    : await Promise.all([db.query.claims.findMany({ columns: { bin: true, networkId: true } }), allFills()]);

  type Row = {
    pbmName: string;
    /** Fills this payer priced on its own, which are the ones its profit figure is drawn from. */
    fills: number;
    receivedCents: number;
    profitCents: number;
    belowCost: number;
    /** Fills it shared with another plan: real business, but not separable into one plan's margin. */
    coordinatedFills: number;
    coordinatedRemitCents: number;
    bins: Set<string>;
    networks: Set<string>;
  };
  const map = new Map<string, Row>();
  const named = (p: { name: string | null; bin: string | null }) =>
    p.name ?? (p.bin ? `BIN ${p.bin} (unmatched)` : "Unidentified payer");
  const at = (name: string) => {
    let e = map.get(name);
    if (!e) {
      e = { pbmName: name, fills: 0, receivedCents: 0, profitCents: 0, belowCost: 0, coordinatedFills: 0, coordinatedRemitCents: 0, bins: new Set(), networks: new Set() };
      map.set(name, e);
    }
    return e;
  };

  for (const f of fills) {
    if (f.coordinated) {
      for (const p of f.payers) {
        const e = at(named(p));
        e.coordinatedFills++;
        e.coordinatedRemitCents += p.remitCents;
        if (p.bin) e.bins.add(p.bin);
      }
      continue;
    }
    const p = f.payers[0];
    if (!p) continue;
    const e = at(named(p));
    e.fills++;
    e.receivedCents += f.revenueCents;
    e.profitCents += f.marginCents ?? 0;
    if ((f.marginCents ?? 0) < 0) e.belowCost++;
    if (p.bin) e.bins.add(p.bin);
  }

  /*
   * Networks belong to the claim row rather than the fill, and are joined back on the BIN — which
   * is the one identifier both sides certainly agree on. Joining on the payer's display name would
   * quietly drop every network for a payer the listing does not name.
   */
  const networksByBin = new Map<string, Set<string>>();
  for (const c of rows) {
    if (!c.networkId || !c.bin) continue;
    const set = networksByBin.get(c.bin) ?? new Set<string>();
    set.add(c.networkId);
    networksByBin.set(c.bin, set);
  }
  for (const e of map.values()) {
    for (const bin of e.bins) for (const n of networksByBin.get(bin) ?? []) e.networks.add(n);
  }

  return [...map.values()]
    .map((e) => ({ ...e, claims: e.fills + e.coordinatedFills, bins: [...e.bins].sort(), networks: [...e.networks].sort() }))
    .sort((a, b) => b.claims - a.claims);
}

export async function claimImports() {
  return db.query.claimImports.findMany({ orderBy: (i, { desc }) => [desc(i.createdAt)] });
}

/**
 * When a claims export last arrived.
 *
 * The figure the automation strip judges silence against. A scheduled report that somebody
 * deleted, or that started bouncing, does not announce itself — claims simply stop and every
 * number downstream goes stale while continuing to look perfectly reasonable.
 */
export async function latestClaimImport(): Promise<string | null> {
  const rows = await db.query.claimImports.findMany({
    columns: { createdAt: true },
    orderBy: (i, { desc }) => [desc(i.createdAt)],
    limit: 1,
  });
  return rows[0]?.createdAt ?? null;
}
