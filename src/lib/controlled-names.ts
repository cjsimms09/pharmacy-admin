/**
 * Controlled substances by name, for invoices that do not say.
 *
 * Two of the pharmacy's three wholesalers mark the schedule on the invoice — one with an item
 * class, one with a "C-2" in a DEA column — and where a supplier states it, that statement is
 * used and this list is never consulted. The third prints no schedule anywhere. Its only code
 * column means "taxed", "net priced" or "web special", and an invoice from them is otherwise
 * twenty lines of drug names and prices.
 *
 * So for those, the names are read. That is a weaker source than the supplier's own marking and
 * it is treated as one, but the alternative is worse: every invoice from that supplier waiting in
 * a queue for somebody to confirm what a glance at it already shows, which is how a review queue
 * becomes a thing people click through without reading.
 *
 * The lists are asymmetric on purpose, because the consequences are.
 *
 * Missing a Schedule II is the failure that matters — 21 CFR 1304.04(h)(1) requires those records
 * to be kept apart from everything else, and a C2 invoice in the general pile is a finding. The
 * Schedule II list is therefore meant to be exhaustive for what a retail pharmacy can actually
 * buy: it is a small, stable, well-known set of molecules, and every brand name they are sold
 * under is here too.
 *
 * Missing a Schedule III to V is a much smaller thing, because 1304.04(h)(2) permits those to sit
 * with ordinary business records so long as the information is readily retrievable — which it is
 * here, by supplier, by month, by drug name and by invoice number. So that list aims to be good
 * rather than perfect.
 *
 * Where a name is ambiguous the entry sits in the more cautious list. Over-calling a schedule
 * files an invoice somewhere stricter than it needed to be, which costs nothing.
 */

/**
 * Schedule II, and meant to be complete for community pharmacy.
 *
 * Generic stems first, then the brands, because an invoice line may carry either and often
 * carries an abbreviation of one — "OXYCOD+APAP", "MIX AMPHET SLT", "LISDEXAMF DIM".
 */
export const SCHEDULE_2_NAMES = [
  // ── Opioids ──
  "oxycodone", "oxycod", "oxycontin", "roxicodone", "roxybond", "xtampza", "percocet", "endocet", "primlev",
  "oxymorphone", "oxymorph", "opana",
  "hydrocodone", "hydrocod", "norco", "vicodin", "lortab", "hysingla", "zohydro", "lorcet", "verdrocet",
  "hydromorphone", "hydromorph", "dilaudid", "exalgo",
  "morphine", "ms contin", "morphabond", "arymo", "kadian", "infumorph", "duramorph", "mitigo",
  "methadone", "methadose", "dolophine", "diskets",
  "fentanyl", "duragesic", "actiq", "fentora", "subsys", "abstral", "lazanda",
  "sufentanil", "alfentanil", "remifentanil", "dsuvia",
  "meperidine", "demerol",
  "tapentadol", "nucynta",
  "levorphanol",
  "oliceridine", "olinvyk",
  "dihydrocodeine",
  "opium", "opium tincture", "papaveretum",
  "codeine sulf", "codeine sulfate", "codeine phos tab", "codeine tab",
  "carfentanil", "thiafentanil",
  // ── Stimulants ──
  "amphetamine", "amphet", "dextroamphetamine", "dextroamp", "adderall", "mydayis", "evekeo", "zenzedi",
  "dexedrine", "adzenys", "dyanavel", "xelstrym", "procentra",
  "lisdexamfetamine", "lisdexamf", "vyvanse",
  "methylphenidate", "methylphen", "ritalin", "concerta", "metadate", "methylin", "quillivant", "quillichew",
  "daytrana", "jornay", "adhansia", "cotempla", "relexxii", "aptensio",
  "dexmethylphenidate", "dexmethylphen", "focalin",
  "serdexmethylphenidate", "azstarys",
  "methamphetamine", "desoxyn",
  "cocaine", "goprelto", "numbrino",
  // ── Barbiturates and others ──
  "secobarbital", "seconal",
  "pentobarbital", "nembutal",
  "amobarbital", "amytal",
  "glutethimide", "phenmetrazine", "phencyclidine",
  "nabilone", "cesamet",
  "droperidol no", // never matched; kept out of the way of a real entry being deleted by mistake
] as const;

/** Schedule III, IV and V — good coverage rather than exhaustive, for the reasons above. */
export const SCHEDULE_3_5_NAMES = [
  // ── Buprenorphine and opioid combinations ──
  "buprenorphine", "bupren", "bupre+nal", "suboxone", "subutex", "sublocade", "belbuca", "butrans", "brixadi", "zubsolv",
  "codeine", "tylenol with codeine", "tylenol w/codeine", "promethazine with codeine", "prometh w/codeine",
  "guaifenesin ac", "guaifenesin with codeine", "cheratussin", "virtussin",
  "paregoric",
  "tramadol", "ultram", "ultracet", "qdolo", "conzip",
  "diphenoxylate", "lomotil", "difenoxin", "motofen",
  "butalbital", "fioricet", "fiorinal", "butalb",
  // ── Anabolic steroids ──
  "testosterone", "testos", "depo-testosterone", "androgel", "testim", "axiron", "fortesta", "natesto", "jatenzo",
  "aveed", "xyosted", "tlando", "kyzatrex", "methyltestosterone", "android", "methitest",
  "nandrolone", "oxandrolone", "oxymetholone", "anadrol", "stanozolol", "danazol", "fluoxymesterone",
  // ── Benzodiazepines ──
  "alprazolam", "alprazol", "xanax",
  "lorazepam", "ativan", "loreev",
  "diazepam", "valium", "valtoco", "diastat",
  "clonazepam", "klonopin",
  "temazepam", "restoril",
  "triazolam", "halcion",
  "chlordiazepoxide", "librium", "librax",
  "clorazepate", "tranxene",
  "oxazepam", "estazolam", "flurazepam", "quazepam", "doral",
  "midazolam", "nayzilam", "seizalam", "remimazolam",
  "clobazam", "onfi", "sympazan",
  // ── Sedatives and hypnotics ──
  "zolpidem", "ambien", "edluar", "zolpimist", "intermezzo",
  "zaleplon", "sonata",
  "eszopiclone", "lunesta",
  "phenobarbital", "primidone no",
  "suvorexant", "belsomra", "lemborexant", "dayvigo", "daridorexant", "quviviq",
  "sodium oxybate", "xyrem", "xywav", "lumryz",
  "ketamine", "ketalar", "esketamine", "spravato",
  "dronabinol", "marinol", "syndros",
  // ── Muscle relaxants, anticonvulsants, others ──
  "carisoprodol", "soma",
  "pregabalin", "lyrica",
  "lacosamide", "vimpat",
  "brivaracetam", "briviact",
  "perampanel", "fycompa",
  "cenobamate", "xcopri",
  "ezogabine", "potiga",
  "eluxadoline", "viberzi",
  "modafinil", "provigil", "armodafinil", "nuvigil",
  "solriamfetol", "sunosi",
  "phentermine", "adipex", "lomaira", "qsymia",
  "diethylpropion", "phendimetrazine", "benzphetamine", "didrex",
  "lorcaserin", "belviq",
  "pyrovalerone", "chlorphentermine",
] as const;

/** Entries kept only so a deliberate non-match is obvious rather than looking like an omission. */
const NEVER = new Set(["droperidol no", "primidone no"]);

/**
 * Case-insensitive, and never matched inside a longer word.
 *
 * Letters on either side disqualify a match; digits and punctuation do not. Both halves of that
 * are load-bearing and both were learned from real invoices.
 *
 * Letters after matter because "soma" sits inside "somatropin", which is a growth hormone and not
 * a muscle relaxant. Filing an invoice as controlled because of that would be wrong, and the
 * list is full of short brand names that would do the same thing.
 *
 * Digits before matter because one wholesaler prints the item number hard against the drug name
 * with no space — "5300001Alprazolam Tabs 1mg" — so a rule that demanded whitespace would read
 * every controlled line on their invoices as ordinary stock. That is the failure this whole list
 * exists to prevent, produced by the guard meant to prevent it.
 */
function hits(text: string, names: readonly string[]): string[] {
  const hay = text.toLowerCase();
  const found: string[] = [];
  for (const n of names) {
    if (NEVER.has(n)) continue;
    let at = hay.indexOf(n);
    while (at >= 0) {
      const before = at === 0 ? " " : hay[at - 1];
      const after = at + n.length >= hay.length ? " " : hay[at + n.length];
      if (!/[a-z]/.test(before) && !/[a-z]/.test(after)) {
        found.push(n);
        break;
      }
      at = hay.indexOf(n, at + 1);
    }
  }
  return found;
}

export type NameVerdict = {
  schedule: "schedule_2" | "schedule_3_5" | "none";
  /** The names that decided it, for the record and for somebody checking the reasoning. */
  matched: string[];
};

/**
 * What the names on these lines say the invoice carries.
 *
 * Schedule II wins outright: one Schedule II line makes the whole invoice a Schedule II record,
 * because the record is the document and the document has to be kept apart.
 */
export function scheduleFromNames(lines: string[]): NameVerdict {
  const text = lines.join("\n");
  const two = hits(text, SCHEDULE_2_NAMES);
  if (two.length > 0) return { schedule: "schedule_2", matched: two };
  const lower = hits(text, SCHEDULE_3_5_NAMES);
  if (lower.length > 0) return { schedule: "schedule_3_5", matched: lower };
  return { schedule: "none", matched: [] };
}

/** The lines a name matched, so a finding can show the line rather than only the word. */
export function linesMatching(lines: string[], names: string[]): string[] {
  const lowered = names.map((n) => n.toLowerCase());
  return lines.filter((l) => lowered.some((n) => l.toLowerCase().includes(n)));
}
