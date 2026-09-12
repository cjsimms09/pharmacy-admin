/**
 * Which claims can be appealed, to whom, and by when.
 *
 * The owner: *"if there is appeals to be done for last 10 days it should pop up and I should hit
 * button, login and rest should do itsself. it also should record once filed so that it doesnt
 * duplicate request or alerts"*.
 *
 * This is the deciding half — pure, so every rule can be tested. `appeal-queue.ts` answers a
 * different question and answers it more strictly: it works out what a claim *should* have been paid
 * from a contracted rate schedule, and returns nothing at all when no rate row covers the claim.
 * On this pharmacy's data that is 1,960 claims and an empty queue.
 *
 * A MAC appeal does not need the contracted rate. Every PBM form asks the same thing: what the drug
 * cost, and what was paid. The argument is "you paid me less than I paid my wholesaler", and the
 * evidence is the invoice. So the test here is the one the forms actually apply.
 *
 * ── The four gates, in the order they matter ──
 *
 * 1. **May we file at all?** Several agreements say the PSAO files and the pharmacy does not —
 *    Blue Eagle, Argus, MC-Rx, PDMI — and for Express Scripts the PSAO already sends a weekly
 *    below-cost list. Filing there is wasted work at best and a duplicate at worst.
 * 2. **Is it the kind of claim MAC applies to?** A MAC list prices generics. A brand paid below cost
 *    is a buying problem or a contract problem, not a MAC appeal, and the first version of this
 *    returned a list that was almost entirely Wegovy and Zepbound.
 * 3. **Has it been appealed already?** Once filed, never again — the owner's rule, and a PBM that
 *    receives the same claim twice learns to ignore this pharmacy's appeals.
 * 4. **Is it still in time?** Caremark allows ten calendar days from the claim. That window closes
 *    weeks before the remittance that would reveal the underpayment ever arrives, which is why this
 *    runs off the daily claims feed and not off 835s.
 */

/** What a claim has to carry to be judged. */
export type Candidate = {
  claimId: string;
  rxNumber: string;
  fillNumber: number | null;
  dateFilled: string;
  ndc11: string;
  drugName: string | null;
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  pbmName: string;
  /** What the plan paid for the ingredient and fee. */
  paidCents: number;
  /** What the drug cost, from the invoice. Null where no invoice covers the NDC. */
  acquisitionCents: number | null;
  quantityThousandths: number | null;
  daysSupply: number | null;
  /** From NADAC: "G" generic, "B" brand, null where the NDC is not priced there. */
  classification: string | null;
  /**
   * NCPDP Basis of Reimbursement Determination (field 522-FM), as the plan returned it.
   *
   * How the plan says it priced this claim, in its own adjudication response. It is the difference
   * between a MAC appeal and a wasted one — see `MAC_BASES`. Null where the claim does not carry it.
   */
  basisOfReimbursement: string | null;
  /**
   * The NADAC per dispensing unit in force on the fill date, in cents. Null where NADAC has none.
   *
   * The independent check on the basis code. The basis code is the plan *saying* it used a MAC; this
   * is what the money actually did. The owner asked for it in so many words: "is there a way to
   * verify it is a mac claim and not nadac before submitting".
   */
  nadacPerUnitCents: number | null;
};

/**
 * The bases that mean a MAC list set the price, and therefore that there is a MAC to appeal.
 *
 * ── Why this gate exists ──
 *
 * Caremark rejected the first appeal this pharmacy filed as a "non MAC claim", and it was right to.
 * Rx 333968, amphetamine ER 12.5mg ODT, came back with basis **03** — ingredient cost reduced to
 * AWP less a percentage. No MAC list priced it, so there was no MAC to appeal and nothing the form
 * could have said would have changed that.
 *
 * Every gate before this one asked whether the claim *lost money* and whether the pharmacy *may*
 * file. None of them asked the prior question: did a MAC price this claim at all. The plan answers
 * that on the claim itself, in field 522-FM, and the site has been storing it all along without
 * reading it.
 *
 * ── Why only 06 and 07 ──
 *
 * These two are the MAC bases in the NCPDP list: 06 is MAC pricing with the ingredient cost paid as
 * the MAC, 07 is ingredient cost reduced to the MAC. Everything else names a different benchmark —
 * 03 is AWP less a discount, 13 is WAC, 09 is acquisition cost, 08 is contract pricing — and an
 * appeal against a MAC list that did not price the claim is refused on sight.
 *
 * Codes not on this list are treated as not-MAC rather than unknown, deliberately. The cost of
 * skipping a real MAC claim is one appeal not filed, worth a few dollars; the cost of filing
 * against a non-MAC claim is a rejection on the pharmacy's record with a PBM it has to keep filing
 * with, and enough of those is how a pharmacy's appeals stop being read.
 */
const MAC_BASES = new Set(["06", "07"]);

/**
 * What the plan said it priced off, for the sentence that explains a refusal.
 *
 * Only the codes actually seen on this pharmacy's claims are named. An unrecognised code is quoted
 * back rather than guessed at: inventing a meaning for it would be the same fault as the appeal
 * this gate prevents.
 */
const BASIS_MEANS: Record<string, string> = {
  "00": "no basis specified",
  "01": "the ingredient cost paid as submitted",
  "02": "ingredient cost reduced to AWP",
  "03": "ingredient cost reduced to AWP less a percentage",
  "04": "usual and customary, paid as submitted",
  "05": "the lower of ingredient cost plus fees and usual and customary",
  "08": "contract pricing",
  "09": "acquisition cost pricing",
  "13": "wholesale acquisition cost (WAC)",
  "14": "another payer's patient-responsibility amount",
  "15": "the patient pay amount",
  "16": "a coupon payment",
};

/** The code as the NCPDP list writes it: two digits, so "6" and "06" are one basis. */
function basisCode(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (t === "") return null;
  return /^\d$/.test(t) ? `0${t}` : t;
}

/** The rules for one PBM, as transcribed from its agreement. */
export type PayerTerms = {
  pbmName: string;
  /** "pharmacy", "either", "psao", "none", or null where the agreement was never read. */
  whoFiles: string | null;
  appealWindowDays: number | null;
  windowBasis: string | null;
  channel: string | null;
  target: string | null;
};

export type Verdict =
  | "appeal"
  /** Nothing is wrong with it. */
  | "paid_enough"
  /** A brand, or an NDC NADAC does not classify. MAC does not price it. */
  | "not_generic"
  /**
   * The plan priced this claim off something other than a MAC list, so there is no MAC to appeal.
   *
   * The claim says which, and this is the gate that was missing. See `MAC_BASES` below.
   */
  | "not_mac_priced"
  /**
   * Paid at NADAC, so the plan priced it off the national average and there is no MAC to argue with.
   *
   * The second half of the owner's question — "is there a way to verify it is a mac claim and not
   * nadac before submitting". A basis code of 06 or 07 is the plan saying it used a MAC; this is
   * what the money says. Where the two disagree, the money wins.
   */
  | "paid_at_nadac"
  /** No invoice covers the NDC, so there is nothing to evidence the appeal with. */
  | "no_invoice"
  /** Paid nothing at all — a deductible claim, not an underpayment. */
  | "paid_nothing"
  /** The agreement routes this payer's appeals through the PSAO. */
  | "psao_files"
  /** The agreement gives no MAC appeal process. */
  | "no_route"
  /** No agreement has been read for this payer. */
  | "payer_unknown"
  /** Already appealed. */
  | "already_filed"
  /** Out of time. */
  | "too_late";

export type Judged = {
  candidate: Candidate;
  verdict: Verdict;
  /** Acquisition less paid, where both are known and paid is the smaller. */
  shortfallCents: number;
  /** The last day this can be filed, where the window is known. */
  deadline: string | null;
  /** Days left, negative once past. Null where no window is on file. */
  daysLeft: number | null;
  /**
   * Appealable, but on the weaker argument: paid above NADAC and still under cost.
   *
   * Lets a worklist put the winnable ones first. False on everything that is not an `appeal`.
   */
  aboveNadac?: boolean;
  /** One sentence, in the owner's terms, for whichever screen shows it. */
  says: string;
};

const day = 86_400_000;
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * day).toISOString().slice(0, 10);
const between = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / day);
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

/**
 * When the clock starts.
 *
 * Only the fill date is known for certain on every claim, and the bases the contracts name —
 * "initial claim", "adjudication", "date of service" — all fall on or within a day of it for a
 * retail fill. Where a contract says something else entirely the window stays null rather than being
 * computed from a date that does not mean what the contract meant.
 */
const STARTS_AT_FILL = new Set(["initial_claim", "adjudication", "date_of_service", "date_of_fill"]);

/**
 * Judge one claim.
 *
 * The gates are applied in the order above, and the first one that answers wins — so a brand drug
 * from a payer whose agreement was never read reports as "not a generic" rather than as an unknown
 * payer. That ordering is deliberate: it names the reason the owner can act on.
 */
export function judge(c: Candidate, terms: PayerTerms | null, alreadyFiled: Set<string>, today: string): Judged {
  const base = { candidate: c, shortfallCents: 0, deadline: null as string | null, daysLeft: null as number | null };

  if (alreadyFiled.has(c.claimId)) {
    return { ...base, verdict: "already_filed", says: "Already appealed. It will not be sent again." };
  }

  if ((c.classification ?? "").toUpperCase() !== "G") {
    return {
      ...base,
      verdict: "not_generic",
      says:
        c.classification === null
          ? "NADAC does not price this NDC, so there is no way to tell whether a MAC list covers it."
          : "A brand. MAC lists price generics, so a brand paid below cost is a contract or buying question, not a MAC appeal.",
    };
  }

  /*
   * Did a MAC list price this claim at all. The plan says so on the claim, and it is the first
   * question a PBM asks of an appeal — Caremark's answer on the one filed without this gate was
   * "non MAC claim".
   */
  const basis = basisCode(c.basisOfReimbursement);
  if (basis === null || !MAC_BASES.has(basis)) {
    return {
      ...base,
      verdict: "not_mac_priced",
      says:
        basis === null
          ? "The claim does not say how the plan priced it, and an appeal needs a MAC to appeal against. Without basis of reimbursement 06 or 07 there is no way to tell a MAC underpayment from a drug bought badly."
          : `The plan priced this off ${BASIS_MEANS[basis] ?? `basis of reimbursement ${basis}`}, not off a MAC list (which would be 06 or 07). There is no MAC to appeal, and a PBM refuses these as a non-MAC claim.`,
    };
  }

  /*
   * And what the money did, which is the check the basis code cannot give.
   *
   * A plan can return 06 or 07 and still have priced the claim off the national average: NADAC is
   * what a great many MAC lists are built from, and where the paid amount lands on NADAC there is no
   * MAC sitting below it to argue about. Appealing one of those asks Caremark to reprice at NADAC a
   * claim it already paid at NADAC, which is a form filled in to ask for nothing.
   *
   * Three percent either way, not an exact match: NADAC is published weekly and a plan pricing off
   * the previous week's file lands near the figure rather than on it. Tighter and this would miss
   * them; looser and it would start catching real underpayments.
   *
   * Only the at-NADAC case is refused here. Paid *above* NADAC is a different thing and is allowed
   * through with the fact recorded, because whether to file it is a judgement about the argument
   * rather than about the claim — see the note on `aboveNadac` where the appeal is offered.
   */
  const perUnitPaid = (c.quantityThousandths ?? 0) > 0 ? c.paidCents / ((c.quantityThousandths ?? 0) / 1000) : null;
  if (perUnitPaid !== null && c.nadacPerUnitCents !== null && c.nadacPerUnitCents > 0) {
    const ratio = perUnitPaid / c.nadacPerUnitCents;
    if (ratio > 0.97 && ratio < 1.03) {
      return {
        ...base,
        verdict: "paid_at_nadac",
        says:
          `Paid ${money(Math.round(perUnitPaid))} per unit against a NADAC of ${money(Math.round(c.nadacPerUnitCents))} — ` +
          `the plan priced this off the national average, not off a MAC list below it. There is nothing to reprice, ` +
          `whatever the basis code says. If this is short it is short because the drug cost more than the national ` +
          `average, which is a buying question.`,
      };
    }
  }

  if (c.paidCents <= 0) {
    return {
      ...base,
      verdict: "paid_nothing",
      says: "The plan paid nothing on this claim — usually a deductible the patient covered in full, which is not an underpayment.",
    };
  }

  if (c.acquisitionCents === null) {
    return {
      ...base,
      verdict: "no_invoice",
      says: "No invoice on file covers this NDC, and every PBM form asks for the acquisition cost with the invoice behind it.",
    };
  }

  const shortfallCents = c.acquisitionCents - c.paidCents;
  if (shortfallCents <= 0) {
    return { ...base, verdict: "paid_enough", says: `Paid ${money(c.paidCents)} against a cost of ${money(c.acquisitionCents)}. Nothing to appeal.` };
  }

  /*
   * ── How good the argument is, which is not the same as whether it may be filed ──
   *
   * A claim paid *below* NADAC is the strong case and needs no arguing: the MAC was set under the
   * national average acquisition cost, a published federal figure, and the appeal is arithmetic.
   *
   * A claim paid *above* NADAC but still under what this pharmacy paid is a different argument
   * altogether. It asks the PBM to pay more than the national average because this pharmacy's
   * buying is expensive, and a PBM declines that — rightly. It is the buying gap in
   * docs/MONEY-TRACE.md, where eleven days of it came to $2,582.56, and no MAC appeal can fix it.
   *
   * Filed anyway rather than refused, because the owner may still want it: the ask on the form is
   * then "reprice above NADAC" on cost plus a dispensing fee, which is honest and sometimes paid.
   * But never silently, because verification codes spent on these are codes spent on declines.
   *
   * Computed here, above the payer checks, so it reaches both ways out of this function that end in
   * an appeal. It used to sit beside the second one, which left every payer naming no filing
   * deadline — and several of the twenty name none — with the flag unset and the caveat missing.
   */
  const aboveNadac =
    perUnitPaid !== null && c.nadacPerUnitCents !== null && c.nadacPerUnitCents > 0 && perUnitPaid / c.nadacPerUnitCents >= 1.03;
  const weak = aboveNadac
    ? ` Paid ${money(Math.round(perUnitPaid!))} a unit against a NADAC of ${money(Math.round(c.nadacPerUnitCents!))}, so this asks ${c.pbmName} to beat the national average on a drug bought above it — a buying gap rather than a MAC underpayment, and the weaker of the two arguments.`
    : "";

  if (!terms || !terms.whoFiles) {
    return {
      ...base,
      shortfallCents,
      verdict: "payer_unknown",
      says: `${money(shortfallCents)} below cost, but no agreement has been read for ${c.pbmName} — so there is no knowing where an appeal goes or how long there is to file it.`,
    };
  }

  if (terms.whoFiles === "psao") {
    return {
      ...base,
      shortfallCents,
      verdict: "psao_files",
      says: `${money(shortfallCents)} below cost. ${c.pbmName}'s agreement routes MAC appeals through the PSAO rather than the pharmacy, so this one is for AccessHealth to raise.`,
    };
  }

  if (terms.whoFiles === "none") {
    return {
      ...base,
      shortfallCents,
      verdict: "no_route",
      says: `${money(shortfallCents)} below cost, and ${c.pbmName}'s agreement sets out no MAC appeal process at all.`,
    };
  }

  /*
   * The window. Unknown is not the same as expired: a payer whose agreement names no deadline is
   * still worth appealing, and reporting it as too late would quietly drop money.
   */
  if (terms.appealWindowDays === null || !STARTS_AT_FILL.has(terms.windowBasis ?? "")) {
    return {
      ...base,
      shortfallCents,
      verdict: "appeal",
      aboveNadac,
      says: `${money(shortfallCents)} below cost. ${c.pbmName} names no filing deadline, so there is no clock — but no reason to wait either.${weak}`,
    };
  }

  const deadline = addDays(c.dateFilled, terms.appealWindowDays);
  const daysLeft = between(today, deadline);
  if (daysLeft < 0) {
    return {
      ...base,
      shortfallCents,
      deadline,
      daysLeft,
      verdict: "too_late",
      says: `${money(shortfallCents)} below cost, but ${c.pbmName} allows ${terms.appealWindowDays} days from the fill and that ran out on ${deadline}.`,
    };
  }

  return {
    ...base,
    shortfallCents,
    deadline,
    daysLeft,
    verdict: "appeal",
    aboveNadac,
    says:
      (daysLeft === 0
        ? `${money(shortfallCents)} below cost, and today is the last day ${c.pbmName} will take it.`
        : `${money(shortfallCents)} below cost. ${daysLeft} day${daysLeft === 1 ? "" : "s"} left to file with ${c.pbmName}.`) + weak,
  };
}

export type Batch = {
  pbmName: string;
  channel: string | null;
  target: string | null;
  claims: Judged[];
  shortfallCents: number;
  /** The soonest deadline in the batch: what the alert counts down to. */
  nextDeadline: string | null;
  daysLeft: number | null;
  says: string;
};

export type Worklist = {
  /** What can be filed, grouped by who it goes to, most urgent first. */
  batches: Batch[];
  totalCents: number;
  totalClaims: number;
  /** Everything not appealable, counted by why. So a screen can say what is being left alone. */
  setAside: { verdict: Verdict; claims: number; cents: number; says: string }[];
  /** The headline, for the alert. */
  says: string;
};

/**
 * Build the worklist.
 *
 * Batched by PBM because that is how they are filed — one visit to one portal settles all of that
 * payer's claims — and ordered by urgency rather than by money, since a large batch with three weeks
 * left can wait behind a small one expiring tonight.
 */
export function worklist(
  candidates: Candidate[],
  terms: PayerTerms[],
  alreadyFiled: Set<string>,
  today: string,
): Worklist {
  const fold = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const byName = new Map(terms.map((t) => [fold(t.pbmName), t]));
  const termsFor = (name: string) => byName.get(fold(name)) ?? null;

  const judged = candidates.map((c) => judge(c, termsFor(c.pbmName), alreadyFiled, today));

  const groups = new Map<string, Judged[]>();
  for (const j of judged.filter((x) => x.verdict === "appeal")) {
    const k = j.candidate.pbmName;
    groups.set(k, [...(groups.get(k) ?? []), j]);
  }

  const batches: Batch[] = [...groups.entries()].map(([pbmName, claims]) => {
    const t = termsFor(pbmName);
    const shortfallCents = claims.reduce((n, j) => n + j.shortfallCents, 0);
    const deadlines = claims.map((j) => j.deadline).filter((d): d is string => d !== null).sort();
    const nextDeadline = deadlines[0] ?? null;
    const daysLeft = nextDeadline === null ? null : between(today, nextDeadline);
    return {
      pbmName,
      channel: t?.channel ?? null,
      target: t?.target ?? null,
      claims: claims.sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999")),
      shortfallCents,
      nextDeadline,
      daysLeft,
      says:
        daysLeft === null
          ? `${claims.length} claim${claims.length === 1 ? "" : "s"} worth ${money(shortfallCents)}. No filing deadline is on file for ${pbmName}.`
          : daysLeft <= 0
            ? `${claims.length} claim${claims.length === 1 ? "" : "s"} worth ${money(shortfallCents)}, and the oldest must go to ${pbmName} today.`
            : `${claims.length} claim${claims.length === 1 ? "" : "s"} worth ${money(shortfallCents)}. The oldest has ${daysLeft} day${daysLeft === 1 ? "" : "s"} left.`,
    };
  });

  /* Soonest deadline first; a batch with no clock sorts last, because nothing is lost by waiting. */
  batches.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999) || b.shortfallCents - a.shortfallCents);

  const aside = new Map<Verdict, { claims: number; cents: number; says: string }>();
  for (const j of judged.filter((x) => x.verdict !== "appeal")) {
    const e = aside.get(j.verdict) ?? { claims: 0, cents: 0, says: j.says };
    e.claims++;
    e.cents += j.shortfallCents;
    aside.set(j.verdict, e);
  }

  const totalCents = batches.reduce((n, b) => n + b.shortfallCents, 0);
  const totalClaims = batches.reduce((n, b) => n + b.claims.length, 0);
  const soonest = batches.find((b) => b.daysLeft !== null);

  return {
    batches,
    totalCents,
    totalClaims,
    setAside: [...aside.entries()].map(([verdict, e]) => ({ verdict, ...e })),
    says:
      totalClaims === 0
        ? "No MAC appeals to file."
        : `${totalClaims} claim${totalClaims === 1 ? "" : "s"} worth ${money(totalCents)} can be appealed` +
          (soonest && soonest.daysLeft !== null
            ? soonest.daysLeft <= 0
              ? `, and ${soonest.pbmName}'s oldest must go today.`
              : `. The soonest deadline is ${soonest.daysLeft} day${soonest.daysLeft === 1 ? "" : "s"} away, with ${soonest.pbmName}.`
            : "."),
  };
}
