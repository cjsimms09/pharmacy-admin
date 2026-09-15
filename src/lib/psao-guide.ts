/**
 * The PSAO's networks guide — rates by PBM and network, and the crosswalk from network id to
 * network — read into the contract library as one document per PBM.
 *
 * Health Mart Atlas publishes "Commercial and Medicaid Networks" as a workbook: a change log,
 * rate tabs by line of business (Commercial, Medicaid, Hospice, Rural), a BIN list, transaction
 * fees, billing windows, and a crosswalk tab per PBM from the network reimbursement id a claim
 * carries (NCPDP field 545-2F) to the network the rate is for. The owner uploaded the 2025 one on
 * 8 September: "here we go!!"
 *
 * It closes the gap no contract closed. A contract names networks in words; a claim carries an
 * id; nothing in the folder printed both until this did. So every PBM's rows become a document in
 * the library — counterparty, network names, the ids, one rate line per row with the row's own
 * text as its citation — and the site applies it the way it applies a read contract: the rates
 * into the rate table, the ids into the link the network page deduces from. Nothing is inferred
 * that the sheet does not print; where a crosswalk lists one id under several schedules, the id
 * goes on each schedule's rate line and the backtest is what chooses.
 *
 * The parse is pure and tested on invented rows. The load writes the library.
 */
import { RateTerm as RateTermSchema, type ContractTermsT } from "./contract-terms";
import type { z } from "zod";

type RateTermT = z.infer<typeof RateTermSchema>;

export type GuideRate = {
  tab: string;
  pbm: string;
  pbmRaw: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  network: string;
  daysSupply: string;
  daysMin: number | null;
  daysMax: number | null;
  brand: string;
  generic: string;
  ber: string | null;
  ger: string | null;
  /** The row as printed, joined by " | ": the citation. */
  quote: string;
};

export type GuideCrosswalk = { pbm: string; networkId: string | null; networkName: string; bin: string | null; pcn: string | null; group: string | null; tab: string };

export type GuideParse = {
  title: string | null;
  rates: GuideRate[];
  crosswalk: GuideCrosswalk[];
  bins: { pbm: string; bin: string }[];
  problems: string[];
};

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "");

/** The PBM as the payer pages name it, from the guide's own spelling with its footnotes and parentheticals. */
export function canonicalPbm(raw: string): string {
  const s = squash(raw).replace(/\*+.*$/, "").replace(/\([^)]*\)/g, "").trim();
  const l = s.toLowerCase();
  if (/caremark|cvs/.test(l)) return "CVS Caremark";
  if (/express scripts|esi\b/.test(l)) return "Express Scripts";
  if (/optum/.test(l)) return "OptumRx";
  if (/prime/.test(l)) return "Prime Therapeutics";
  if (/capital rx|judi/.test(l)) return "Capital Rx";
  if (/navitus/.test(l)) return "Navitus";
  if (/medimpact/.test(l)) return "MedImpact";
  if (/^dst\b/.test(l)) return "DST Pharmacy Solutions";
  if (/mc-rx|mcrx/.test(l)) return "MC-Rx";
  if (/sav-rx|savrx/.test(l)) return "Sav-Rx";
  if (/maxor/.test(l)) return "MaxorPlus";
  return s || squash(raw);
}

const MONTHS_ISO = (m: string, d: string, y: string) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;

/** "01/01/2024- 11/29/2025**" → from and to; "01/01/2025 - Present" → to null. */
export function parseEffective(cell: string): { from: string | null; to: string | null } {
  const dates = [...squash(cell).matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g)].map((m) => MONTHS_ISO(m[1], m[2], m[3]));
  return { from: dates[0] ?? null, to: dates[1] ?? null };
}

/** "1 - 83 days" → 1..83; "84 or greater" → 84..; "All days supply" → open. */
export function parseDays(cell: string): { min: number | null; max: number | null } {
  const s = squash(cell).toLowerCase();
  if (!s || /^all/.test(s)) return { min: null, max: null };
  const range = /(\d+)\s*-\s*(\d+)/.exec(s);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const open = /(\d+)\s*(?:or greater|\+|or more|and up)/.exec(s);
  if (open) return { min: Number(open[1]), max: null };
  const single = /^(\d+)\s*days?$/.exec(s);
  if (single) return { min: Number(single[1]), max: Number(single[1]) };
  return { min: null, max: null };
}

/** "MAC or AWP- 30.00% + $0.75" → the formula without its fee, and the fee. "NADAC + $10.50" → "NADAC", 10.50. */
export function splitFormula(cell: string): { formula: string | null; fee: number | null } {
  const s = squash(cell).replace(/^(BER|GER)\s*:\s*/i, "").replace(/\s*-\s*/g, " - ").replace(/\s+/g, " ").trim();
  if (!s) return { formula: null, fee: null };
  const feeMatches = [...s.matchAll(/\+\s*\$\s*([\d.]+)\*?/g)];
  const last = feeMatches[feeMatches.length - 1];
  const fee = last ? Number(last[1]) : null;
  let formula = last ? s.slice(0, last.index).trim() : s;
  formula = formula.replace(/\s*\+\s*$/, "").replace(/\*+/g, "").trim();
  return { formula: formula || null, fee: fee !== null && Number.isFinite(fee) ? fee : null };
}

const RATE_TABS = ["Commercial", "Medicaid", "Hospice", "Rural"];

export function parsePsaoGuide(sheets: { name: string; rows: string[][] }[]): GuideParse {
  const problems: string[] = [];
  const rates: GuideRate[] = [];
  const crosswalk: GuideCrosswalk[] = [];
  const bins: { pbm: string; bin: string }[] = [];
  let title: string | null = null;

  for (const sh of sheets) {
    const name = squash(sh.name);
    const rows = sh.rows.map((r) => r.map((c) => squash(c)));
    const first = rows.find((r) => r.some(Boolean))?.find(Boolean) ?? null;
    // The guide is named for what it holds, with the year the change log prints; the change log is not the guide.
    if (/Guide Updates/i.test(name) && first) {
      const year = /\b(20\d\d)\b/.exec(first)?.[1];
      title = `${year ? `${year} ` : ""}Commercial and Medicaid Networks Guide (Health Mart Atlas)`;
    }

    if (RATE_TABS.some((t) => name.toLowerCase().startsWith(t.toLowerCase()))) {
      const tab = RATE_TABS.find((t) => name.toLowerCase().startsWith(t.toLowerCase()))!;
      const head = rows.findIndex((r) => /^PBM$/i.test(r[0] ?? "") && r.some((c) => /Network/i.test(c)));
      if (head < 0) {
        problems.push(`${name}: no header row with PBM and Network.`);
        continue;
      }
      const h = rows[head].map((c) => c.toLowerCase());
      const col = (re: RegExp) => h.findIndex((c) => re.test(c));
      const cPbm = 0;
      const cEff = col(/effective/);
      const cNet = col(/^network/);
      const cDays = col(/days/);
      const cBrand = col(/brand/);
      const cGen = col(/generic/);
      const cBer = col(/ber/);
      const cGer = col(/ger/);
      for (const r of rows.slice(head + 1)) {
        const pbmRaw = r[cPbm] ?? "";
        // "ES1000 - Limited 1 (EN-45) **The continuity of care period…" — the footnote stays in the quote, not the name.
        const network = (cNet >= 0 ? r[cNet] ?? "" : "").replace(/\*\*.*$/, "").trim();
        if (!pbmRaw || !network) continue;
        const brand = cBrand >= 0 ? r[cBrand] ?? "" : "";
        const generic = cGen >= 0 ? r[cGen] ?? "" : "";
        if (!brand && !generic) continue;
        const eff = parseEffective(cEff >= 0 ? r[cEff] ?? "" : "");
        const daysCell = cDays >= 0 ? r[cDays] ?? "" : "";
        // The Rural tab folds the days band into the network name ("Commercial Rural Extended Day").
        const days = daysCell ? parseDays(daysCell) : /extended day/i.test(network) ? { min: 84, max: null } : { min: null, max: null };
        rates.push({
          tab,
          pbm: canonicalPbm(pbmRaw),
          pbmRaw,
          effectiveFrom: eff.from,
          effectiveTo: eff.to,
          network,
          daysSupply: daysCell,
          daysMin: days.min,
          daysMax: days.max,
          brand,
          generic,
          ber: cBer >= 0 && cBer !== cBrand ? r[cBer] || null : null,
          ger: cGer >= 0 && cGer !== cGen ? r[cGer] || null : null,
          quote: [pbmRaw, cEff >= 0 ? r[cEff] : "", network, daysCell, brand, generic].filter(Boolean).join(" | "),
        });
      }
      continue;
    }

    if (/^BINs?$/i.test(name)) {
      for (const r of rows) {
        const b = (r[1] ?? "").replace(/\D/g, "");
        if (!r[0] || !b || /^PBM$/i.test(r[0])) continue;
        bins.push({ pbm: canonicalPbm(r[0]), bin: b.length === 5 ? `0${b}` : b });
      }
      continue;
    }

    if (/crosswalk|CapitalRx|MC-Rx/i.test(name)) {
      // The header cell is "Network ID*" on its own; the sentence above it also says "Network ID" and is not the header.
      const head = rows.findIndex((r) => r.some((c) => /^network id\*?$/i.test(c)) || (r.some((c) => /^network name$/i.test(c)) && r.some((c) => /^group/i.test(c))));
      if (head < 0) {
        problems.push(`${name}: no crosswalk header row.`);
        continue;
      }
      const h = rows[head].map((c) => c.toLowerCase());
      const col = (re: RegExp) => h.findIndex((c) => re.test(c));
      const cPbm = col(/^pbm/);
      const cId = col(/network id/);
      const cName = col(/network name|network tier/);
      const cBin = col(/^bin/);
      const cPcn = col(/^pcn/);
      const cGroup = col(/^group/);
      const tabPbm = /optum/i.test(name) ? "OptumRx" : /prime/i.test(name) ? "Prime Therapeutics" : /esi|express/i.test(name) ? "Express Scripts" : /maxor/i.test(name) ? "MaxorPlus" : null;
      for (const r of rows.slice(head + 1)) {
        const id = cId >= 0 ? r[cId] ?? "" : "";
        const nm = cName >= 0 ? r[cName] ?? "" : "";
        const pbmCell = cPbm >= 0 ? r[cPbm] ?? "" : "";
        if (!nm && !id) continue;
        if (/network id/i.test(id)) continue;
        const pbm = pbmCell ? canonicalPbm(pbmCell) : tabPbm;
        if (!pbm) continue;
        const clean = (x: string | undefined) => {
          const v = squash(x);
          return v && v !== "-" ? v : null;
        };
        const bin = clean(cBin >= 0 ? r[cBin] : undefined);
        crosswalk.push({
          pbm,
          networkId: clean(id)?.toUpperCase() ?? null,
          networkName: nm,
          bin: bin ? (bin.length === 5 ? `0${bin}` : bin) : null,
          pcn: clean(cPcn >= 0 ? r[cPcn] : undefined),
          group: clean(cGroup >= 0 ? r[cGroup] : undefined),
          tab: name,
        });
      }
    }
  }
  if (rates.length === 0) problems.push("No rate rows were found; this is not the PSAO's networks guide.");
  return { title, rates, crosswalk, bins, problems };
}

/**
 * Which rate lines a crosswalk name belongs to.
 *
 * The crosswalk and the rate tab describe the same network in different words: "Schedule B - EN 45
 * - ES1000" against "ES1000 - Limited 1 (EN-45)"; "B2D" against "National Select (B-2D)";
 * "Exclusive (Rural)" against "Exclusive". The codes are the reliable join where the row prints
 * one; the name's leading words are the join where it does not. Anything that fits is returned,
 * and a name that fits nothing is left for the page to show as an id without a rate.
 */
export function rateNetworksFor(crosswalkName: string, rateNetworks: string[]): string[] {
  const cn = norm(crosswalkName.replace(/\([^)]*\)/g, ""));
  const out = new Set<string>();
  const codeIn = (s: string) => {
    const m = /\(([A-Z]{1,3}-?\s?\d{1,3}[A-Z]?)\)/i.exec(s) ?? /\b(EN\s?-?\s?\d\d|EDS\s?\d|B-?\d{1,2}[A-Z]?|B-?[A-Z]{1,2})\b/i.exec(s);
    return m ? norm(m[1]) : null;
  };
  const cCode = codeIn(crosswalkName);
  for (const rn of rateNetworks) {
    const rCode = codeIn(rn);
    if (cCode && rCode && cCode === rCode) {
      out.add(rn);
      continue;
    }
    const rnorm = norm(rn.replace(/\([^)]*\)/g, ""));
    if (!rnorm || !cn) continue;
    // Express Scripts' schedules are named for what they are: EDS1 is Extended Day 1, Schedule S is Specialty.
    const eds = /EDS(\d)/.exec(cn);
    if (eds && new RegExp(`EXTENDEDDAY${eds[1]}`).test(rnorm)) out.add(rn);
    if (/SCHEDULES|SPECIALTY/.test(cn) && /SPECIALTY/.test(rnorm)) out.add(rn);
    if (/SCHEDULEF|DISCOUNTCARD/.test(cn) && /DISCOUNTCARD/.test(rnorm)) out.add(rn);
    if (/SCHEDULEH|SMART90/.test(cn) && /SMART90/.test(rnorm)) out.add(rn);
    if (/CLEAR/.test(cn) && /CLEAR/.test(rnorm)) out.add(rn);
    // The leading words agree: "National Choice" / "National Choice"; "Exclusive Rural" / "Exclusive".
    if (rnorm.length >= 5 && (cn.startsWith(rnorm) || rnorm.startsWith(cn))) out.add(rn);
  }
  return [...out];
}

export type PbmDocument = { pbm: string; documentName: string; terms: ContractTermsT; text: string };

/** One document per PBM, in the shape a read contract takes, so the site applies it the same way. */
export function documentsFor(parse: GuideParse, guideName: string): PbmDocument[] {
  const pbms = new Set<string>([...parse.rates.map((r) => r.pbm), ...parse.crosswalk.map((c) => c.pbm)]);
  const out: PbmDocument[] = [];
  for (const pbm of [...pbms].sort()) {
    const rates = parse.rates.filter((r) => r.pbm === pbm);
    const xw = parse.crosswalk.filter((c) => c.pbm === pbm);
    const rateNetworks = [...new Set(rates.map((r) => r.network))];
    // Which ids, BINs, PCNs and groups route to each rate network, from the crosswalk.
    const idsByNetwork = new Map<string, Set<string>>();
    const binsByNetwork = new Map<string, Set<string>>();
    const pcnsByNetwork = new Map<string, Set<string>>();
    const groupsByNetwork = new Map<string, Set<string>>();
    const add = (m: Map<string, Set<string>>, k: string, v: string | null) => {
      if (!v) return;
      m.set(k, (m.get(k) ?? new Set()).add(v));
    };
    for (const c of xw) {
      for (const rn of rateNetworksFor(c.networkName, rateNetworks)) {
        add(idsByNetwork, rn, c.networkId);
        add(binsByNetwork, rn, c.bin);
        add(pcnsByNetwork, rn, c.pcn);
        add(groupsByNetwork, rn, c.group);
      }
    }
    const rateTerms: RateTermT[] = rates.map((r) => {
      const brand = splitFormula(r.brand);
      const generic = splitFormula(r.generic);
      return {
        network: r.network,
        bins: [...(binsByNetwork.get(r.network) ?? [])],
        pcns: [...(pcnsByNetwork.get(r.network) ?? [])],
        groupIds: [...(groupsByNetwork.get(r.network) ?? [])],
        networkIds: [...(idsByNetwork.get(r.network) ?? [])],
        lineOfBusiness: r.tab,
        costSharingTier: "unknown" as const,
        daysSupplyMin: r.daysMin ?? undefined,
        daysSupplyMax: r.daysMax ?? undefined,
        brandFormula: brand.formula ?? undefined,
        brandDispensingFee: brand.fee ?? undefined,
        genericBasis: generic.formula ?? undefined,
        genericDispensingFee: generic.fee ?? undefined,
        effectiveFrom: r.effectiveFrom ?? undefined,
        effectiveTo: r.effectiveTo ?? undefined,
        citation: { quote: r.quote, section: r.tab },
      };
    });
    const guarantees = rates
      .filter((r) => r.ber || r.ger)
      .map((r) => ({ network: r.network, costSharingTier: "unknown" as const, daysSupplyMin: r.daysMin ?? undefined, daysSupplyMax: r.daysMax ?? undefined, brandEffectiveRate: r.ber ?? undefined, genericEffectiveRate: r.ger ?? undefined, citation: { quote: r.quote, section: r.tab } }));
    const ids = [...new Set(xw.map((c) => c.networkId).filter((x): x is string => x !== null))];
    const names = [...new Set([...rateNetworks, ...xw.map((c) => c.networkName)])];
    const effectiveFrom = rates.map((r) => r.effectiveFrom).filter(Boolean).sort()[0];
    const text = [
      `${guideName} — ${pbm}`,
      ...rates.map((r) => r.quote),
      ...xw.map((c) => [c.pbm, c.networkId, c.networkName, c.bin, c.pcn, c.group].filter(Boolean).join(" | ")),
    ].join("\n");
    const terms = {
      counterparty: pbm,
      documentTitle: `${guideName} — ${pbm}`,
      contractType: "psao" as const,
      documentRole: "rate_sheet" as const,
      supersedes: [],
      bins: [...new Set(parse.bins.filter((b) => b.pbm === pbm).map((b) => b.bin))],
      pcns: [],
      groupIds: [],
      chainCodes: [],
      networkNames: names,
      networkReimbursementIds: ids,
      pharmacyNcpdps: [],
      pharmacyNpis: [],
      linesOfBusiness: [...new Set(rates.map((r) => r.tab))],
      effectiveDate: effectiveFrom ?? undefined,
      terminationRights: { value: undefined },
      allProductsClause: { value: undefined },
      noticesOwedByPharmacy: [],
      rates: rateTerms,
      effectiveRateGuarantees: guarantees,
      postPointOfSaleDiscounts: [],
      disputeWindows: [],
      reportsOwed: [],
      transactionFees: [],
      pricingCompendium: { value: undefined },
      macListAccess: { value: undefined },
      performanceMeasures: [],
      dawRules: { value: undefined },
      recoupmentTerms: { value: undefined },
      keyDefinitions: [],
      incorporatesByReference: [],
      dirFeeBasis: { value: undefined },
      macAppealWindowDays: { value: undefined },
      macAppealMethod: { value: undefined },
      macAppealRequiredFields: [],
      contacts: [],
      gcrTiers: [],
      gcrDefinition: { value: undefined },
      sections: [],
      unclearOrMissing: rateTerms.length === 0 ? ["The guide prints a crosswalk for this PBM but no rate row."] : [],
      confidence: 1,
    } as unknown as ContractTermsT;
    out.push({ pbm, documentName: `${guideName} — ${pbm}`, terms, text });
  }
  return out;
}

export type GuideLoad =
  | { ok: true; title: string | null; documents: number; rates: number; ids: number; problems: string[] }
  | { ok: false; why: string };

/** Reads the workbook and writes one library document per PBM, replacing the same guide's earlier load. */
export async function loadPsaoGuide(file: Buffer, fileName: string, by: { name: string }): Promise<GuideLoad> {
  const { readSheets } = await import("./xlsx");
  const { db, schema } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { newId } = await import("./crypto");
  const { createHash } = await import("node:crypto");
  const { ContractTerms } = await import("./contract-terms");
  const parse = parsePsaoGuide(readSheets(file));
  if (parse.rates.length === 0) return { ok: false, why: parse.problems[0] ?? "No rate rows." };
  const guideName = parse.title ?? fileName.replace(/\.xlsx$/i, "");
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  let rates = 0;
  let ids = 0;
  const docs = documentsFor(parse, guideName);
  for (const d of docs) {
    const checked = ContractTerms.safeParse(d.terms);
    if (!checked.success) return { ok: false, why: `${d.pbm}: the document does not fit the terms shape: ${checked.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
    const syntheticFile = `${slug(guideName)}#${slug(d.pbm)}`;
    const json = JSON.stringify(checked.data);
    const sha = createHash("sha256").update(d.text).digest("hex");
    const existing = await db.query.contractDocs.findFirst({ where: eq(schema.contractDocs.fileName, syntheticFile) });
    const values = {
      pbmName: d.pbm,
      documentName: d.documentName,
      documentType: "psao-guide",
      fileName: syntheticFile,
      sizeBytes: file.length,
      sha256: sha,
      matchedBy: "manual" as const,
      extractionState: "done" as const,
      extractionJson: json,
      extractionError: null,
      pages: null,
      triage: "read",
      triageWhy: `Read from the PSAO's guide by the site's own reader, not by the model: every figure is a cell of ${fileName}, loaded by ${by.name}.`,
    };
    if (existing) await db.update(schema.contractDocs).set(values).where(eq(schema.contractDocs.id, existing.id));
    else await db.insert(schema.contractDocs).values({ id: newId(), ...values });
    const docId = existing?.id ?? (await db.query.contractDocs.findFirst({ where: eq(schema.contractDocs.fileName, syntheticFile) }))!.id;
    const textRow = await db.query.contractText.findFirst({ where: eq(schema.contractText.fileName, syntheticFile) });
    const textValues = { fileName: syntheticFile, contractDocId: docId, sha256: sha, chars: d.text.length, body: d.text, source: "spreadsheet" };
    if (textRow) await db.update(schema.contractText).set(textValues).where(eq(schema.contractText.id, textRow.id));
    else await db.insert(schema.contractText).values({ id: newId(), ...textValues });
    rates += d.terms.rates.length;
    ids += d.terms.networkReimbursementIds.length;
  }
  return { ok: true, title: parse.title, documents: docs.length, rates, ids, problems: parse.problems };
}
