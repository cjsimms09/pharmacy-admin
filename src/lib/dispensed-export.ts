/**
 * PioneerRx's dispensed export, read onto the claims the site already holds.
 *
 * The owner sent "daily_0901_to_0907.xlsx" on 8 September — "this is the correct info" — one row
 * per prescription sold, with what the daily transaction report never carried: the AWP, WAC and
 * NADAC for the dispensed quantity, the DAW, the days supply, the dispensing fee, the basis of
 * reimbursement, the plan's own contract id, the DIR fee, the e-voucher, and the secondary payer
 * beside the primary. Compared row for row against the claims table the same day: 916 of 943
 * prescriptions in both agreed on the remit to the cent, and every difference had a reason — the
 * export prints the primary's copay where the transaction report prints what was left after a
 * secondary paid, and a $0 primary here is the paying secondary there.
 *
 * So this is not a second source of claims. A claim exists because a transaction report said so
 * and was proved against it; this export enriches that row with the columns only it prints, keyed
 * by prescription, fill and payer BIN, and says in words what it could not place. The parse is
 * pure and tested on invented rows; the apply writes the columns of migration 0091 and the ones
 * the transaction report leaves empty.
 */
import { excelSerialToIso } from "./xlsx";

export type DispensedRow = {
  rxNumber: string;
  fillNumber: number;
  itemName: string | null;
  ndc11: string | null;
  quantityThousandths: number | null;
  daysSupply: number | null;
  daw: string | null;
  primary: PayerSide;
  secondary: PayerSide | null;
  awpCents: number | null;
  wacCents: number | null;
  nadacDispensedCents: number | null;
  acquisitionCents: number | null;
  dispensingFeeCents: number | null;
  dirFeeCents: number | null;
  evoucherCents: number | null;
  gcn: string | null;
  basisOfReimbursement: string | null;
  basisOfCostDetermination: string | null;
  filledOn: string | null;
  completedOn: string | null;
  netProfitCents: number | null;
};

export type PayerSide = {
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  networkId: string | null;
  planId: string | null;
  planCode: string | null;
  contractId: string | null;
  remitCents: number | null;
  copayCents: number | null;
  otherPayerAmountCents: number | null;
};

export type DispensedParse = { rows: DispensedRow[]; headers: string[]; unmapped: string[]; problems: string[] };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** What each field is called on the export, PioneerRx's own names first. */
export const DISPENSED_COLUMNS = {
  rxNumber: ["rx number"],
  fillNumber: ["refill number", "fill number"],
  itemName: ["dispensed item name"],
  ndc11: ["dispensed item ndc"],
  quantity: ["dispensed quantity"],
  daysSupply: ["days supply"],
  daw: ["daw"],
  awp: ["dispensed awp"],
  wac: ["dispensed wac current", "dispensed wac"],
  nadac: ["dispensed nadac"],
  acquisition: ["acquisition cost"],
  dispensingFee: ["dispensing fee paid"],
  dirFee: ["dir fee"],
  evoucher: ["evoucher amount paid"],
  gcn: ["dispensed item gcn"],
  basisOfReimbursement: ["primary basis of reimbursement"],
  basisOfCostDetermination: ["primary basis of cost determination"],
  filledOn: ["filled on"],
  completedOn: ["completed on"],
  netProfit: ["net profit"],
  pBin: ["primary third party bin"],
  pPcn: ["primary third party pcn"],
  pGroup: ["primary group number"],
  pNetwork: ["primary network reimbursement"],
  pPlanId: ["primary received edi plan id"],
  pPlanCode: ["primary third party plan code"],
  pContract: ["primary contract id"],
  pRemit: ["primary remit amount"],
  pCopay: ["primary copay amount"],
  pOther: ["primary other payer amount recognized"],
  sBin: ["secondary third party bin"],
  sPcn: ["secondary third party pcn"],
  sGroup: ["secondary group number"],
  sNetwork: ["secondary network reimbursement"],
  sPlanId: ["secondary received edi plan id"],
  sContract: ["secondary contract id"],
  sRemit: ["secondary remit amount"],
  sCopay: ["secondary copay amount"],
  sOther: ["secondary other payer amount recognized"],
} as const;

type Field = keyof typeof DISPENSED_COLUMNS;

export function mapDispensedColumns(headers: string[]): { map: Partial<Record<Field, number>>; unmapped: string[] } {
  const map: Partial<Record<Field, number>> = {};
  const used = new Set<number>();
  for (const [field, names] of Object.entries(DISPENSED_COLUMNS) as [Field, readonly string[]][]) {
    for (const n of names) {
      const i = headers.findIndex((h, idx) => !used.has(idx) && norm(h) === norm(n));
      if (i >= 0) {
        map[field] = i;
        used.add(i);
        break;
      }
    }
  }
  return { map, unmapped: headers.filter((h, i) => h.trim() && !used.has(i)) };
}

const cents = (v: string | undefined): number | null => {
  const t = (v ?? "").replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const text = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};
/** A date as the export prints it: an Excel serial, or "9/4/2026 2:28:45 PM". */
export function exportDate(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  if (Number.isFinite(n) && n > 30000) return excelSerialToIso(Math.floor(n));
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
}
/** An NDC as the export prints it: eleven digits, or ten with a leading zero lost by a spreadsheet. */
export function exportNdc(v: string | undefined): string | null {
  const d = (v ?? "").replace(/\D/g, "");
  if (d.length === 11) return d;
  if (d.length === 10) return `0${d}`;
  return null;
}

export function parseDispensedExport(rows: string[][]): DispensedParse {
  const problems: string[] = [];
  const head = rows.findIndex((r) => r.some((c) => norm(c) === "rxnumber"));
  if (head < 0) return { rows: [], headers: [], unmapped: [], problems: ["No header row with \"Rx Number\": this is not PioneerRx's dispensed export."] };
  const headers = rows[head].map((h) => (h ?? "").trim());
  const { map, unmapped } = mapDispensedColumns(headers);
  for (const need of ["rxNumber", "pBin", "pRemit"] as Field[]) if (map[need] === undefined) problems.push(`The export has no "${DISPENSED_COLUMNS[need][0]}" column.`);
  if (problems.length) return { rows: [], headers, unmapped, problems };
  const g = (r: string[], f: Field) => (map[f] === undefined ? undefined : r[map[f]!]);
  const side = (r: string[], p: "p" | "s"): PayerSide | null => {
    const bin = text(g(r, `${p}Bin` as Field));
    if (!bin) return null;
    return {
      bin: bin.replace(/\D/g, "").padStart(6, "0"),
      pcn: text(g(r, `${p}Pcn` as Field)),
      groupNumber: text(g(r, `${p}Group` as Field)),
      networkId: text(g(r, `${p}Network` as Field)),
      planId: text(g(r, `${p}PlanId` as Field)),
      planCode: p === "p" ? text(g(r, "pPlanCode")) : null,
      contractId: text(g(r, `${p}Contract` as Field)),
      remitCents: cents(g(r, `${p}Remit` as Field)),
      copayCents: cents(g(r, `${p}Copay` as Field)),
      otherPayerAmountCents: cents(g(r, `${p}Other` as Field)),
    };
  };
  const out: DispensedRow[] = [];
  for (const r of rows.slice(head + 1)) {
    const rx = text(g(r, "rxNumber"));
    if (!rx || !/^\d+$/.test(rx)) continue;
    const qty = Number((g(r, "quantity") ?? "").trim());
    out.push({
      rxNumber: rx,
      fillNumber: Number((g(r, "fillNumber") ?? "0").trim()) || 0,
      itemName: text(g(r, "itemName")),
      ndc11: exportNdc(g(r, "ndc11")),
      quantityThousandths: Number.isFinite(qty) ? Math.round(qty * 1000) : null,
      daysSupply: /^\d+$/.test((g(r, "daysSupply") ?? "").trim()) ? Number(g(r, "daysSupply")) : null,
      daw: text(g(r, "daw")),
      primary: side(r, "p") ?? { bin: null, pcn: null, groupNumber: null, networkId: null, planId: null, planCode: null, contractId: null, remitCents: cents(g(r, "pRemit")), copayCents: cents(g(r, "pCopay")), otherPayerAmountCents: null },
      secondary: side(r, "s"),
      awpCents: cents(g(r, "awp")),
      wacCents: cents(g(r, "wac")),
      nadacDispensedCents: cents(g(r, "nadac")),
      acquisitionCents: cents(g(r, "acquisition")),
      dispensingFeeCents: cents(g(r, "dispensingFee")),
      dirFeeCents: cents(g(r, "dirFee")),
      evoucherCents: cents(g(r, "evoucher")),
      gcn: text(g(r, "gcn")),
      basisOfReimbursement: text(g(r, "basisOfReimbursement")),
      basisOfCostDetermination: text(g(r, "basisOfCostDetermination")),
      filledOn: exportDate(g(r, "filledOn")),
      completedOn: exportDate(g(r, "completedOn")),
      netProfitCents: cents(g(r, "netProfit")),
    });
  }
  return { rows: out, headers, unmapped, problems };
}

export type EnrichReport = {
  rowsRead: number;
  primaryEnriched: number;
  secondaryEnriched: number;
  notOnFile: number;
  remitDiffers: number;
  /** In words: the first disagreements and what was not on file, for the import's own record. */
  notes: string[];
  unmapped: string[];
  problems: string[];
};

/**
 * Writes the export's columns onto the claims already held, keyed by prescription, fill and BIN.
 *
 * A row's primary side enriches the claim on the primary BIN; its secondary side the claim on the
 * secondary BIN. A remit that differs from the claim's is counted and named, not overwritten: the
 * transaction report is the proved source of the money, and a difference is a fact to show. A row
 * with no claim on file at all is counted as such — on this pharmacy's first file those were fills
 * processed before the site's records begin.
 */
export async function enrichClaimsFromDispensedExport(file: Buffer, fileName: string): Promise<EnrichReport> {
  const { readSheets } = await import("./xlsx");
  const sheets = readSheets(file);
  const parsed = parseDispensedExport(sheets[0]?.rows ?? []);
  const r = await enrichClaimsFrom(parsed.rows, `${fileName} @ ${new Date().toISOString().slice(0, 10)}`);
  return { ...r, unmapped: parsed.unmapped, problems: parsed.problems };
}

/**
 * The enrichment itself, over rows from wherever they came.
 *
 * Split out on 9 September so the PioneerRx SQL feed can use it. The spreadsheet and the database
 * answer the same question and must answer it the same way: which claim a row belongs to, what to
 * do when the remit on the row and the remit on the claim disagree, and which of several claims on
 * one BIN is the one that was paid. Two copies of those decisions would drift, and the drift would
 * show up as money.
 */
export async function enrichClaimsFrom(rows: DispensedRow[], stamp: string): Promise<EnrichReport> {
  const { db, schema } = await import("@/db");
  const { eq, and } = await import("drizzle-orm");
  const parsed = { rows };
  const report: EnrichReport = { rowsRead: rows.length, primaryEnriched: 0, secondaryEnriched: 0, notOnFile: 0, remitDiffers: 0, notes: [], unmapped: [], problems: [] };
  if (rows.length === 0) return report;
  const rxNumbers = [...new Set(parsed.rows.map((r) => r.rxNumber))];
  const { inArray } = await import("drizzle-orm");
  const held = await db.query.claims.findMany({
    where: inArray(schema.claims.rxNumber, rxNumbers),
    columns: { id: true, rxNumber: true, fillNumber: true, bin: true, status: true, remitCents: true, dateFilled: true, acquisitionCents: true },
  });
  const byKey = new Map<string, typeof held>();
  for (const h of held) {
    const k = `${h.rxNumber}|${h.fillNumber ?? 0}|${h.bin ?? ""}`;
    byKey.set(k, [...(byKey.get(k) ?? []), h]);
  }
  // Several paid rows on one BIN (a $0 adjudication beside the paying one): the row whose remit the export prints, else the first paid.
  const pick = (rx: string, fill: number, bin: string | null, remitCents: number | null) => {
    const rows = byKey.get(`${rx}|${fill}|${bin ?? ""}`) ?? [];
    const paid = rows.filter((h) => h.status === "paid");
    return paid.find((h) => remitCents !== null && h.remitCents === remitCents) ?? paid[0] ?? rows[0] ?? null;
  };

  for (const r of parsed.rows) {
    const p = pick(r.rxNumber, r.fillNumber, r.primary.bin, r.primary.remitCents);
    const s = r.secondary ? pick(r.rxNumber, r.fillNumber, r.secondary.bin, r.secondary.remitCents) : null;
    if (!p && !s) {
      report.notOnFile++;
      if (report.notes.length < 12) report.notes.push(`Rx ${r.rxNumber}-${r.fillNumber} (${r.filledOn ?? "no fill date"}, BIN ${r.primary.bin ?? "?"}) is not on file.`);
      continue;
    }
    const shared = {
      awpCents: r.awpCents,
      wacCents: r.wacCents,
      nadacDispensedCents: r.nadacDispensedCents,
      daysSupply: r.daysSupply,
      daw: r.daw,
      dispensingFeePaidCents: r.dispensingFeeCents,
      dirFeeCents: r.dirFeeCents,
      evoucherCents: r.evoucherCents,
      gcn: r.gcn,
      soldOn: r.completedOn,
      enrichedFrom: stamp,
    };
    /*
     * What the bottle cost, where the claim on file has none.
     *
     * The owner, on the one dispensing the books could not check: "how do we solve or fix". The
     * answer turned out to be that nothing was broken and one field was simply never written. The
     * pull reads `AcquisitionCost` off the claim — PioneerRx has it exactly, $1,147.31 on the
     * Adzenys the account could say nothing about — and this enrichment listed every other column
     * and not that one. So nine September fills carried revenue with no cost against them, were
     * held out of the account for it, and appeared on the books check as the thing it could not
     * compare.
     *
     * Only where the claim has none. A cost already on the row came from the daily transaction
     * report, which is the pharmacy's own record of that dispensing; PioneerRx's copy of the same
     * fact is not better evidence, and quietly replacing one with the other is how two systems stop
     * agreeing for reasons nobody can reconstruct.
     */
    const fillCost = r.acquisitionCents !== null && r.acquisitionCents !== 0 ? { acquisitionCents: r.acquisitionCents } : {};
    if (p) {
      if (p.remitCents !== null && r.primary.remitCents !== null && p.remitCents !== r.primary.remitCents) {
        report.remitDiffers++;
        if (report.notes.length < 12) report.notes.push(`Rx ${r.rxNumber}-${r.fillNumber} on BIN ${r.primary.bin}: the export says the primary paid $${(r.primary.remitCents / 100).toFixed(2)}, the claim holds $${(p.remitCents / 100).toFixed(2)}.`);
      }
      await db
        .update(schema.claims)
        .set({
          ...shared,
          // The bottle's cost, and only if this row does not already carry one of its own.
          ...(p.acquisitionCents === null || p.acquisitionCents === 0 ? fillCost : {}),
          basisOfReimbursement: r.basisOfReimbursement ?? undefined,
          basisOfCostDetermination: r.basisOfCostDetermination ?? undefined,
          planId: r.primary.planId ?? undefined,
          contractId: r.primary.contractId ?? undefined,
          networkId: r.primary.networkId ?? undefined,
        })
        .where(and(eq(schema.claims.id, p.id)));
      report.primaryEnriched++;
    }
    if (s && r.secondary) {
      await db.update(schema.claims).set({ ...shared, planId: r.secondary.planId ?? undefined, contractId: r.secondary.contractId ?? undefined, networkId: r.secondary.networkId ?? undefined }).where(eq(schema.claims.id, s.id));
      report.secondaryEnriched++;
    }
  }
  return report;
}
