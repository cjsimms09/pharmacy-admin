import type { PlanClass } from "@/db/schema";
import { payerSheetFor, LOB_CLASS, LOB_LABEL } from "./payer-sheets";

/**
 * What kind of plan this is, from every source that has anything to say — and how good each answer
 * is.
 *
 * 1,436 of this pharmacy's claims sit on a plan nobody has classified. That single gap stops the
 * Kansas floor programme dead: SB 20 needs no contract and no MAC list, only the plan type, and
 * without it the rung never fires. So this is the file that unblocks it.
 *
 * ── The rule this file exists to enforce ──
 *
 * A guess must never be indistinguishable from a fact. This codebase has been bitten by exactly
 * that repeatedly, and the owner has spent two days finding those cases. So every answer here
 * carries three things and is useless without them:
 *
 *   classification — what it is
 *   source         — where that came from, named, so it can be checked a year later
 *   confidence     — "stated" where a record says it in so many words, "indicated" where a code or
 *                    a listing points at it strongly enough to offer
 *
 * Nothing weaker than "indicated" is ever returned as a finding. Where the evidence does not
 * settle it, this returns the reason it does not — which is more useful than a plausible answer,
 * because it names the document that would settle it.
 *
 * ── Pure ──
 *
 * Reaches no database. The store finds the rows, this decides, and `plans.ts` still requires a
 * person to adopt anything the Kansas floor turns on.
 */

/** Where an answer came from. Stored, shown, and the first thing anybody will question. */
export type EvidenceSource =
  /** The payer's own published pharmacy payer sheet, or a CMS file, naming this BIN and PCN. */
  | "payer_sheet"
  /** PioneerRx's shipped plan reference, `ThirdParty.ThirdPartyPlan`. Nobody at this pharmacy typed it. */
  | "pioneer_plan_file"
  /** This pharmacy's own third-party record in PioneerRx, set by somebody here when the payer was first billed. */
  | "pioneer_pharmacy"
  /** The processor control number on the claim itself. */
  | "pcn"
  /** The `payer_bins` listing's line of business for the BIN. */
  | "bin_listing"
  /** The payer's own name as the claim or the plan file wrote it. */
  | "payer_name";

export const SOURCE_LABEL: Record<EvidenceSource, string> = {
  payer_sheet: "the payer's own payer sheet",
  pioneer_plan_file: "PioneerRx's plan file",
  pioneer_pharmacy: "PioneerRx, set at this pharmacy",
  pcn: "the PCN on the claim",
  bin_listing: "the BIN listing",
  payer_name: "the payer's own name",
};

/**
 * How well the source settles it.
 *
 * Two levels rather than a percentage, because a number invites arithmetic nobody can defend.
 * "Stated" means a record says it in words — a plan named "Bc/bs Kansas Pdp" filed as Part D.
 * "Indicated" means a code or a listing points at it hard enough to be worth offering, but the
 * document itself has not been read.
 */
export type Confidence = "stated" | "indicated";

export type PlanFinding = {
  classification: PlanClass;
  source: EvidenceSource;
  confidence: Confidence;
  /** One sentence, quoting what it was read from. This is what gets stored as the basis. */
  from: string;
  /**
   * The distinction the register's classes cannot hold: Part D versus Medicare Advantage, or
   * Part B. Both are `medicare` and both are out of the Kansas floor's reach for the same reason,
   * so the class is right — but the owner asked which, and throwing it away would be losing an
   * answer we have. Null where it does not apply.
   */
  detail: string | null;
};

/** No finding, and the reason — which usually names the document that would settle it. */
export type NoFinding = { classification: null; why: string };

export function isFinding(r: PlanFinding | NoFinding): r is PlanFinding {
  return r.classification !== null;
}

/** One row of what PioneerRx holds for a BIN and PCN. Shape mirrors `pioneer_plan_types`. */
export type PioneerPlanRow = {
  bin: string;
  pcn: string;
  source: "plan_file" | "pharmacy";
  planName: string | null;
  processor: string | null;
  planType: string | null;
  isActive: boolean;
};

export type PlanEvidence = {
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  /** The payer as the claims export wrote it. */
  payerLabel: string | null;
  /** The PBM the BIN resolved to. */
  pbmName: string | null;
  /** `payer_bins.lines_of_business`, free text as the listing prints it. */
  linesOfBusiness: string | null;
  /** Everything PioneerRx holds for this BIN and PCN. Empty where it holds nothing. */
  pioneer?: PioneerPlanRow[];
};

const norm = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();
const has = (s: string | null | undefined, re: RegExp) => (s ? re.test(s) : false);

// ── What PioneerRx's words mean here ──────────────────────────────────
//
// PioneerRx offers nine plan types and only some of them are answers to the question this register
// asks. The map is short on purpose; anything not in it contributes nothing, and the two omissions
// below are deliberate rather than forgotten.
//
//  - "Government" is missing. It is a billing category in PioneerRx, not an ERISA finding, and
//    `governmental` is one of the four classes `plans.ts` will not let anybody set without a
//    document — because it is the finding that puts a plan *in* reach of the Kansas floor and it
//    will be argued about. So a Government filing is surfaced as a reason to go and look
//    (`governmentHint` below) and never as a proposal.
//  - "Cash/AR" is missing. It means cash *or* accounts receivable, and the second is a nursing home
//    billed on account, which is not a discount card and not out of scope. One word covering two
//    opposite answers cannot settle either.
const PIONEER_CLASS: Record<string, { cls: PlanClass; detail: string | null }> = {
  "PART D": { cls: "medicare", detail: "Medicare Part D" },
  "MEDICARE PART D": { cls: "medicare", detail: "Medicare Part D" },
  "MEDICARE PART B": { cls: "medicare", detail: "Medicare Part B" },
  MEDICAID: { cls: "medicaid", detail: null },
  "MEDICAID/WELFARE": { cls: "medicaid", detail: null },
  "WORKER'S COMP": { cls: "workers_comp", detail: null },
  "WORKERS COMP": { cls: "workers_comp", detail: null },
};

/**
 * The word that means "nobody answered".
 *
 * This is the single most important line in the file. PioneerRx defaults every third-party record
 * to "Standard", so Standard is the absence of a classification wearing the clothes of one. GoodRx
 * is filed Standard. This pharmacy's own PharmD Loyalty cash plan is filed Standard. Cigna
 * Commercial and Bc/bs Kansas are filed Standard, and those are precisely the plans where the
 * commercial/ERISA question — the only question the Kansas floor turns on — is still wide open.
 *
 * On September's claims 535 sit on a plan typed Standard. Reading those as classified would have
 * been the largest single piece of fiction this site has ever held, and it would have been
 * invisible, because it would have arrived with "PioneerRx" written next to it.
 *
 * "Documentary" is PioneerRx's test and certification plans and means less than nothing.
 */
const MEANS_NOTHING = new Set(["STANDARD", "DOCUMENTARY", "", "ASSIGNMENT OF BENEFITS", "INDIGENT CASE"]);

/**
 * What PioneerRx says for one BIN and PCN, or why it says nothing usable.
 *
 * Unanimity is required among the rows that say anything at all, and that requirement is doing
 * real work. BIN 004336 PCN ADV carries thirteen named plans in the plan file — Amerigroup, Molina,
 * Bc/bs Arkansas, Oklahoma State Employees, and SilverScript Plus Pdp. Two are Part D and eleven are
 * not. Taking the two would classify a hundred and fifty commercial claims as Medicare; taking a
 * majority would be a vote, not evidence. So a split says so, and names the split.
 */
function fromPioneer(rows: PioneerPlanRow[], which: "plan_file" | "pharmacy", bin: string | null, pcn: string | null): PlanFinding | NoFinding {
  const mine = rows.filter((r) => r.source === which && r.isActive);
  if (mine.length === 0) return { classification: null, why: "" };

  const answered = mine.filter((r) => !MEANS_NOTHING.has(norm(r.planType)) && PIONEER_CLASS[norm(r.planType)]);
  if (answered.length === 0) return { classification: null, why: "" };

  const classes = new Set(answered.map((r) => PIONEER_CLASS[norm(r.planType)].cls));
  const where = `BIN ${bin ?? "—"} / PCN ${pcn || "(blank)"}`;
  if (classes.size > 1) {
    return {
      classification: null,
      why: `${which === "plan_file" ? "PioneerRx's plan file" : "PioneerRx's records here"} disagrees with itself on ${where}: ${[...classes].join(" and ")}. One BIN and PCN carrying two lines of business is normal, so neither answer is taken.`,
    };
  }

  /*
   * A silent majority is not a majority.
   *
   * `answered` excludes every Standard row, so a BIN and PCN carrying eleven commercial plans and
   * two Part D ones would arrive here looking unanimous. It is not: those eleven are eleven
   * commercial plans on the same routing, and the PCN plainly does not select a line of business.
   * So the rows that said nothing are counted too, and a mixture is refused with the count in it —
   * which is the sentence that tells the owner what he is actually looking at.
   */
  const silent = mine.length - answered.length;
  if (silent > 0) {
    return {
      classification: null,
      why:
        `PioneerRx's ${which === "plan_file" ? "plan file" : "records here"} lists ${mine.length} plans on ${where}: ` +
        `${answered.length} filed as ${[...classes][0].replace(/_/g, " ")} and ${silent} not filed as anything. ` +
        `This BIN and PCN carry more than one kind of plan, so neither answer covers the claims.`,
    };
  }

  const cls = [...classes][0];
  const example = answered.find((r) => (r.planName ?? "").trim())?.planName?.trim();
  const details = [...new Set(answered.map((r) => PIONEER_CLASS[norm(r.planType)].detail).filter(Boolean))] as string[];
  return {
    classification: cls,
    source: which === "plan_file" ? "pioneer_plan_file" : "pioneer_pharmacy",
    // The plan file is a reference PioneerRx ships and it states the type outright. What somebody
    // here set when the payer was first billed is a person's answer rather than a document's, and
    // it is right far more often than not — but it is not a document, so it is only indicated.
    confidence: which === "plan_file" ? "stated" : "indicated",
    from:
      which === "plan_file"
        ? `PioneerRx's plan file files ${where}${example ? ` — "${example}"` : ""} as ${answered[0].planType}.`
        : `PioneerRx's own record for ${where}${example ? ` ("${example}")` : ""}, set at this pharmacy, is ${answered[0].planType}.`,
    detail: details.length === 1 ? details[0] : null,
  };
}

/**
 * A PioneerRx "Government" filing, which is a lead rather than an answer.
 *
 * `governmental` is one of the four classes that decide whether the Kansas floor reaches a plan, so
 * it needs a document and cannot be proposed. But a plan PioneerRx has filed as Government is very
 * likely a city, county, school district or state plan — which is *in* scope, because those are
 * excluded from ERISA by definition. That is the most valuable unanswered question on the register,
 * and it is worth telling the owner which rows to go and look at rather than burying it.
 */
/**
 * The words a plan's name uses when the employer is a government.
 *
 * Read from a *name*, never a group number: a group number is a code, and "COUNTY" inside one says
 * nothing about who the employer is. "University of" is left out on purpose — a private university
 * is an ordinary ERISA employer and only a state one is governmental, and the name does not say
 * which.
 */
const GOVERNMENT_EMPLOYER =
  /\b(?:city of|county of|state of|board of education|school district|unified school district|public (?:employees?|schools?)|state employees?)\b/i;

/** True where a name says, in words, that the employer is a government. */
export function namesAGovernmentEmployer(name: string | null | undefined): boolean {
  return GOVERNMENT_EMPLOYER.test(name ?? "");
}

export function governmentHint(rows: PioneerPlanRow[] | undefined, payerLabel?: string | null): string | null {
  /*
   * The name counts as well as the filing, and on this pharmacy's data only the name ever fires.
   *
   * This looked for `planType === "Government"` alone. Not one of the 2,136 rows in PioneerRx's
   * plan file carries that type — every one of them is "Standard" — so the hint had never once
   * appeared, on a register where it is the most valuable thing that could. Meanwhile six plan names
   * say it outright ("City Of Alexandria", "County Of El Paso") and the pharmacy's own claims carry
   * "City of Wichita" in the payer label on twenty-three plan groups.
   *
   * Still a hint and still not a classification: `governmental` decides whether the floor reaches a
   * plan, so it needs a document and stays out of `PROPOSABLE`. What changes is that the lead now
   * reaches him at all.
   */
  const active = (rows ?? []).filter((r) => r.isActive);
  /*
   * A routing that names many plans names none of them — the same guard `findPlanClass` applies to the
   * plan file, for the same reason.
   *
   * BIN 610014 carries several plans and one of them is "Oklahoma State Employees". Reading that as a
   * lead about every claim on the BIN is how joining thirteen names under 004336/ADV once classified
   * 151 commercial claims as Part D. So a name from the plan file counts only where the file names
   * exactly one plan for this routing; a name on the claim's own payer label always counts, because
   * that label is about this claim and nothing else.
   */
  const named = [...new Set(active.map((r) => (r.planName ?? "").trim()).filter(Boolean))];
  const single = named.length === 1;
  const gov = active.filter(
    (r) => norm(r.planType) === "GOVERNMENT" || (single && namesAGovernmentEmployer(r.planName)),
  );
  const labelSays = namesAGovernmentEmployer(payerLabel);
  if (gov.length === 0 && !labelSays) return null;
  const name = gov.find((r) => (r.planName ?? "").trim())?.planName?.trim() ?? (labelSays ? (payerLabel ?? "").trim() : undefined);
  return (
    `${
      gov.some((r) => norm(r.planType) === "GOVERNMENT")
        ? "PioneerRx has this filed as a Government plan"
        : "This plan is named for a government employer"
    }${name ? ` ("${name}")` : ""}. If that is right the Kansas floor ` +
    `reaches it — a city, county, school district or state plan is excluded from ERISA by definition, so preemption ` +
    `does not apply even when the plan is self-funded. That is worth confirming from the plan document, because it ` +
    `is one of the few findings that puts a plan in scope rather than out of it.`
  );
}

/**
 * The PCN a register row predates, read back off its own claims.
 *
 * ── Why this had to exist ──
 *
 * 481 of the register's 491 plans are unclassified, and 211 of those rows carry no PCN at all: they
 * were made when the register was keyed on BIN and group alone, and `plan-key.ts` still lets them
 * stand as the fallback for every PCN under that BIN and group. That fallback is doing real work —
 * `planLookup` hands a claim to the PCN-less row whenever the exact row is still undecided — so on
 * this pharmacy's 2,350 paid claims those 206 PCN-less rows govern 1,237 claims and $179,029.56.
 *
 * And nothing could propose a class for any of them. Every strong source here is looked up by BIN
 * *and PCN*: the payer sheets, PioneerRx's plan file, the PCN patterns themselves. A row with no PCN
 * matched none of them, so the largest block of unclassified money on the register was the block the
 * evidence could not be pointed at — while the claims underneath it were carrying the PCN the whole
 * time.
 *
 * ── The guard, which is the same guard three other places in this file apply ──
 *
 * The PCN selects the line of business, so borrowing one is only honest where there is one to
 * borrow. Where a row's claims route on two PCNs, this returns nothing: a BIN and group carrying a
 * commercial PCN and a Part D PCN is precisely the case the register was re-keyed to stop treating
 * as one plan, and reading a majority off it would be the "silent majority" fault that once filed
 * 151 commercial claims as Part D. On these claims 197 of the 211 PCN-less rows route on exactly one
 * PCN and 9 route on several; the 9 get nothing, and the reason says so.
 *
 * A claim carrying no PCN counts as its own routing, for the same reason: "no PCN" is a routing the
 * payer chose, not a blank to be filled in from its neighbours.
 */
export type ClaimRouting = { pcn: string | null; claims: number };

export function routingFromClaims(rowPcn: string | null | undefined, seen: ClaimRouting[]): { pcn: string; from: string } | null {
  if (norm(rowPcn) !== "") return null;
  const live = seen.filter((r) => r.claims > 0);
  const total = live.reduce((n, r) => n + r.claims, 0);
  if (total === 0) return null;
  const distinct = [...new Set(live.map((r) => norm(r.pcn)))];
  if (distinct.length !== 1) return null;
  const pcn = distinct[0];
  if (pcn === "") return null;
  return {
    pcn,
    from:
      `This register row predates the PCN being kept, so it carries none. All ${total} claim${total === 1 ? "" : "s"} on ` +
      `its BIN and group route on PCN ${pcn}, so that is the routing its evidence is read against.`,
  };
}

/*
 * The words each class is recognised by in a BIN listing.
 *
 * Deliberately narrow and anchored on the terms a listing actually prints. Loose matching here
 * would be the same fault as a loose supplier match: a plausible answer nobody can trace.
 */
const MEDICARE = /\b(part\s*-?\s*d|pdp|mapd|ma-pd|medicare)\b/i;
const MEDICAID = /\bmedicaid\b|\bmco\b|\bchip\b|\bkancare\b/i;
const WORKERS = /\bworkers?[\s'’-]*comp(ensation)?\b|\bwc\b/i;
const DISCOUNT = /\bdiscount\b|\bsavings\s*card\b|\bcash\s*card\b|\bcoupon\b/i;
const COMMERCIAL = /\bcommercial\b|\bgroup\s*health\b|\bemployer\b/i;

/*
 * A PCN is a code, not prose, and needs its own patterns.
 *
 * The word-boundary tests above are right for "Medicare Part D" printed in a listing and wrong for
 * "MEDDPRIME" on a claim — real Part D PCNs run the words together: MEDDPRIME, MEDDADV, KSPARTD.
 * Matching prose rules against a code recognised none of them, which is the whole population this
 * was meant to reach.
 */
const MEDICARE_PCN = /medd|partd|\bpdp\b|\bmapd\b/i;
const MEDICAID_PCN = /medicaid|kscaid|\bmcd\b|\bmcaid\b/i;

type Kind = "medicare" | "medicaid" | "workers" | "discount" | "commercial";

const KIND_CLASS: Record<Kind, PlanClass> = {
  medicare: "medicare",
  medicaid: "medicaid",
  workers: "workers_comp",
  discount: "discount_card",
  commercial: "unknown",
};

const KIND_WORD: Record<Kind, string> = {
  medicare: "Medicare",
  medicaid: "Medicaid",
  workers: "workers' compensation",
  discount: "discount or coupon cards",
  commercial: "commercial",
};

/**
 * Which kinds of business a piece of text names — and the reason this counts rather than matches.
 *
 * A BIN listing's line of business is not one line of business. BIN 610455's reads "Commercial &
 * Extended Day / Medicare D & Extended Day / Medicare D Home Infusion / Medicare D Preferred /
 * Commercial & Medicare D Rural / Vaccines / Workers Compensation / Magellan Commercial": seven
 * networks, because a BIN is a processor's front door and the PCN is what picks a network behind
 * it.
 *
 * The first version of this code matched those patterns one at a time in priority order, and so
 * "Medicare" appearing anywhere in that string classified Blue Cross Blue Shield of Kansas
 * commercial as Medicare — 392 September claims and $30,251.54 filed under the wrong law, with a
 * published document quoted beside them as the source. The same match made the Communications
 * Workers of America plan on BIN 610011 into Medicaid.
 *
 * Counting instead of matching is the whole fix: a listing that names one kind is evidence, and a
 * listing that names five is evidence of nothing except that the BIN is busy.
 */
/**
 * The one kind this text names, or null where it names none or several.
 *
 * With one exception, and it is the exception the register was already written around: Medicaid and
 * Medicare named together is the dual-eligible case, not a BIN carrying two networks, and the
 * narrower of the two is the truth about who actually pays. Every other combination is a processor
 * listing its business and settles nothing.
 */
function only(kinds: Set<Kind>): Kind | null {
  if (kinds.size === 1) return [...kinds][0];
  if (kinds.size === 2 && kinds.has("medicaid") && kinds.has("medicare")) return "medicaid";
  return null;
}

export function namedKinds(text: string | null | undefined): Set<Kind> {
  const out = new Set<Kind>();
  if (!text) return out;
  if (MEDICAID.test(text)) out.add("medicaid");
  if (MEDICARE.test(text)) out.add("medicare");
  if (WORKERS.test(text)) out.add("workers");
  if (DISCOUNT.test(text)) out.add("discount");
  if (COMMERCIAL.test(text)) out.add("commercial");
  return out;
}

/**
 * MPPP: the Medicare Prescription Payment Plan, which is Part D wearing an unfamiliar name.
 *
 * From 2025 a Part D beneficiary can elect to spread his cost sharing across the year under the
 * Inflation Reduction Act, and the claim then routes on a PCN beginning MPPP — MPPPKS, MPPPHCSC,
 * MPPPOR. PioneerRx's plan file calls every one of them "M3p Copay Plan" and files it Part D.
 *
 * Worth naming separately rather than folding into MEDICARE_PCN, because "MPPP" looks like nothing
 * and reads like a copay card, and a copay card is a class this register treats in the opposite
 * way. It is not one: it is the Part D plan itself, billed on an instalment arrangement.
 */
const MPPP_PCN = /^mppp/i;

/**
 * What this plan's class appears to be, from everything on file.
 *
 * The order is the ranking of the sources, strongest first, and it is the argument of this file:
 *
 *  1. PioneerRx's shipped plan file, where it speaks with one voice for this exact BIN and PCN.
 *  2. What somebody here set on the pharmacy's own third-party record for it.
 *  3. The PCN, which is a routing code the payer itself assigned.
 *  4. The BIN listing's line of business.
 *  5. The payer's own name.
 *
 * Within a source, Medicaid is tested before Medicare, because a managed Medicaid plan's listing
 * routinely names both and the narrower of the two is the truth about who pays.
 */
export function findPlanClass(e: PlanEvidence): PlanFinding | NoFinding {
  const rows = e.pioneer ?? [];
  const lob = e.linesOfBusiness;
  const names = [e.payerLabel, e.pbmName].filter(Boolean).join(" ");
  /*
   * A plan-file name is a better name than the claim's payer label — but only where there is one.
   *
   * The label on a September claim is mostly the BIN typed back at us ("610455 (BCBSKS)") while the
   * plan file says "Bc/bs Kansas", so the plan file is worth reading. What is not worth reading is
   * all of them at once. BIN 004336 PCN ADV carries thirteen named plans — Amerigroup, Molina,
   * Bc/bs Arkansas, Oklahoma State Employees, SilverScript Plus Pdp — and joining those into one
   * string and searching it for "Medicare" classified 151 commercial claims as Part D, quoting a
   * list of thirteen payers as the reason. That is the BIN-listing fault again in a second costume:
   * a routing that names many plans names none of them.
   *
   * So the plan file contributes a name only where it names exactly one plan for this routing.
   * Where it names several, `fromPioneer` above has already produced the sentence that says so.
   */
  const planNames = [...new Set(rows.filter((r) => r.isActive).map((r) => (r.planName ?? "").trim()).filter(Boolean))];
  const allNames = [names, planNames.length === 1 ? planNames[0] : ""].filter(Boolean).join(" | ");

  const split: string[] = [];

  /*
   * The payer's own published payer sheet, which outranks everything else here.
   *
   * Everything else this file reads is somebody's summary: the BIN listing is a third party's
   * index, PioneerRx's plan file is a software vendor's reference, the PCN is a code that has to be
   * interpreted. A payer sheet is the payer stating, in a document it publishes for pharmacies,
   * which BIN and PCN carries which business — and a CMS file is the same for Part D.
   *
   * It is also the only source that can say "commercial" usefully. A commercial entry classifies
   * nothing, because the sheet does not say whether the employer bought insurance or funds its own
   * plan; what it does is replace "nothing on file says what BIN 610455 PCN BCBSKS is" with "this
   * is Blue Cross Blue Shield of Kansas commercial, and the only question left is this employer".
   * That is the difference between an afternoon and a quarter of an hour.
   */
  const sheet = payerSheetFor(e.bin, e.pcn);
  if (sheet) {
    const cls = LOB_CLASS[sheet.lineOfBusiness];
    const cited = `${sheet.publisher} names BIN ${sheet.bin} / PCN ${sheet.pcn || "(blank)"} as ${LOB_LABEL[sheet.lineOfBusiness]} — ${sheet.name}. ${sheet.quote}${sheet.caveat ? ` (${sheet.caveat})` : ""} [${sheet.url}]`;
    if (cls) return { classification: cls, source: "payer_sheet", confidence: "stated", from: cited, detail: LOB_LABEL[sheet.lineOfBusiness] };
    return { classification: null, why: cited };
  }

  for (const which of ["plan_file", "pharmacy"] as const) {
    const r = fromPioneer(rows, which, e.bin, e.pcn);
    if (isFinding(r)) return r;
    if (r.why) split.push(r.why);
  }

  // ── The claim's own routing ──
  if (has(e.pcn, MPPP_PCN)) {
    return {
      classification: "medicare",
      source: "pcn",
      confidence: "indicated",
      from:
        `The PCN "${e.pcn}" is a Medicare Prescription Payment Plan route. Under the Inflation Reduction Act a Part D ` +
        `beneficiary can elect to spread his cost sharing across the year, and the claim then bills on an MPPP PCN. It ` +
        `is the Part D plan itself on an instalment arrangement, not a copay card.`,
      detail: "Medicare Part D (Prescription Payment Plan)",
    };
  }
  // Medicaid before Medicare: a dual plan names both, and the narrower is the truth about who pays.
  if (has(e.pcn, MEDICAID_PCN)) {
    return { classification: "medicaid", source: "pcn", confidence: "indicated", from: `The PCN "${e.pcn}" names Medicaid on the claim itself.`, detail: null };
  }
  if (has(e.pcn, MEDICARE_PCN)) {
    return { classification: "medicare", source: "pcn", confidence: "indicated", from: `The PCN "${e.pcn}" names Medicare Part D on the claim itself.`, detail: "Medicare Part D" };
  }

  // ── The BIN listing, which is a published document rather than a name somebody typed ──
  const listing = namedKinds(lob);
  const listed = only(listing);
  if (listed && listed !== "commercial") {
    return { classification: KIND_CLASS[listed], source: "bin_listing", confidence: "indicated", from: `The BIN listing records this BIN's line of business as "${lob}".`, detail: null };
  }

  // ── The payer's own name, for the classes that cannot be anything else ──
  const named = namedKinds(allNames);
  const isNamed = only(named);
  if (isNamed === "medicaid") return { classification: "medicaid", source: "payer_name", confidence: "indicated", from: `The payer name "${allNames}" names Medicaid.`, detail: null };
  if (isNamed === "medicare") return { classification: "medicare", source: "payer_name", confidence: "indicated", from: `The payer name "${allNames}" names Medicare.`, detail: null };
  if (isNamed === "discount") return { classification: "discount_card", source: "payer_name", confidence: "indicated", from: `The payer name "${allNames}" is a discount card rather than insurance.`, detail: null };

  /*
   * A BIN carrying several lines of business, which is most of them.
   *
   * This is the finding that had to be unpicked. The listing for BIN 610455 reads "Commercial &
   * Extended Day / Medicare D & Extended Day / Medicare D Home Infusion / Commercial & Medicare D
   * Rural / Vaccines / Workers Compensation / Magellan Commercial" — seven networks under one BIN,
   * because that is what a BIN is. Matching "Medicare" anywhere in that string classified Blue
   * Cross Blue Shield of Kansas *commercial* as Medicare: 392 claims and $30,251.54 of this
   * pharmacy's September, filed under the wrong law, with a published document quoted next to it.
   * The same match made the Communications Workers of America plan on BIN 610011 Medicaid.
   *
   * The PCN is what selects a network out of a BIN. So a listing that names more than one kind
   * names none of them for this plan, and says how many it named — which is the sentence that
   * tells the owner the BIN listing was never going to answer this and the payer sheet is next.
   */
  if (listing.size > 1) {
    return {
      classification: null,
      why:
        (split.length ? `${split[0]} ` : "") +
        `The BIN listing names ${listing.size} different lines of business under BIN ${e.bin ?? "—"} — ${[...listing].map((k) => KIND_WORD[k]).join(", ")} — ` +
        `because a BIN carries many networks and the PCN is what selects one. ${e.pcn ? `Nothing on file says which of them PCN ${e.pcn} routes to` : "This plan has no PCN to select one"}, ` +
        `so the listing cannot classify this plan. The payer's own pharmacy payer sheet for this PCN is what settles it.`,
    };
  }

  /*
   * "Commercial" is where an answer would do harm, so it is refused loudly rather than skipped.
   *
   * A listing saying commercial does not say whether the employer bought insurance from a
   * state-regulated carrier or funded the plan itself under ERISA — and that distinction is the
   * whole reason the register exists. Both answers are commercial and only one is in reach.
   */
  if (listing.has("commercial") || named.has("commercial")) {
    return {
      classification: null,
      why:
        (split.length ? `${split[0]} ` : "") +
        `The listing says "${(lob ?? allNames).replace(/\s+/g, " ").slice(0, 120)}", which does not say whether the employer bought insurance ` +
        `or funds the plan itself. That is the difference between the Kansas floor applying and ERISA preempting it, so ` +
        `it needs a Form 5500 or the plan document rather than a guess.`,
    };
  }

  if (split.length) return { classification: null, why: split[0] };

  return {
    classification: null,
    why: e.bin
      ? `Nothing on file says what BIN ${e.bin}${e.pcn ? ` / PCN ${e.pcn}` : ""} carries. PioneerRx has no type for it, the BIN listing has no line of business, and the payer name does not identify itself.`
      : "This plan has no BIN, so there is nothing to look it up by.",
  };
}

/**
 * The classes this will ever propose.
 *
 * Exported so a test can assert the list has not quietly grown to include one that needs a
 * document. The guard is the point: adding "commercial_fully_insured" or "governmental" here would
 * turn a register of findings into a register of guesses, and every appeal built on it would
 * collapse.
 *
 * ── Why copay_card had to be added ──
 *
 * This list was written before the register had a `copay_card` class, and it was never revisited.
 * The result was a refusal with a false reason: `proposePlanClass` fell through to its guard and
 * told the owner that a manufacturer copay card "decides whether the Kansas floor reaches this plan
 * — so it needs the plan document or a Form 5500". It decides nothing of the sort. `needsBasis`
 * has never included copay_card, and `plans.ts` treats a card as self-evident precisely because
 * the payer on the claim names itself.
 *
 * It cost the largest single item on the register: BIN 019158 PCN CNRX, 28 claims and $35,476,
 * established outright by the manufacturer's own card documents, was silently unofferable. A list
 * of exceptions that is not revisited when the thing it excepts from grows is how a guard starts
 * blocking the work it was built to protect.
 */
export const PROPOSABLE: PlanClass[] = ["medicare", "medicaid", "workers_comp", "discount_card", "copay_card"];
