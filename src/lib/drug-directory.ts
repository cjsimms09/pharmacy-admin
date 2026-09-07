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
  const out: DrugDirectoryRow[] = [];
  for (const pk of packages) {
    const p = byProduct.get(pk.productNdc);
    if (!p) continue;
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
 * Whether one NDC may be dispensed in place of another: the same key, and both rated
 * therapeutically equivalent. Two unrated products with the same key are the same drug on paper
 * and still not called substitutable here, because nothing has said they are.
 */
export function substitutable(a: Pick<DrugDirectoryRow, "equivalenceKey" | "teCode">, b: Pick<DrugDirectoryRow, "equivalenceKey" | "teCode">): boolean {
  return a.equivalenceKey === b.equivalenceKey && isARated(a.teCode) && isARated(b.teCode);
}
