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
};

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
      says: `${money(shortfallCents)} below cost. ${c.pbmName} names no filing deadline, so there is no clock — but no reason to wait either.`,
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
    says:
      daysLeft === 0
        ? `${money(shortfallCents)} below cost, and today is the last day ${c.pbmName} will take it.`
        : `${money(shortfallCents)} below cost. ${daysLeft} day${daysLeft === 1 ? "" : "s"} left to file with ${c.pbmName}.`,
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
