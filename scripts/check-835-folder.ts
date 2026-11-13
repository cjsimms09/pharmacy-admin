/**
 * Does the ProviderPay folder hold every remittance's 835, once?
 *
 * Run after copying a month's downloads into the folder:
 *   npx tsx scripts/check-835-folder.ts "C:\Users\wwfprx\OneDrive\ProviderPay"
 *
 * The list of what should be there is the Remit Summary CSV from the same month (ProviderPay, Export > Remit Summary > Export CSV;
 * never Remit Detail, which carries patient names). Each 835's remit number is read from its TRN segment and its amount from its BPR
 * segment, and nothing else in the file is read or printed, so no patient detail reaches the screen.
 *
 * Prints how many remittances are expected, present, missing and duplicated, and where the 835 amount differs from the CSV.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.log('Usage: npx tsx scripts/check-835-folder.ts "<folder with the 835 files and the Remit Summary CSV>"');
  process.exit(1);
}

const csvName = readdirSync(dir)
  .filter((f) => /^Remittance_.*\.csv$/i.test(f) && !/\(\d+\)/.test(f))
  .sort()[0];
if (!csvName) {
  console.log("No Remit Summary CSV (Remittance_YYYYMMDD_YYYYMMDD.csv) in the folder, so there is nothing to check against.");
  process.exit(1);
}

/** One CSV line to fields, quotes honoured. */
function fields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const lines = readFileSync(join(dir, csvName), "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
const head = fields(lines[0]);
const iNum = head.indexOf("Remit number");
const iAmt = head.indexOf("Remit amt");
if (iNum < 0) {
  console.log("The CSV has no 'Remit number' column; it may be the wrong export.");
  process.exit(1);
}
const expected = new Map<string, number | null>();
for (const l of lines.slice(1)) {
  const f = fields(l);
  const amt = Number(String(f[iAmt] ?? "").replace(/[$,]/g, ""));
  expected.set(f[iNum].trim(), Number.isFinite(amt) ? Math.round(amt * 100) : null);
}

const seen = new Map<string, { files: string[]; cents: number | null }>();
for (const f of readdirSync(dir).filter((n) => /_835\.txt$/i.test(n) || /\.835$/i.test(n))) {
  const text = readFileSync(join(dir, f), "latin1");
  const trn = /TRN\*1\*([^*~]+)/.exec(text)?.[1]?.trim();
  const bpr = /BPR\*[A-Z]*\*([-\d.]+)/.exec(text)?.[1];
  const key = trn ?? `(no TRN in ${f})`;
  const cents = bpr !== undefined ? Math.round(Number(bpr) * 100) : null;
  const e = seen.get(key) ?? { files: [], cents };
  e.files.push(f);
  seen.set(key, e);
}

const missing = [...expected.keys()].filter((k) => !seen.has(k));
const dupes = [...seen.entries()].filter(([, v]) => v.files.length > 1);
const unexpected = [...seen.keys()].filter((k) => !expected.has(k));
const amountDiffers = [...seen.entries()].filter(([k, v]) => expected.get(k) != null && v.cents != null && expected.get(k) !== v.cents);

console.log(`Expected ${expected.size} remittances (from ${csvName}); ${[...seen.keys()].filter((k) => expected.has(k)).length} have an 835.`);
console.log(missing.length ? `MISSING ${missing.length}: ${missing.join(", ")}` : "Missing: none.");
console.log(dupes.length ? `DUPLICATED ${dupes.length}: ${dupes.map(([k, v]) => `${k} x${v.files.length}`).join(", ")}` : "Duplicated: none.");
if (unexpected.length) console.log(`Not in the CSV: ${unexpected.join(", ")}`);
if (amountDiffers.length) console.log(`835 amount differs from the CSV: ${amountDiffers.map(([k]) => k).join(", ")}`);
