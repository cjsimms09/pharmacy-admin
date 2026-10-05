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
export const CAUSES = ["fits_several", "reversed_sold", "no_claim_yet", "other_fills_only", "not_a_fill", "will_attach", "reversed_not_sold", "cancels_out", "before_feed"] as const;
export type UntiedCause = (typeof CAUSES)[number];

/** What a cause asks of a person: a decision, a look, patience, or nothing. */
export type Needs = "decide" | "look" | "wait" | "nothing";

export type Classified = {
  cause: UntiedCause;
  /** The claims the cause is about: those the payment fits equally, the reversed ones for its fill, or, where none is for its fill, every claim the site holds for the prescription. */
  claimIds: string[];
};

/**
 * A fill from before the claims feed begins. The site holds a claim for it only if one came in a later report, which the matcher's answer on
 * the prescription says. The owner, asking that the site stop looking for these: "can we have it stop alerting if looking for a claim before
 * 09/01?? this system will never get anything before 09/01.."
 */
export function isBeforeFeed(p: { dateFilled: string | null }, feedFrom: string | null): boolean {
  return feedFrom !== null && p.dateFilled !== null && p.dateFilled < feedFrom;
}

/**
 * `onFile` is every claim the site holds for the payment's prescription. `feedFrom` is the first day the claims feed covers
 * and `fromProgramme` whether the money is a voucher programme's, both put to the matcher exactly as attaching a payment puts them.
 */
export function classifyUntied(p: UntiedPayment, onFile: ClaimOnFile[], feedFrom: string | null, fromProgramme: boolean): Classified {
  const line = { fillNumber: p.fillNumber, dateFilled: p.dateFilled, ndc11: p.ndc11, amountCents: p.amountCents, bin: null, fromProgramme };
  const v = verdictOnPrescription(onFile, line);
  /*
   * A fill from before the feed is a group of its own only where the site holds no claim for that fill. A claim for one can come
   * in a later daily report (a script filled in August and collected in September), and then the payment is read by that claim
   * like any other: 40 of 3,637 were, $3,700.92, measured 4 October 2026.
   */
  const early = isBeforeFeed(p, feedFrom);
  if (v.kind === "tied") return { cause: "will_attach", claimIds: [v.claim.id] };
  if (v.kind === "ambiguous") return { cause: "fits_several", claimIds: claimsOfThisFill(onFile.filter((c) => c.status === "paid"), line).map((c) => c.id) };
  if (v.kind === "no_claim_on_file") return { cause: early ? "before_feed" : p.ndc11 === null && p.fillNumber === null ? "not_a_fill" : "no_claim_yet", claimIds: [] };
  const fill = v.kind === "only_reversed" ? v.fill : v.reversedFill;
  if (fill.length === 0) return early ? { cause: "before_feed", claimIds: [] } : { cause: "other_fills_only", claimIds: onFile.map((c) => c.id) };
  return { cause: fill.some((c) => c.soldOn) ? "reversed_sold" : "reversed_not_sold", claimIds: fill.map((c) => c.id) };
}

/** The payment that cancels another, enough to name it beside the other. */
export type CancelPartner = Pick<UntiedPayment, "id" | "amountCents" | "receivedOn">;

type CancelCandidate = Pick<UntiedPayment, "id" | "source" | "payer" | "receivedOn" | "amountCents" | "rxNumber" | "fillNumber" | "dateFilled" | "ndc11"> & { cause: UntiedCause };

/*
 * The causes a payment can be cancelled out of: it is tied to no claim and it names a fill. One that will attach by itself, or is for a fill
 * from before the feed, or names no fill at all, is already said where it belongs.
 */
const CAN_CANCEL: UntiedCause[] = ["fits_several", "reversed_sold", "no_claim_yet", "other_fills_only", "reversed_not_sold"];

/**
 * Which payments cancel one another: a payment, and a take-back of exactly its amount, for one fill: the same prescription, fill number,
 * fill date and drug, from the same payer by the same source. The payer is where it started, so together they move no balance and nobody has
 * anything to decide about either. Each take-back cancels one payment, the oldest first: three payments and
 * one take-back of an amount leave two payments, not none. Returns the id of each paired payment mapped to its partner's.
 *
 * The site stores no BIN on a payment, so one plan's payment and take-back for a fill cannot be told from two plans' of the same amounts. The sums
 * are the same either way, and a payment tied to no claim is in no payer's balance.
 */
export function cancellingPairs(list: CancelCandidate[]): Map<string, string> {
  const buckets = new Map<string, { payments: CancelCandidate[]; takeBacks: CancelCandidate[] }>();
  for (const p of list) {
    if (!CAN_CANCEL.includes(p.cause) || (p.fillNumber === null && p.dateFilled === null)) continue;
    const key = JSON.stringify([p.rxNumber, p.fillNumber, p.dateFilled, p.ndc11, p.source, p.payer, Math.abs(p.amountCents)]);
    const b = buckets.get(key) ?? { payments: [], takeBacks: [] };
    (p.amountCents > 0 ? b.payments : b.takeBacks).push(p);
    buckets.set(key, b);
  }
  const oldest = (a: CancelCandidate, b: CancelCandidate) => (a.receivedOn ?? "").localeCompare(b.receivedOn ?? "") || a.id.localeCompare(b.id);
  const partner = new Map<string, string>();
  for (const { payments: paid, takeBacks } of buckets.values()) {
    paid.sort(oldest);
    takeBacks.sort(oldest);
    for (let i = 0; i < Math.min(paid.length, takeBacks.length); i++) {
      partner.set(paid[i].id, takeBacks[i].id);
      partner.set(takeBacks[i].id, paid[i].id);
    }
  }
  return partner;
}

/** What a line says of the payment that cancels it, so a person reads the pair without hunting for its other half. */
export function partnerSays(own: Pick<UntiedPayment, "amountCents">, partner: CancelPartner): string {
  const when = partner.receivedOn ? `received ${fmt(partner.receivedOn)}` : "with no received date";
  return own.amountCents < 0 ? `Takes back in full the ${formatCents(partner.amountCents)} ${when}.` : `Taken back in full: ${formatCents(partner.amountCents)} ${when}.`;
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

/** Where the money came from, in the site's own words; a source it has no words for is shown as it is stored. */
const SOURCE_SAYS: Record<string, string> = {
  plan: "Plan remittance",
  mtf: "Medicare Transaction Facilitator",
  copay_card: "Manufacturer copay or savings card",
  rxrescue: "RxRescue (Aytu / IPD) credit memo",
  dir: "DIR adjustment",
  secondary: "Secondary payer",
  manual: "Entered by hand",
};
export const sourceSays = (source: string): string => SOURCE_SAYS[source] ?? source;

/** What a payment names, each said as absent where it does not carry it: "no fill date" is a state, and a bare dash is not. */
export function namesSays(p: Pick<UntiedPayment, "fillNumber" | "dateFilled" | "ndc11">): string {
  return [p.fillNumber === null ? "no fill number" : `fill ${p.fillNumber}`, p.dateFilled ? fmt(p.dateFilled) : "no fill date", p.ndc11 ? `NDC ${p.ndc11}` : "no drug"].join(" · ");
}

/** A claim a payment is shown beside: enough to recognise it without opening it. */
export type ClaimBeside = {
  id: string;
  payerLabel: string | null;
  itemName: string | null;
  status: "paid" | "reversed";
  fillNumber: number | null;
  dateFilled: string;
  remitCents: number | null;
  soldOn: string | null;
};

/** The claim in words: who it was billed to, then everything else a person reads to tell it from its twin. */
export function claimBesideSays(c: ClaimBeside): { who: string; rest: string } {
  const state = c.status === "paid" ? "paid" : c.soldOn ? `reversed, sale date ${fmt(c.soldOn)}` : "reversed, no sale date";
  return {
    who: c.payerLabel ?? "no payer name",
    rest: [c.itemName ?? "no drug name", `${c.fillNumber === null ? "no fill number" : `fill ${c.fillNumber}`}, ${fmt(c.dateFilled)}`, state, c.remitCents === null ? "no amount on the claim" : `claim amount ${formatCents(c.remitCents)}`].join(" · "),
  };
}

export type NeedsRow = { needs: Needs; count: number; cents: number };
const NEEDS_ORDER: Needs[] = ["decide", "look", "wait", "nothing"];

/**
 * The tally by what each group asks of a person, from the ones that need a decision to the ones that need nothing. The payments for
 * fills from before the claims feed are not in it: the site holds no claim for those, and they are said apart wherever this is said.
 */
export function tallyByNeeds(rows: TallyRow[]): NeedsRow[] {
  const by = new Map<Needs, NeedsRow>();
  for (const r of rows) {
    if (r.cause === "before_feed") continue;
    const needs = causeInfo(r.cause, null).needs;
    const x = by.get(needs) ?? { needs, count: 0, cents: 0 };
    x.count += r.count;
    x.cents += r.cents;
    by.set(needs, x);
  }
  return NEEDS_ORDER.flatMap((n) => by.get(n) ?? []);
}

/** "33 need a decision, 12 are worth a look, 179 need nothing": the groups of a person's attention, said in a line. */
export function needsPhrase(rows: NeedsRow[]): string {
  const n = (c: number) => c.toLocaleString("en-US");
  const says: Record<Needs, (c: number) => string> = {
    decide: (c) => `${n(c)} ${c === 1 ? "needs" : "need"} a decision`,
    look: (c) => `${n(c)} ${c === 1 ? "is" : "are"} worth a look`,
    wait: (c) => `${n(c)} will attach at the next claims load`,
    nothing: (c) => `${n(c)} ${c === 1 ? "needs" : "need"} nothing`,
  };
  return rows.map((r) => says[r.needs](r.count)).join(", ");
}

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
          `Nothing puts the fill before ${feedFrom ? `${from}, the day the claims feed begins` : from}, yet the site holds no claim for this prescription. Either its claim has not arrived or it was never in the feed. ` +
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
    case "cancels_out":
      return {
        label: "Cancelled by a take-back of exactly its amount",
        needs: "nothing",
        asks: "Nothing. Together they change no balance.",
        short: ["that is cancelled by a payment of exactly the opposite amount for the same fill", "that are cancelled by payments of exactly the opposite amount for the same fill"],
        why:
          "A payment, and a take-back of exactly its amount, for the same fill: the same prescription, fill and drug, from the same payer by the same kind of remittance. The payer is where it started, " +
          "so there is nothing to attach and nothing to decide, and together they move no claim's balance. The site does not tie them to a claim they fit, " +
          "because a payment tied to a claim it merely resembles makes two claims wrong at once.",
      };
    case "before_feed":
      return {
        label: `Fills from before ${from} that the site holds no claim for`,
        needs: "nothing",
        asks: "Nothing.",
        short: [`for a fill from before the claims feed begins on ${from}, which the site holds no claim for`, `for fills from before the claims feed begins on ${from}, which the site holds no claim for`],
        why:
          `The claims feed begins on ${from}, and the site holds no claim for the fill each of these names, so there is no claim for the payment to settle. They are counted by who paid and not listed line by line. ` +
          `A payment for a fill from before ${from} that the site does hold a claim for is not here: it is under the reason that claim gives.`,
      };
  }
}

const money = (c: number): string => formatCents(c);
const count = (n: number): string => n.toLocaleString("en-US");
const payments = (n: number): string => `${count(n)} payment${n === 1 ? "" : "s"}`;
const are = (n: number): string => (n === 1 ? "is" : "are");
/** A sum beside its count: "net" where there is more than one payment, because a take-back is a payment of less than nothing. */
const sum = (n: number, cents: number): string => `${n === 1 ? "" : "net "}${money(cents)}`;

/** One group as a sentence has it: its count and sum, then what it is. Every screen words a group this way, so no two can say it differently. */
function groupPart(r: TallyRow, feedFrom: string | null): string {
  return `${payments(r.count)} (${sum(r.count, r.cents)}) ${causeInfo(r.cause, feedFrom).short[r.count === 1 ? 0 : 1]}`;
}

/** Every group of a tally in `groupPart`'s words, in the order of CAUSES, for a sentence that has to say them all. */
export function groupsSay(rows: TallyRow[], feedFrom: string | null): string {
  return [...rows].sort((a, b) => CAUSES.indexOf(a.cause) - CAUSES.indexOf(b.cause)).map((r) => groupPart(r, feedFrom)).join("; ");
}

/**
 * Everything tied to no claim, every figure beside what it is, so the sentence reads without the page behind it. The payments
 * that can matter come first and the fills from before the claims feed that the site holds no claim for after, because they
 * are nearly all of the count and there is nothing to be done about them. `booksFrom` is the day money received counts from.
 */
export function untiedHeadline(rows: TallyRow[], booksFrom: string, feedFrom: string | null): string {
  const tot = (rs: TallyRow[]) => rs.reduce((t, r) => ({ n: t.n + r.count, cents: t.cents + r.cents }), { n: 0, cents: 0 });
  const rest = rows.filter((r) => r.cause !== "before_feed");
  const early = rows.find((r) => r.cause === "before_feed");
  const part = (r: TallyRow): string => groupPart(r, feedFrom);
  const since = fmt(booksFrom);
  if (rest.length === 0 && !early) return `Every payment received since ${since} is tied to a claim.`;
  const unheld = early ? `${payments(early.count)} (${sum(early.count, early.cents)})` : "";
  const fills = early ? `${early.count === 1 ? "a fill" : "fills"} from before the claims feed begins on ${fmt(feedFrom ?? booksFrom)}, which the site holds no claim for` : "";
  if (rest.length === 0) return `Every payment received since ${since} is tied to a claim, except ${unheld} for ${fills}.`;
  const t = tot(rest);
  const first = `${payments(t.n)} received since ${since} (${sum(t.n, t.cents)}) ${are(t.n)} tied to no claim: ${rest.map(part).join("; ")}.`;
  return early ? `${first} A further ${unheld} ${are(early.count)} for ${fills}.` : first;
}

/** The line the Claims page shows for these payments, beside its page. */
export type CardRow = { tone: "ok" | "warn"; amount: string; title: string; why: string };

/**
 * What a person reads on the Claims page about the payments tied to no claim: the money, what each group of it asks of him, and the
 * fills from before the claims feed said in the same sentence, because they are nearly all of the count. Null where every payment is tied.
 */
export function untiedCardRow(rows: TallyRow[], booksFrom: string, feedFrom: string | null): CardRow | null {
  if (rows.length === 0) return null;
  const groups = tallyByNeeds(rows);
  const early = rows.find((r) => r.cause === "before_feed");
  const since = fmt(booksFrom);
  const why = untiedHeadline(rows, booksFrom, feedFrom);
  if (groups.length === 0 && early) {
    return {
      tone: "ok",
      amount: sum(early.count, early.cents),
      title: `is tied to no claim — ${payments(early.count)} received since ${since}, all for ${early.count === 1 ? "a fill" : "fills"} from before the claims feed began, which the site holds no claim for`,
      why,
    };
  }
  const n = groups.reduce((t, g) => t + g.count, 0);
  const cents = groups.reduce((t, g) => t + g.cents, 0);
  const further = early ? `; a further ${count(early.count)} (${sum(early.count, early.cents)}) ${are(early.count)} for ${early.count === 1 ? "a fill" : "fills"} from before the claims feed began, which the site holds no claim for` : "";
  return {
    tone: groups.some((g) => g.needs === "decide" || g.needs === "look") ? "warn" : "ok",
    amount: sum(n, cents),
    title: `is tied to no claim — ${payments(n)} received since ${since}: ${needsPhrase(groups)}${further}`,
    why,
  };
}

/** How many of one source's payments are tied to the claim each paid, said to follow that source's name: "Its" is the source. */
export function tiedSays(tied: number, total: number): string {
  if (total === 0) return "";
  if (tied === total) return total === 1 ? "Its one payment is tied to the claim it paid." : `All ${count(total)} of its payments are tied to the claim each paid.`;
  if (tied === 0) return total === 1 ? "Its one payment is tied to no claim." : `None of its ${count(total)} payments is tied to a claim.`;
  return `${count(tied)} of its ${count(total)} payments ${tied === 1 ? "is" : "are"} tied to the claim ${tied === 1 ? "it" : "each"} paid.`;
}

/**
 * What the money list says about one source's payments that are tied to no claim: each group in the page's order, as the page words it (its
 * count and sum, then `causeInfo`'s short form), then what it asks of a person. Where no group asks anything the line says so once, first,
 * and asks nothing of each. Empty where nothing is tied to none.
 */
export function sourceToDo(rows: TallyRow[], feedFrom: string | null): string {
  if (rows.length === 0) return "";
  const groups = [...rows].sort((a, b) => CAUSES.indexOf(a.cause) - CAUSES.indexOf(b.cause)).map((r) => ({ r, info: causeInfo(r.cause, feedFrom) }));
  const idle = groups.every((g) => g.info.needs === "nothing");
  const parts = groups.map(({ r, info }) => {
    const group = `${groupPart(r, feedFrom)}.`;
    return idle ? group : `${group} ${info.needs === "nothing" ? "Needs nothing." : info.asks}`;
  });
  return `${idle ? "Nothing to do. " : ""}${parts.join(" ")}`;
}

/**
 * What is said wherever a payer's balance is shown (the owed page, the month-end AR report) about the payments tied to no claim: that none of
 * them is in any balance, and why, group by group, in the words the Claims page uses. `rows` is null where the reasons are not known, and then
 * only the first is said. The one consequence for a figure is that a payment which fits claims on file leaves them showing a balance without it
 * until it is attached; the others are for fills there is no claim for, or for reversed claims, which are nobody's receivable.
 */
export function unattachedSays(total: { count: number; cents: number }, rows: TallyRow[] | null, booksFrom: string, feedFrom: string | null): string {
  const n = total.count;
  if (n === 0) return "";
  const lead = `${payments(n)} (${sum(n, total.cents)}) received since ${fmt(booksFrom)} ${are(n)} tied to no claim, so ${n === 1 ? "it is" : "they are"} in no payer's balance`;
  if (rows === null) return `${lead}.`;
  const groups = [...rows].sort((a, b) => CAUSES.indexOf(a.cause) - CAUSES.indexOf(b.cause));
  const fitsClaims = groups.some((r) => r.cause === "fits_several" || r.cause === "will_attach");
  const consequence = fitsClaims ? " Until each payment that fits claims on file is attached, the claims it could settle show a balance without it." : "";
  return `${lead}: ${groups.map((r) => groupPart(r, feedFrom)).join("; ")}.${consequence}`;
}

/** The same, short, for the sentence under the owed page's title: the total, how much of it is for fills from before the claims feed, and where the rest is said (the card below it). */
export function unattachedTail(total: { count: number; cents: number }, rows: TallyRow[] | null, feedFrom: string | null): string {
  const n = total.count;
  if (n === 0) return "";
  const lead = ` Separately, ${payments(n)} (${sum(n, total.cents)}) ${are(n)} tied to no claim, so ${n === 1 ? "it is" : "they are"} in no payer's balance.`;
  if (rows === null) return lead;
  const early = rows.find((r) => r.cause === "before_feed");
  const rest = n - (early?.count ?? 0);
  const who = early ? (early.count === n ? (n === 1 ? "It is" : "All of them are") : `${count(early.count)} of them ${are(early.count)}`) : "";
  const before = early ? ` ${who} ${causeInfo("before_feed", feedFrom).short[early.count === 1 ? 0 : 1]}.` : "";
  const why = rest === 0 ? "" : ` The card below says why${early ? ` for the other ${rest === 1 ? "one" : count(rest)}` : ""}.`;
  return `${lead}${before}${why}`;
}
