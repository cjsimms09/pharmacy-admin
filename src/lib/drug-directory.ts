import { fdaPackageUnits } from "./data-health-packages";
import { normalizeNdc } from "./ndc";

/**
 * Which NDCs are the same drug, from the two files that actually say so.
 *
 * The site used to group products by the words in a wholesaler's description, which is why
 * Ascend's amlodipine and Aurobindo's were never the same thing: the description carries the
 * labeler and the pack count, so almost every group held one NDC. The proper answer is public
 * and free. The FDA's NDC Directory lists, for every marketed package, the active ingredient,
 * strength, dosage form, route, labeler and the application it was approved under. The Orange
 * Book lists, for every approved product, its therapeutic equivalence code — the AB rating that
 * is the legal and commercial definition of "substitutable", not a resemblance between strings.
 *
 * So every NDC gets an equivalence key (ingredients, strength, form, route) from the directory,
 * and a TE code from the Orange Book through its application number. Two NDCs are substitutable
 * here when they share the key and both carry an A-rating. An NDC the directory does not cover
 * stays in a group of its own and says so; nothing is guessed from a name. Pure: the files come
 * in as text, the rows go out as data.
 *
 * ── The files ──
 *
 * NDC Directory (ndctext.zip): `product.txt` and `package.txt`, tab-separated, one header row,
 * Windows-1252. The product NDC is the labeler-product part ("0093-0073"); the package NDC
 * ("0093-0073-01") is the one on a bottle and the one every other file in this site keys on.
 *
 * Orange Book (EOBZIP): `products.txt`, tilde-separated, one header row. Keyed on application
 * type + number + product number; the directory carries the application number ("ANDA076342")
 * but not the product number, so the join is on the application and the strength.
 */

export type DirectoryProduct = {
  productNdc: string;
  productType: string;
  brandName: string | null;
  genericName: string;
  form: string;
  route: string;
  /** "OMEPRAZOLE" or "DROSPIRENONE; ETHINYL ESTRADIOL", as the file lists them. */
  substances: string;
  /** "20; .02" with units "mg/1; mg/1", kept as the file gives them. */
  strength: string;
  strengthUnit: string;
  labeler: string;
  /** "ANDA076342", "NDA020973", "BLA…", or an unapproved-drug category. Null where none. */
  application: string | null;
  marketingCategory: string;
  deaSchedule: string | null;
  marketedFrom: string | null;
  marketedTo: string | null;
  excluded: boolean;
};

export type DirectoryPackage = {
  ndc11: string;
  productNdc: string;
  packageDescription: string;
  marketedFrom: string | null;
  marketedTo: string | null;
  sample: boolean;
};

export type OrangeBookProduct = {
  applType: "A" | "N";
  applNo: string;
  productNo: string;
  ingredient: string;
  formRoute: string;
  tradeName: string;
  applicant: string;
  strength: string;
  teCode: string | null;
  rld: boolean;
  approvedOn: string | null;
};

/** One row per package NDC, as the site stores it. */
export type DrugDirectoryRow = {
  ndc11: string;
  productNdc: string;
  brandName: string | null;
  genericName: string;
  substances: string;
  strength: string;
  form: string;
  route: string;
  labeler: string;
  application: string | null;
  marketingCategory: string;
  deaSchedule: string | null;
  packageDescription: string;
  /** Ingredients, strength, form and route, normalised: what two substitutable NDCs must share. */
  equivalenceKey: string;
  /** The Orange Book's therapeutic equivalence code, or null with `teWhy` saying why. */
  teCode: string | null;
  teWhy: string | null;
  marketedTo: string | null;
  excluded: boolean;
};

const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const iso = (yyyymmdd: string | undefined): string | null => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec((yyyymmdd ?? "").trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const obDate = (s: string | undefined): string | null => {
  // "Jan 15, 2003" or "Approved Prior to Jan 1, 1982".
  const m = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec((s ?? "").trim());
  if (!m) return null;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(m[1]) + 1;
  return month ? `${m[3]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

function table(text: string, sep: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const head = lines[0].split(sep).map((h) => h.trim().toUpperCase());
  return lines.slice(1).map((l) => {
    const cells = l.split(sep);
    const row: Record<string, string> = {};
    head.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
    return row;
  });
}

export function parseDirectoryProducts(text: string): DirectoryProduct[] {
  return table(text, "\t")
    .filter((r) => r.PRODUCTNDC)
    .map((r) => ({
      productNdc: r.PRODUCTNDC,
      productType: r.PRODUCTTYPENAME ?? "",
      brandName: r.PROPRIETARYNAME ? `${r.PROPRIETARYNAME}${r.PROPRIETARYNAMESUFFIX ? ` ${r.PROPRIETARYNAMESUFFIX}` : ""}` : null,
      genericName: r.NONPROPRIETARYNAME ?? "",
      form: r.DOSAGEFORMNAME ?? "",
      route: r.ROUTENAME ?? "",
      substances: r.SUBSTANCENAME ?? "",
      strength: r.ACTIVE_NUMERATOR_STRENGTH ?? "",
      strengthUnit: r.ACTIVE_INGRED_UNIT ?? "",
      labeler: r.LABELERNAME ?? "",
      application: r.APPLICATIONNUMBER || null,
      marketingCategory: r.MARKETINGCATEGORYNAME ?? "",
      deaSchedule: r.DEASCHEDULE || null,
      marketedFrom: iso(r.STARTMARKETINGDATE),
      marketedTo: iso(r.ENDMARKETINGDATE),
      excluded: (r.NDC_EXCLUDE_FLAG ?? "N").toUpperCase() !== "N",
    }));
}

export function parseDirectoryPackages(text: string): DirectoryPackage[] {
  const out: DirectoryPackage[] = [];
  for (const r of table(text, "\t")) {
    const n = normalizeNdc(r.NDCPACKAGECODE);
    if (!n.ok) continue;
    out.push({
      ndc11: n.ndc11,
      productNdc: r.PRODUCTNDC,
      packageDescription: r.PACKAGEDESCRIPTION ?? "",
      marketedFrom: iso(r.STARTMARKETINGDATE),
      marketedTo: iso(r.ENDMARKETINGDATE),
      sample: (r.SAMPLE_PACKAGE ?? "N").toUpperCase() === "Y",
    });
  }
  return out;
}

export function parseOrangeBook(text: string): OrangeBookProduct[] {
  return table(text, "~")
    .filter((r) => r.APPL_NO)
    .map((r) => ({
      applType: (r.APPL_TYPE ?? "").trim().toUpperCase() === "N" ? "N" : "A",
      applNo: r.APPL_NO.padStart(6, "0"),
      productNo: (r.PRODUCT_NO ?? "").padStart(3, "0"),
      ingredient: r.INGREDIENT ?? "",
      formRoute: r["DF;ROUTE"] ?? "",
      tradeName: r.TRADE_NAME ?? "",
      applicant: r.APPLICANT ?? "",
      strength: r.STRENGTH ?? "",
      teCode: r.TE_CODE || null,
      rld: (r.RLD ?? "").toUpperCase() === "YES",
      approvedOn: obDate(r.APPROVAL_DATE),
    }));
}

/** "ANDA076342" → { type: "A", no: "076342" }; "NDA020973" → N; anything else null. */
export function applicationParts(application: string | null): { type: "A" | "N"; no: string } | null {
  const m = /^(ANDA|NDA|BLA)\s*0*(\d+)$/i.exec((application ?? "").trim());
  if (!m) return null;
  return { type: m[1].toUpperCase() === "ANDA" ? "A" : "N", no: m[2].padStart(6, "0") };
}

/**
 * Brand or generic, from the FDA's own marketing category, for an NDC NADAC does not classify.
 *
 * A product group carries NADAC's brand/generic flag so a brand and its generic are never one
 * buying decision. NADAC prices 57% of the catalogue; for the rest the flag was "?", and on the
 * live database 383 FDA-keyed groups with no NADAC row held both a brand and a generic under one
 * key — exactly the merge the flag exists to prevent. The FDA states it for every NDC it lists:
 * an ANDA is a generic, an NDA or BLA a brand, an "NDA AUTHORIZED GENERIC" is sold as a generic
 * and bought as one. An OTC monograph product is neither in the sense a rate schedule means and is
 * flagged OTC instead. Unapproved and homeopathic products stay unclassified rather than guessed.
 */
export function fdaClassification(marketingCategory: string | null | undefined): { classification: "B" | "G" | null; otc: boolean } {
  const c = (marketingCategory ?? "").trim().toUpperCase();
  if (!c) return { classification: null, otc: false };
  if (c.startsWith("OTC")) return { classification: null, otc: true };
  if (c === "ANDA" || c.includes("AUTHORIZED GENERIC")) return { classification: "G", otc: false };
  if (c === "NDA" || c === "BLA" || c.startsWith("NDA ") || c.startsWith("BLA ")) return { classification: "B", otc: false };
  return { classification: null, otc: false };
}

/** The numbers in a strength, so "20 mg/1" and "20MG" and "EQ 20MG BASE" compare as 20. */
export function strengthNumbers(s: string): number[] {
  return (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/**
 * Ingredients, strength, form and route as one normalised string. Salt forms are not collapsed
 * (amlodipine besylate is not amlodipine maleate here), release profiles live in the form, and
 * the route stays: the Orange Book's AB rating is the thing that says two of these are
 * interchangeable, and it is only ever given within one of these keys.
 */
export function equivalenceKey(p: Pick<DirectoryProduct, "substances" | "strength" | "strengthUnit" | "form" | "route">): string {
  const subs = p.substances.split(";").map(fold).filter(Boolean).sort().join("; ");
  const strengths = p.strength.split(";").map((x) => x.trim());
  const units = p.strengthUnit.split(";").map((x) => fold(x));
  const strength = strengths.map((s, i) => `${Number(s) || s}${units[i] ? ` ${units[i]}` : ""}`).join("; ");
  return `${subs}|${strength}|${fold(p.form)}|${fold(p.route)}`;
}

/**
 * Joins the three parsed files into one row per package NDC.
 *
 * The TE code comes from the Orange Book product under the same application whose strength
 * matches; where the application has one product, or every product under it carries the same
 * code, that code is used and `teWhy` says how. An unapproved drug (no application) gets no code
 * and says so — it can still share a key, but nothing rates it substitutable.
 */
export function buildDirectory(products: DirectoryProduct[], packages: DirectoryPackage[], orangeBook: OrangeBookProduct[]): DrugDirectoryRow[] {
  const byProduct = new Map(products.map((p) => [p.productNdc, p]));
  const obByApp = new Map<string, OrangeBookProduct[]>();
  for (const o of orangeBook) {
    const k = `${o.applType}${o.applNo}`;
    obByApp.set(k, [...(obByApp.get(k) ?? []), o]);
  }
  /*
   * One row per package NDC, because the FDA's file does not guarantee it.
   *
   * The real package.txt lists 72043-2500-1 — EltaMD UV Clear SPF46 — twice, identically. An NDC
   * is this table's key, so the load failed on the constraint and every one of the 250,000 rows
   * was refused for the sake of a handful of repeats. The first occurrence is kept: they are the
   * same package, and a package that is stated twice is not a package about which anything is in
   * doubt.
   */
  const out: DrugDirectoryRow[] = [];
  const seen = new Set<string>();
  for (const pk of packages) {
    const p = byProduct.get(pk.productNdc);
    if (!p) continue;
    if (seen.has(pk.ndc11)) continue;
    seen.add(pk.ndc11);
    let teCode: string | null = null;
    let teWhy: string | null = null;
    const app = applicationParts(p.application);
    if (!app) {
      teWhy = p.application ? `No Orange Book listing for ${p.application}.` : "Not an approved application, so the Orange Book does not rate it.";
    } else {
      const candidates = obByApp.get(`${app.type}${app.no}`) ?? [];
      if (candidates.length === 0) teWhy = `${p.application} is not in the Orange Book.`;
      else {
        const want = strengthNumbers(p.strength).join("/");
        const same = candidates.filter((c) => strengthNumbers(c.strength).join("/") === want);
        const pick = same.length === 1 ? same[0] : same.length > 1 && new Set(same.map((c) => c.teCode)).size === 1 ? same[0] : null;
        if (pick) {
          teCode = pick.teCode;
          teWhy = pick.teCode ? null : "Listed in the Orange Book without a code.";
        } else if (candidates.length === 1 || new Set(candidates.map((c) => c.teCode)).size === 1) {
          teCode = candidates[0].teCode;
          teWhy = teCode ? "Rated by the application as a whole; no product matched the strength." : "Listed in the Orange Book without a code.";
        } else {
          teWhy = `${candidates.length} products under ${p.application} carry different codes and none matched the strength.`;
        }
      }
    }
    out.push({
      ndc11: pk.ndc11,
      productNdc: p.productNdc,
      brandName: p.brandName,
      genericName: p.genericName,
      substances: p.substances,
      strength: [p.strength, p.strengthUnit].filter(Boolean).join(" "),
      form: p.form,
      route: p.route,
      labeler: p.labeler,
      application: p.application,
      marketingCategory: p.marketingCategory,
      deaSchedule: p.deaSchedule,
      packageDescription: pk.packageDescription,
      equivalenceKey: equivalenceKey(p),
      teCode,
      teWhy,
      marketedTo: pk.marketedTo ?? p.marketedTo,
      excluded: p.excluded,
    });
  }
  return out;
}

/** An A-rating (AB, AA, AN, AO, AP, AT) means therapeutically equivalent; a B-rating or none does not. */
export const isARated = (teCode: string | null): boolean => /^A/i.test(teCode ?? "");

/**
 * The numeric suffix on an A-rating is a subgroup, and it is not decoration.
 *
 * Where the FDA cannot say that every product under one code is interchangeable with every other —
 * different delivery systems, different bioequivalence findings — it splits them into AB1, AB2,
 * AB3. Products are equivalent *within* a subgroup and explicitly not across one. Treating every
 * AB* as one pool would substitute across that line, which is the single mistake this whole module
 * exists to prevent, and would do it while displaying an FDA rating as its justification.
 *
 * A bare "AB" is its own group too: it is not a wildcard that matches AB1.
 */
export const teGroup = (teCode: string | null): string | null => {
  const t = (teCode ?? "").trim().toUpperCase();
  return t === "" ? null : t;
};

/**
 * Whether one NDC may be dispensed in place of another: the same key, and both rated
 * therapeutically equivalent. Two unrated products with the same key are the same drug on paper
 * and still not called substitutable here, because nothing has said they are.
 */
export function substitutable(a: Pick<DrugDirectoryRow, "equivalenceKey" | "teCode">, b: Pick<DrugDirectoryRow, "equivalenceKey" | "teCode">): boolean {
  if (a.equivalenceKey !== b.equivalenceKey) return false;
  if (!isARated(a.teCode) || !isARated(b.teCode)) return false;
  // The same rating, suffix and all: AB1 is not AB2, and neither is a bare AB.
  const ga = teGroup(a.teCode);
  return ga !== null && ga === teGroup(b.teCode);
}

/* ── What a package actually holds, from the FDA rather than from a wholesaler ── */

/**
 * Reads the FDA's own statement of what is in a package.
 *
 * This is the answer to the argument the site has been having with itself. Twenty-four wholesalers
 * describe one box at whatever height their file happens to use — "1 EA", "168 EA", "(6) 28 EA" —
 * and the site had no neutral party to settle it, so it could only report that they disagreed and
 * ask the pharmacist to open the bottle. The NDC Directory's package file states it outright, per
 * package NDC, and the FDA is not selling anything.
 *
 * The field is a nest, outermost first, joined by ">":
 *
 *   "6 BLISTER PACK in 1 CARTON (0555-9043-58) > 28 TABLET in 1 BLISTER PACK"
 *   "25 VIAL in 1 CARTON (67457-0623-99) > 10 mL in 1 VIAL"
 *   "1 VIAL, SINGLE-DOSE in 1 CARTON (0002-1484-80) > .5 mL in 1 VIAL, SINGLE-DOSE"
 *
 * So the package holds the product of every level's count, in whatever the innermost level counts:
 * 6 × 28 = 168 tablets, 25 × 10 = 250 mL, 1 × 0.5 = 0.5 mL. A dispensing unit is a tablet, a
 * millilitre or a gram, so a count of anything — tablets, patches, syringes — is EA, and only a
 * volume or a mass carries its own measure.
 *
 * Returns null rather than a guess where the field is not this shape: an invented package is worse
 * than an absent one, because the whole point of this is to be the party nobody argues with.
 */
export function packageUnits(packageDescription: string): { units: number; uom: "EA" | "ML" | "GM" } | null {
  /*
   * One reader of the FDA's package text, not two.
   *
   * This used to read the nest itself and treated any alphabetic noun at the innermost level as a
   * thing the pharmacy counts. Containers are alphabetic nouns too, so "3 BLISTER PACK in 1 CARTON"
   * — where the FDA never says what is inside — came back as three, and against a catalogue saying
   * eighty-four that read as a twenty-eight-fold disagreement that was not one. The reader in
   * data-health-packages.ts refuses a description that stops at a container and says why; this
   * keeps its shape for the callers that only want a size or nothing.
   */
  const r = fdaPackageUnits(packageDescription);
  return r.ok ? { units: r.units, uom: r.uom } : null;
}

