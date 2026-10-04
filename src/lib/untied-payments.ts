import { fmt } from "./dates";
import { claimsOfThisFill, verdictOnPrescription, type ClaimOnFile } from "./match-remittance";
import { formatCents } from "./money";

/*
 * Why a payment the site holds is tied to no claim, in words a person can act on. "Not yet matched" was one word for several
 * different situations and only one of them is a payment waiting for its claim; every screen that says anything about these
 * payments says it from here, so the words cannot drift apart. The cause is the matcher's own answer (match-remittance.ts
 * verdictOnPrescription, the one claim-payments.ts attaches by), not a second opinion of it.
 */

/** One payment the site holds that ties to no claim. It has no BIN: the site never stored one. */
export type UntiedPayment = {
  id: string;
  source: string;
  payer: string | null;
  receivedOn: string | null;
  amountCents: number;
  rxNumber: string;
  fillNumber: number | null;
  dateFilled: string | null;
  ndc11: string | null;
  reference: string | null;
};

/** From the causes that need a person to the ones that need nothing: the order every screen lists them in. */
export const CAUSES = ["fits_several", "reversed_sold", "no_claim_yet", "other_fills_only", "not_a_fill", "will_attach", "reversed_not_sold", "before_feed"] as const;
export type UntiedCause = (typeof CAUSES)[number];

/** What a cause asks of a person: a decision, a look, patience, or nothing. */
export type Needs = "decide" | "look" | "wait" | "nothing";

export type Classified = {
  cause: UntiedCause;
  /** The claims the cause is about: those the payment fits equally, the reversed ones for its fill, or, where none is for its fill, every claim the site holds for the prescription. */
  claimIds: string[];
};

/** A fill from before the claims feed begins: the site holds no claim for it and never will. */
export function isBeforeFeed(p: { dateFilled: string | null }, feedFrom: string | null): boolean {
  return feedFrom !== null && p.dateFilled !== null && p.dateFilled < feedFrom;
}

/**
 * `onFile` is every claim the site holds for the payment's prescription. `feedFrom` is the first day the claims feed covers
 * and `fromProgramme` whether the money is a voucher programme's, both put to the matcher exactly as attaching a payment puts them.
 */
export function classifyUntied(p: UntiedPayment, onFile: ClaimOnFile[], feedFrom: string | null, fromProgramme: boolean): Classified {
  if (isBeforeFeed(p, feedFrom)) return { cause: "before_feed", claimIds: [] };
  const line = { fillNumber: p.fillNumber, dateFilled: p.dateFilled, ndc11: p.ndc11, amountCents: p.amountCents, bin: null, fromProgramme };
  const v = verdictOnPrescription(onFile, line);
  if (v.kind === "tied") return { cause: "will_attach", claimIds: [v.claim.id] };
  if (v.kind === "no_claim_on_file") return { cause: p.ndc11 === null && p.fillNumber === null ? "not_a_fill" : "no_claim_yet", claimIds: [] };
  if (v.kind === "ambiguous") return { cause: "fits_several", claimIds: claimsOfThisFill(onFile.filter((c) => c.status === "paid"), line).map((c) => c.id) };
  const fill = v.kind === "only_reversed" ? v.fill : v.reversedFill;
  if (fill.length === 0) return { cause: "other_fills_only", claimIds: onFile.map((c) => c.id) };
  return { cause: fill.some((c) => c.soldOn) ? "reversed_sold" : "reversed_not_sold", claimIds: fill.map((c) => c.id) };
}

export type TallyRow = { cause: UntiedCause; count: number; cents: number };

/** Only the causes that have a payment, in the order of CAUSES. */
export function tallyUntied(list: { cause: UntiedCause; amountCents: number }[]): TallyRow[] {
  const by = new Map<UntiedCause, TallyRow>();
  for (const x of list) {
    const row = by.get(x.cause) ?? { cause: x.cause, count: 0, cents: 0 };
    row.count++;
    row.cents += x.amountCents;
    by.set(x.cause, row);
  }
  return CAUSES.flatMap((c) => by.get(c) ?? []);
}

export type CauseInfo = {
  label: string;
  needs: Needs;
  /** What a person has to do, or need not. */
  asks: string;
  /** The group as it reads after a count inside a sentence: for one payment, for several. */
  short: [string, string];
  /** What the group is and why the site did not tie it: the "Why" behind the group. */
  why: string;
};

const NEEDS_SAYS: Record<Needs, string> = { decide: "Needs you", look: "Worth a look", wait: "Clears by itself", nothing: "Nothing to do" };
export const needsSays = (n: Needs): string => NEEDS_SAYS[n];

/** `feedFrom` is the first day the claims feed covers, or null where no claims have been loaded at all. */
export function causeInfo(cause: UntiedCause, feedFrom: string | null): CauseInfo {
  const from = feedFrom ? fmt(feedFrom) : "the first day of the claims feed";
  switch (cause) {
    case "fits_several":
      return {
        label: "Fit two or more claims",
        needs: "decide",
        asks: "Attach each to the claim it paid. The site has no way to do that by hand yet.",
        short: ["that fits two or more claims equally", "that fit two or more claims equally"],
        why:
          "The fill was billed to more than one payer, so two or more claims fit this payment equally. The site keeps no payer BIN on a payment, and neither a manufacturer voucher nor the amount " +
          "singles one claim out, so it will not guess: a payment attached to the wrong claim makes two claims wrong at once. Until it is attached, the claims it could settle can still show as owed.",
      };
    case "reversed_sold":
      return {
        label: "On reversed claims, one with a sale date",
        needs: "decide",
        asks: "Say which: picked up and kept, or the sale undone.",
        short: ["on claims that were reversed, one carrying a sale date", "on claims that were reversed, one carrying a sale date"],
        why:
          "Every claim the site holds for this fill was reversed, yet one of them carries a sale date. If it was picked up and kept, the fill should have been billed again; " +
          "if the sale was undone, the payer can be expected to take back what it paid. The site cannot tell which, so it leaves the payment on no claim.",
      };
    case "no_claim_yet":
      return {
        label: "No claim for the prescription on file",
        needs: "look",
        asks: "Find out why no claim is on file. Nothing to press: the payment attaches itself if one arrives.",
        short: ["for a prescription with no claim on file", "for prescriptions with no claim on file"],
        why:
          `The fill is on or after ${from}, the first day of the claims feed, yet the site holds no claim for this prescription. Either its claim has not arrived or it was never in the feed. ` +
          "If a claim for it is loaded, the payment attaches by itself.",
      };
    case "other_fills_only":
      return {
        label: "Claims for other fills of the prescription, none for this one",
        needs: "look",
        asks: "Compare the fill on the line with the claims listed beside it.",
        short: ["for a fill the site holds no claim for, though it holds claims for others of the prescription", "for fills the site holds no claim for, though it holds claims for others of the prescriptions"],
        why: "The site holds claims for this prescription, but none for the fill this payment names. The payment may carry a fill date or a drug the claim does not, or this fill's claim never reached the site.",
      };
    case "not_a_fill":
      return {
        label: "Name no drug and no fill",
        needs: "look",
        asks: "Find out what the payer itemised it against.",
        short: ["that names no drug and no fill", "that name no drug and no fill"],
        why:
          "The line carries neither a drug nor a fill number, so there is no prescription behind it to find. It is money the payer itemised against something else: an administration fee, " +
          "an incentive, a programme payment. What it is decides whether it is revenue and where, and the figures cannot say.",
      };
    case "will_attach":
      return {
        label: "Their claim is on file now",
        needs: "wait",
        asks: "Nothing. It attaches by itself at the next claims load.",
        short: ["whose claim is on file now", "whose claims are on file now"],
        why: "A claim this payment fits is on file now. Payments are matched to claims each time claims are loaded, so it attaches at the next load.",
      };
    case "reversed_not_sold":
      return {
        label: "On reversed claims, none with a sale date",
        needs: "nothing",
        asks: "Nothing now. The money is in the bank and the payer can be expected to take it back.",
        short: ["on claims that were reversed, none carrying a sale date", "on claims that were reversed, none carrying a sale date"],
        why:
          "Every claim the site holds for this fill was reversed, and none carries a sale date. A payer that paid a claim nobody collected can be expected to take the money back, " +
          "usually on a later remittance as a negative line. The cash account's note on money banked for prescriptions nobody collected is this situation.",
      };
    case "before_feed":
      return {
        label: `For fills from before ${from}`,
        needs: "nothing",
        asks: "Nothing.",
        short: [`for a fill from before the claims feed begins on ${from}`, `for fills from before the claims feed begins on ${from}`],
        why: `The claims feed begins on ${from}, so the site holds no claim for a fill from before then and none is to be loaded. Nothing is owed on these from here. They are counted by who paid and not listed line by line.`,
      };
  }
}

const money = (c: number): string => formatCents(c);
const count = (n: number): string => n.toLocaleString("en-US");
const payments = (n: number): string => `${count(n)} payment${n === 1 ? "" : "s"}`;
const are = (n: number): string => (n === 1 ? "is" : "are");
/** A sum beside its count: "net" where there is more than one payment, because a take-back is a payment of less than nothing. */
const sum = (n: number, cents: number): string => `${n === 1 ? "" : "net "}${money(cents)}`;

/**
 * Everything tied to no claim, every figure beside what it is, so the sentence reads without the page behind it. The payments
 * that can matter come first and the fills from before the claims feed after, because they are nearly all of the count and
 * nothing is to be done about them. `booksFrom` is the day money received counts from.
 */
export function untiedHeadline(rows: TallyRow[], booksFrom: string, feedFrom: string | null): string {
  const tot = (rs: TallyRow[]) => rs.reduce((t, r) => ({ n: t.n + r.count, cents: t.cents + r.cents }), { n: 0, cents: 0 });
  const inFeed = rows.filter((r) => r.cause !== "before_feed");
  const before = rows.find((r) => r.cause === "before_feed");
  const part = (r: TallyRow): string => `${payments(r.count)} (${sum(r.count, r.cents)}) ${causeInfo(r.cause, feedFrom).short[r.count === 1 ? 0 : 1]}`;
  const since = fmt(booksFrom);
  if (inFeed.length === 0 && !before) return `Every payment received since ${since} is tied to a claim.`;
  const first = inFeed.length === 0
    ? `Not counting fills from before the claims feed, every payment received since ${since} is tied to a claim.`
    : `Not counting fills from before the claims feed, ${payments(tot(inFeed).n)} received since ${since} (${sum(tot(inFeed).n, tot(inFeed).cents)}) ${are(tot(inFeed).n)} tied to no claim: ${inFeed.map(part).join("; ")}.`;
  if (!before) return first;
  const one = before.count === 1;
  return `${first} A further ${payments(before.count)} (${sum(before.count, before.cents)}) ${are(before.count)} for ${one ? "a fill" : "fills"} from before the claims feed begins on ${fmt(feedFrom ?? booksFrom)}; the site holds no claim for ${one ? "that" : "those"} and none is to be loaded.`;
}
