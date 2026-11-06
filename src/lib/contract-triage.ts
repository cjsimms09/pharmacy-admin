import { z } from "zod";

/**
 * Sorting the folder before reading it.
 *
 * Three hundred and fifty PDFs came down from the portals, and not every one is a contract: a W-9,
 * a newsletter, a credentialing form, a remittance, the same amendment saved twice. A full read
 * costs real money per page and produces nothing from those. So each document is sorted first, and
 * the expensive read goes only to the ones the sort could not rule out.
 *
 * Two sorters, cheapest first. A PDF with a text layer is sorted here, by its own words, for
 * nothing. A scan has no words to sort by, so it goes to a small model with a one-line question and
 * a fifty-token answer — about a twentieth of what the full read costs. Either sorter is allowed to
 * be unsure, and an unsure document is read in full: the cost of a wasted read is dollars, the
 * cost of a skipped contract is an appeal that never happens.
 */

export const TRIAGE_KINDS = ["contract", "rate_sheet", "notice", "manual", "not_relevant", "unsure"] as const;
export type TriageKind = (typeof TRIAGE_KINDS)[number];

export const KIND_MEANS: Record<TriageKind, string> = {
  contract: "An agreement, amendment, addendum or exhibit that binds the pharmacy: read it.",
  rate_sheet: "A reimbursement or rate exhibit: read it.",
  notice: "A notice of a change to rates, terms or networks: read it.",
  manual: "A provider manual or policy document a contract incorporates: read it.",
  not_relevant: "Not a contract and not incorporated by one: forms, statements, marketing, remittances, letters of no consequence. Skipped by the read.",
  unsure: "The sort could not tell. Read it.",
};

/** Kinds the full read goes to. `not_relevant` is the only one it skips. */
export const READ_KINDS: ReadonlySet<TriageKind> = new Set(["contract", "rate_sheet", "notice", "manual", "unsure"]);

export const Triage = z.object({
  kind: z.enum(TRIAGE_KINDS),
  counterparty: z.string().nullable().describe("The PBM, payer or wholesaler named on the document, as written, or null."),
  why: z.string().describe("One sentence: what the document is, from its first pages."),
  confidence: z.number().describe("0 to 1."),
});
export type TriageT = z.infer<typeof Triage>;

export const TRIAGE_SYSTEM = `You sort a pharmacy's documents before an expensive full read. Answer only from what the document shows.

Kinds:
- contract: an agreement, amendment, addendum, exhibit, schedule or election form that binds the pharmacy to a PBM, payer, PSAO or wholesaler.
- rate_sheet: a reimbursement or rate exhibit, fee schedule, network pricing or MAC terms.
- notice: a letter or bulletin announcing a change to rates, terms, networks, fees or audit rules.
- manual: a provider manual, policy manual or program guide a contract incorporates.
- not_relevant: anything else — a W-9, a remittance or statement, an invoice, an application or credentialing form with no terms, a newsletter, marketing, a certificate, a cover letter with no terms, a blank form.
- unsure: you cannot tell from the pages shown.

Rules: if the document carries any dollar, percentage, fee, BIN, PCN, network name or effective date that could govern a claim, it is not "not_relevant". When in doubt say unsure — a wasted read costs a little; a skipped contract costs an appeal.`;

/** What one sort costs at the small model's batch rates, in dollars. */
export function estimateTriageCost(pages: number, rates = { in: 0.8, out: 4 }): number {
  // Every page is sent as text and as an image; the answer is a few dozen tokens.
  return ((pages * 2500) / 1e6) * rates.in * 0.5 + (Math.max(1, pages / 12) * 80 / 1e6) * rates.out * 0.5;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

const BINDING = [
  /\bagreement\b/, /\bamendment\b/, /\baddendum\b/, /\bexhibit\b/, /\bschedule\s+[a-z0-9]/, /\bterms and conditions\b/, /\bparticipating pharmacy\b/, /\bprovider agreement\b/, /\bnetwork agreement\b/, /\bwhereas\b/, /\bin witness whereof\b/, /\bthis .{0,40}agreement\b/,
];
const PRICING = [
  /\breimburs/, /\bdispensing fee\b/, /\bawp\b/, /\bwac\b/, /\bmac\b/, /\bnadac\b/, /\bmaximum allowable cost\b/, /\bingredient cost\b/, /\brate exhibit\b/, /\bfee schedule\b/, /\bbrand\b.{0,40}\bgeneric\b/, /\bdir\b/, /\bper claim\b/, /\bbin\b\s*[:#]?\s*\d{6}/, /\bpcn\b/, /\bnetwork\b/, /\beffective (date|as of)\b/,
];
const NOTICE = [/\bnotice\b/, /\bnotification\b/, /\bbulletin\b/, /\beffective\b.{0,60}\b(rate|fee|term|network)/, /\bthis letter is to (inform|notify)\b/, /\bwe are writing to\b/];
const MANUAL = [/\bprovider manual\b/, /\bpharmacy manual\b/, /\bpolicy manual\b/, /\bprogram guide\b/, /\btable of contents\b/];
const IRRELEVANT = [
  /\bform w-?9\b/, /\brequest for taxpayer identification\b/, /\bremittance advice\b/, /\bexplanation of (payment|benefits)\b/, /\bstatement of account\b/, /\binvoice number\b/, /\bcredentialing application\b/, /\bnewsletter\b/, /\bunsubscribe\b/, /\bcertificate of (insurance|completion|liability)\b/, /\bpress release\b/, /\bwebinar\b/, /\bthank you for your (order|purchase)\b/, /\bpacking (slip|list)\b/,
];

const count = (t: string, res: RegExp[]) => res.reduce((n, r) => n + (r.test(t) ? 1 : 0), 0);

/**
 * Sorts a document by its own text. Null where there is too little text to sort by (a scan).
 *
 * Scores, not a classifier: a document that names an agreement or a price is never dismissed,
 * whatever else it says. Only a document with the marks of a form or a statement and none of a
 * contract is set aside, and even then the reason is written down so a person can overrule it.
 */
export function triageByText(text: string, fileName = ""): TriageT | null {
  const t = norm(text);
  if (t.replace(/[^a-z]/g, "").length < 120) return null;
  const head = t.slice(0, 6000);
  const binding = count(t, BINDING);
  const pricing = count(t, PRICING);
  const notice = count(head, NOTICE);
  const manual = count(head, MANUAL);
  const irrelevant = count(head, IRRELEVANT);
  const name = norm(fileName);
  const nameSaysContract = /agreement|amendment|addendum|exhibit|contract|rate|schedule|network|manual|terms/.test(name);

  if (manual >= 1 && (pricing >= 2 || binding >= 1)) return { kind: "manual", counterparty: null, why: `Reads as a provider manual: ${manual} manual mark(s), ${pricing} pricing term(s).`, confidence: 0.7 };
  if (binding >= 2 && pricing >= 2) return { kind: "contract", counterparty: null, why: `Reads as an agreement with pricing terms: ${binding} binding mark(s), ${pricing} pricing term(s).`, confidence: 0.85 };
  if (pricing >= 4) return { kind: "rate_sheet", counterparty: null, why: `Carries ${pricing} pricing terms (rates, fees, AWP, MAC, BIN or network) and few binding words.`, confidence: 0.7 };
  if (binding >= 2) return { kind: "contract", counterparty: null, why: `Reads as an agreement: ${binding} binding mark(s), little pricing on its face.`, confidence: 0.65 };
  if (notice >= 2 && (pricing >= 1 || binding >= 1)) return { kind: "notice", counterparty: null, why: `A notice naming a change to terms or rates (${notice} notice mark(s)).`, confidence: 0.65 };
  if (irrelevant >= 1 && binding === 0 && pricing <= 1 && !nameSaysContract) {
    return { kind: "not_relevant", counterparty: null, why: `Marks of a form, statement or mailing (${irrelevant}) and none of an agreement or a rate.`, confidence: 0.75 };
  }
  if (binding === 0 && pricing === 0 && notice === 0 && !nameSaysContract) {
    return { kind: "not_relevant", counterparty: null, why: "No agreement, pricing, network or notice words in the text at all.", confidence: 0.6 };
  }
  return { kind: "unsure", counterparty: null, why: `Mixed signals: ${binding} binding, ${pricing} pricing, ${notice} notice mark(s). Read it.`, confidence: 0.4 };
}

/** The read the full run should do, given a sort: everything but what was ruled out. */
export function shouldRead(kind: TriageKind | null | undefined): boolean {
  return kind == null || READ_KINDS.has(kind);
}
