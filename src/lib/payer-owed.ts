/**
 * What each payer owes against what it has actually sent.
 *
 * The owner: "it should be easy to know how much a payer owes us for a claim." Nothing on the site
 * answers it. Every ingredient is on file — each payer's receivable is its own remit on its own
 * transmission (`payerShares` in fills.ts), and what arrived is `claim_payments` — but the two have
 * never been put in the same room.
 *
 * ── The whole difficulty is that nothing has arrived yet ──
 *
 * No real payer 835 has ever reached this pharmacy. Billed, on 9 September 2026: $131,743.31.
 * Received: nothing. A page that renders that as a column of $0.00 against a column of five-figure
 * sums looks broken, and a page that looks broken gets ignored on the day it stops being wrong.
 *
 * So the states are named rather than left to be read off two numbers. Three of them are easy to
 * confuse and only one means something is wrong:
 *
 *   nothing to measure   a cash plan. It never sends money and never will. Not a debt.
 *   never measured       a real payer that has never remitted. Outstanding, and not late — the
 *                        site has no idea what late means for it until the first one lands.
 *   measured             it has paid before. Now the outstanding balance is a fact about a payer
 *                        that is capable of paying, which is the only version worth chasing.
 *
 * The same confusion in a different costume is the 24 facilitator payments on file, $5,808.33,
 * matching no claim. They are for fills between January and August; this site's records begin on
 * 1 September. Money with nothing to attach to is not an error and must not be counted as one.
 *
 * ── What this refuses to say ──
 *
 * That anything is late. No remittance cycle is on file for any payer — not in the contracts that
 * have been read, not on the payer register — so "30 days" would be a number this pharmacy invented
 * and then believed. It says how long the payer's oldest claim has been waiting and leaves the
 * judgement to somebody who knows the contract. A deadline nobody imposed has already cost this
 * project once.
 *
 * Nor that the age it prints is the age of anything *unsettled*. Payments are summed per payer, not
 * matched claim by claim, so where a payer has part-paid there is no telling which of its claims the
 * money covered. See `oldestOn`: this said the stronger thing until 1 caught it on review, which is
 * the fault this codebase is least able to afford — a comment asserting an invariant its code does
 * not enforce, where the comments are how the rules are known.
 *
 * Pure. `payer-owed-store.ts` loads the rows.
 */

import { normalisePayerName } from "./payer-name";
import { COPAY_PAYER } from "./copay-remit";
import { VERIDIKAL_CLAIM_FEE_CENTS, VERIDIKAL_CONVERSION_FEE_CENTS, VERIDIKAL_PAYER, type VeridikalProgram, type VeridikalRow } from "./veridikal-report";

/** The voucher fields a claim carries, as `claims` holds them. */
export type VoucherFields = {
  remitCents: number | null;
  /** EvoucherAmountPaid: where RedSail's switch vouchers carry their amount. */
  evoucherCents: number | null;
  /** EvoucherAmountFromMessage: where Veridikal's amount is. */
  evoucherMessageCents?: number | null;
  /** "RedSail" or "Veridikal", from the message wording; null where the message has not been read. */
  evoucherProgramme?: string | null;
};

export type ClaimShares = {
  kind: "none" | "redsail_voucher" | "veridikal_evoucher" | "veridikal_conversion";
  /** What the plan whose BIN is on the claim owes. */
  planCents: number;
  /** Who owes the rest, as the programme's own payments name it; null where there is no voucher. */
  programme: string | null;
  /** What the programme is expected to pay for this claim. */
  programmeCents: number;
  /** Carried inside the claim's net but paid by nobody: a programme's fee. planCents + programmeCents + this = remit. */
  unpaidFeeCents: number;
  /** Whether the programme was read off the claim, or taken from which column holds the amount because it was not. */
  from: "programme" | "column" | null;
};

/**
 * Who owes what on one payer's claim, when a manufacturer programme pays part or all of it. The owner, 15 September:
 * "the evoucher is a secondary". The claim's net (NetAmountPaid, the remit) includes the programme's money, and the three
 * cases below were measured on PioneerRx and the programmes' own reports:
 *
 *   RedSail voucher        plan = net − voucher                   RedSail pays the voucher (EvoucherAmountPaid)
 *   Veridikal eVoucher     plan = net − message − $2.50           Veridikal pays message + $2.50: the eVoucher Fee is $2.50
 *                                                                 on all 74 paid and 8 reversed rows of its report, returning
 *                                                                 the $2.50 the claim carries
 *   Veridikal conversion   plan = $0; the message is the whole    Veridikal pays net − $0.50: ingredient + a $2.00 fee, where
 *                          net (a denied claim a manufacturer     the claim carries ingredient + $2.50 (P-5, on every row of
 *                          paid, recorded under a plan's BIN)     the Denial Conversion sample). The $0.50 is paid by nobody.
 *
 * Nothing is added: the shares and the unpaid fee add back to the net, which stays the claim's one figure. An amount
 * larger than the net is capped at it rather than billing more than the claim carries.
 *
 * ── A claim whose message has not been read ──
 *
 * Measured 15 September on live: no claim yet has `evoucher_programme` or `evoucher_message_cents` (the pull writes them
 * from 16 September), and all 53 voucher claims carry their amount in `evoucher_cents`. PioneerRx puts RedSail's amount in
 * that column and Veridikal's in the message column (zero in `evoucher_cents` on 66 of 67 Veridikal claims), and
 * September has no Veridikal voucher fill. So where the programme is not read, the column decides, and `from` says so.
 */
export function claimShares(c: VoucherFields): ClaimShares {
  const remit = c.remitCents ?? 0;
  const paid = Math.max(0, c.evoucherCents ?? 0);
  const message = Math.max(0, c.evoucherMessageCents ?? 0);
  const none: ClaimShares = { kind: "none", planCents: remit, programme: null, programmeCents: 0, unpaidFeeCents: 0, from: null };
  if (remit <= 0 || (paid === 0 && message === 0)) return none;
  const read = c.evoucherProgramme === "RedSail" || c.evoucherProgramme === "Veridikal" ? c.evoucherProgramme : null;
  const programme = read ?? (message > 0 ? "Veridikal" : "RedSail");
  const from = read ? "programme" : "column";
  const cap = (n: number) => Math.min(n, remit);

  if (programme === "RedSail") {
    const voucher = cap(paid || message);
    return { kind: "redsail_voucher", planCents: remit - voucher, programme: COPAY_PAYER, programmeCents: voucher, unpaidFeeCents: 0, from };
  }
  const amount = message || paid;
  if (amount >= remit) {
    const fee = Math.min(remit, VERIDIKAL_CLAIM_FEE_CENTS - VERIDIKAL_CONVERSION_FEE_CENTS);
    return { kind: "veridikal_conversion", planCents: 0, programme: VERIDIKAL_PAYER.denial_conversion, programmeCents: remit - fee, unpaidFeeCents: fee, from };
  }
  const share = cap(amount + VERIDIKAL_CLAIM_FEE_CENTS);
  return { kind: "veridikal_evoucher", planCents: remit - share, programme: VERIDIKAL_PAYER.evoucher, programmeCents: share, unpaidFeeCents: 0, from };
}

/** The part of a programme's payment beyond what its claim carries: new revenue, with the payment's sign (never −0). */
export function newRevenueCents(paidCents: number, carriedCents: number): number {
  const beyond = Math.max(0, Math.abs(paidCents) - carriedCents);
  return beyond === 0 ? 0 : Math.sign(paidCents) * beyond;
}

/**
 * How much of one Veridikal row the claim it settles already carries in its net: the part of the payment that is not new
 * revenue. Revenue is `sign × max(0, |Total Due| − this)`.
 *
 *   eVoucher on a Veridikal eVoucher claim           voucher + $2.50, so voucher + the $2.50 fee adds nothing
 *   conversion on a Veridikal conversion claim       the whole net, so ingredient + the $2.00 fee adds nothing (and is $0.50
 *                                                    short of it, which is a fee, not revenue given back)
 *
 * Where the claim's programme is not read or says otherwise, the row itself is asked whether it describes this claim: an
 * eVoucher row whose plan share, voucher and $2.50 add to the net, or a conversion row whose ingredient and $2.50 do. If
 * neither, the claim does not carry this money and all of it is new, as `copay-remit-store.ts` counts a voucher with no
 * claim. `newRevenueCents` is the arithmetic, signed so a reversal takes back what its row added and no more.
 */
export function carriedForVeridikalRow(program: VeridikalProgram, row: Pick<VeridikalRow, "paymentCents" | "thirdPartyDueCents">, claim: VoucherFields): number {
  const shares = claimShares(claim);
  const remit = claim.remitCents ?? 0;
  if (program === "evoucher") {
    if (shares.kind === "veridikal_evoucher") return shares.programmeCents;
    const payment = Math.abs(row.paymentCents);
    if (row.thirdPartyDueCents !== null && row.thirdPartyDueCents + payment + VERIDIKAL_CLAIM_FEE_CENTS === remit) return payment + VERIDIKAL_CLAIM_FEE_CENTS;
    return 0;
  }
  if (shares.kind === "veridikal_conversion") return remit;
  if (Math.abs(row.paymentCents) + VERIDIKAL_CLAIM_FEE_CENTS === remit) return remit;
  return 0;
}

/** One payer's claim on one fill: what it said it would pay. */
export type Receivable = {
  bin: string | null;
  name: string | null;
  /** The day the prescription was filled, which is when the payer's obligation begins. */
  dateFilled: string;
  cents: number;
  /** True where the plan is one the pharmacy bills through that never remits. */
  cashPlan: boolean;
  /**
   * The claim this share is of, and which part of it: the plan's own, or a manufacturer programme's inside it (a voucher
   * or a denial conversion, `claimShares`). Where given, this share is settled only by payments matched to the same claim
   * and part, and aged claim by claim. Where absent, the payer's share is settled by whatever it sent, summed, as before.
   */
  claimId?: string | null;
  portion?: Portion;
};

/**
 * Which part of one payer's claim. Not "primary"/"secondary": those are the claim's coordination-of-benefits position
 * (`claims.payer_position`), a different thing — a secondary payer's claim has a plan part of its own.
 */
export type Portion = "plan" | "programme";

/** One payment that arrived, as `claim_payments` holds it. */
export type Received = {
  /** Which payer sent it, matched to a receivable on the BIN where the remittance named one. */
  bin: string | null;
  payer: string | null;
  cents: number;
  receivedOn: string | null;
  /** False where the payment found no claim on file: money with nothing to attach to. */
  matched: boolean;
  /** The claim and part it settled, where the matcher found one. See `Receivable.claimId`. */
  claimId?: string | null;
  portion?: Portion;
  /**
   * True where anything beyond what the claim was billed is money nobody billed for, not an overpayment.
   *
   * The Aytu / IPD top-off: the RxRescue claim adjudicates for the copay assistance and the credit memo pays that plus a
   * top-off the claim never states (`fills.ts` can say one is coming, never how much). Counting the difference as
   * overpaid would put every one of those fills on a list of payers to query, with nothing to query — and a list with
   * nothing in it worth acting on stops being read.
   */
  notBilled?: boolean;
};

/** One claim's share, as it stands: what the month-end report ages. */
export type ClaimBalance = { payerKey: string; dateFilled: string; billedCents: number; receivedCents: number; outstandingCents: number };

/** A negative remit: a network charging the pharmacy for the claim. Owed by the pharmacy, so never a receivable. */
export type FeeOwed = { key: string; bin: string | null; name: string; claims: number; cents: number };

export type PayerState =
  /** Bills through this plan; the copay is the money. Nothing is owed, ever. */
  | "cashPlan"
  /** Billed and received agree. */
  | "settled"
  /** Outstanding, and nothing has ever arrived from this payer, so nothing is overdue yet. */
  | "waiting"
  /** Outstanding, from a payer that has paid before. The only state worth chasing. */
  | "owes"
  /** More has arrived than was billed. Worth a look either way. */
  | "overpaid";

export type PayerLine = {
  /**
   * What this row was grouped on, from `payerKey`.
   *
   * Carried rather than left to be reconstructed. The month-end report (`ar-report.ts`) has to go
   * back to the individual receivables to age them, and matching a line to its receivables on the
   * printed name would merge two payers nothing can identify and split one whose name arrived
   * spelled two ways. The key is the join, so it travels with the row.
   */
  key: string;
  bin: string | null;
  name: string;
  claims: number;
  billedCents: number;
  receivedCents: number;
  /** Billed less received, floored at nought: an overpayment is its own state, not a negative debt. */
  outstandingCents: number;
  /**
   * The fill date of the oldest claim billed to this payer.
   *
   * Not the oldest *unsettled* one, which this shape cannot know: what has arrived is summed per
   * payer, not matched claim by claim, so there is no telling which of a payer's claims a payment
   * covered. Where a payer has part-paid, this is therefore the longest anything of its could have
   * been waiting rather than the longest anything has — it errs towards chasing, which is the safe
   * direction, but it is not the stronger claim the name suggests.
   */
  oldestOn: string | null;
  daysWaiting: number | null;
  state: PayerState;
  /** One sentence saying what the two figures mean, so neither is read alone. */
  says: string;
  /** Received beyond billed, claim by claim: an overpaid claim does not settle another. Nought where none is. */
  overpaidCents?: number;
  /**
   * Money this payer sent that nobody billed it for: the Aytu / IPD top-off (`Received.notBilled`).
   *
   * Revenue, and never an overpayment. The claim adjudicates for the copay assistance alone and no field on it says how
   * much top-off is coming, so there is nothing to chase and nothing that was paid "too much".
   */
  topOffCents?: number;
};

export type OwedSummary = {
  lines: PayerLine[];
  billedCents: number;
  receivedCents: number;
  outstandingCents: number;
  /** Payments that found no claim. Not an error: see the module note. */
  unattached: { count: number; cents: number };
  /**
   * Money that arrived beyond what any claim was billed, from a programme that pays it after adjudication: the Aytu /
   * IPD top-off. Revenue, counted nowhere in billed, received or outstanding, and never in the overpaid count.
   */
  topOff: { count: number; cents: number };
  /** Every claim share that carries a claim id, as it stands, for ageing. */
  claimBalances: ClaimBalance[];
  /** Payers' outstanding from shares with no claim id, where the payer has sent something: not ageable. */
  unaged: { payerKey: string; cents: number }[];
  /** Negative remits: fees networks charge the pharmacy, listed apart and in no receivable figure. */
  feesOwed: FeeOwed[];
  /** Payments matched to a claim this period does not bill (outside it, or a fee claim): settle nothing here. */
  outside: { count: number; cents: number };
  /** True where no payer has ever sent anything. The state the whole page has to survive. */
  nothingHasArrived: boolean;
  /** The headline, in words, above the table. */
  says: string;
};

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Whole days between two ISO dates, or null where either is missing or unreadable. */
export function daysBetween(from: string | null, to: string): number | null {
  if (!from) return null;
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * The key a payer is grouped on.
 *
 * The BIN, because that is what a claim carries and what a remittance names. A payer with no BIN at
 * all is grouped under its printed name rather than being merged with every other nameless one —
 * two payers nothing can identify are still two payers.
 *
 * The name is normalised rather than merely lower-cased. August's remittances arrived from both
 * "EXPRESS SCRIPTS INC" and "EXPRESS SCRIPTS INC.", and lower-casing leaves the full stop: two
 * payers, $37,438.32 and $3,867.12, one of which looks small enough to ignore.
 */
export function payerKey(bin: string | null, name: string | null): string {
  const b = (bin ?? "").trim();
  if (b) return `bin:${b}`;
  const n = normalisePayerName(name);
  return `name:${n || "unnamed"}`;
}

/**
 * What each payer owes, and — the part that matters — what its two figures mean together.
 *
 * `today` is passed rather than read so this stays pure and so the sentences are testable.
 */
export function owedByPayer(receivables: Receivable[], received: Received[], today: string): OwedSummary {
  type Share = { payerKey: string; dateFilled: string; billed: number; paid: number };
  type Acc = {
    bin: string | null; name: string; claims: number; billed: number; got: number; oldest: string | null; cash: boolean; payments: number;
    /** Shares carrying a claim id, settled claim by claim. */
    shares: Share[];
    /** Billed on shares with no claim id, and what arrived for this payer against no particular claim: the old arithmetic. */
    looseBilled: number; loosePaid: number;
    /** Money it sent beyond what anybody billed it: the top-off. Revenue, never a balance and never an overpayment. */
    topOff: number;
  };
  const by = new Map<string, Acc>();
  const shareOf = new Map<string, Share>();
  const fees = new Map<string, FeeOwed>();
  const shareKey = (claimId: string, portion: Portion | undefined) => `${claimId}|${portion ?? "plan"}`;

  for (const r of receivables) {
    const k = payerKey(r.bin, r.name);
    /*
     * A negative remit is a network charging the pharmacy for the claim — ScriptSave, Hippo and other discount networks
     * take a fee this way. It is owed by the pharmacy, not to it: listed apart, never billed, and never allowed to net
     * against another claim's balance, which is what made a payer's receivable read below nought.
     */
    if (r.cents < 0) {
      const f = fees.get(k) ?? { key: k, bin: r.bin, name: r.name ?? r.bin ?? "Unnamed payer", claims: 0, cents: 0 };
      f.claims++;
      f.cents += -r.cents;
      fees.set(k, f);
      continue;
    }
    const a = by.get(k) ?? { bin: r.bin, name: r.name ?? r.bin ?? "Unnamed payer", claims: 0, billed: 0, got: 0, oldest: null, cash: r.cashPlan, payments: 0, shares: [], looseBilled: 0, loosePaid: 0, topOff: 0 };
    a.claims++;
    a.billed += r.cents;
    if (!a.oldest || r.dateFilled < a.oldest) a.oldest = r.dateFilled;
    // One cash row makes the plan a cash plan: the flag is a property of the plan, not of the fill.
    if (r.cashPlan) a.cash = true;
    if (!a.name || a.name === a.bin) a.name = r.name ?? a.name;
    if (r.claimId) {
      const sk = shareKey(r.claimId, r.portion);
      const existing = shareOf.get(sk);
      if (existing) existing.billed += r.cents;
      else {
        const s: Share = { payerKey: k, dateFilled: r.dateFilled, billed: r.cents, paid: 0 };
        shareOf.set(sk, s);
        a.shares.push(s);
      }
    } else {
      a.looseBilled += r.cents;
    }
    by.set(k, a);
  }

  let unattachedCount = 0;
  let unattachedCents = 0;
  let outsideCount = 0;
  let outsideCents = 0;
  /* Money that arrived beyond anything billed, because nobody billed it: the top-off. Revenue, and not a balance. */
  let topOffCount = 0;
  let topOffCents = 0;
  for (const p of received) {
    if (!p.matched) {
      /*
       * Money that found no claim. Counted apart and never against a payer's balance: attributing
       * it would settle a debt with a payment for a fill this site has never held, and the balance
       * would look right for the wrong reason.
       */
      unattachedCount++;
      unattachedCents += p.cents;
      continue;
    }
    if (p.claimId) {
      /*
       * Settles the one share it was matched to, and nothing else. A payment for a claim this period does not bill — an
       * earlier fill, or a fee claim — settles nothing here rather than being spread over the payer's other claims.
       */
      const s = shareOf.get(shareKey(p.claimId, p.portion));
      const a = s ? by.get(s.payerKey) : undefined;
      if (!s || !a) {
        outsideCount++;
        outsideCents += p.cents;
        continue;
      }
      /*
       * A top-off settles the claim's own share first, and whatever is beyond it is money nobody billed: revenue, kept
       * apart from both the balance and the overpaid count.
       */
      const settles = p.notBilled ? Math.min(p.cents, Math.max(0, s.billed - s.paid)) : p.cents;
      s.paid += settles;
      a.got += settles;
      a.topOff += p.cents - settles;
      topOffCents += p.cents - settles;
      if (p.cents - settles > 0) topOffCount++;
      a.payments++;
      continue;
    }
    const k = payerKey(p.bin, p.payer);
    const a = by.get(k);
    /*
     * A matched payment whose payer has no receivable here is still money received, but it belongs
     * to a claim outside whatever period was asked for. Left out rather than credited, so a
     * September balance is not settled by an August payment that September never billed for.
     */
    if (!a) {
      outsideCount++;
      outsideCents += p.cents;
      continue;
    }
    const settles = p.notBilled ? Math.min(p.cents, Math.max(0, a.looseBilled - a.loosePaid)) : p.cents;
    a.got += settles;
    a.loosePaid += settles;
    a.topOff += p.cents - settles;
    topOffCents += p.cents - settles;
    if (p.cents - settles > 0) topOffCount++;
    a.payments++;
  }

  const lines: PayerLine[] = [...by.entries()]
    .map(([key, a]) => {
      const shareOutstanding = a.shares.reduce((n, s) => n + Math.max(0, s.billed - s.paid), 0);
      const shareOver = a.shares.reduce((n, s) => n + Math.max(0, s.paid - s.billed), 0);
      const outstanding = shareOutstanding + Math.max(0, a.looseBilled - a.loosePaid);
      const overpaid = shareOver + Math.max(0, a.loosePaid - a.looseBilled);
      /* The oldest share still unsettled, where shares are known; otherwise the oldest billed, as before. */
      const open = a.shares.filter((s) => s.billed - s.paid > 0).map((s) => s.dateFilled).sort();
      const oldest = a.looseBilled === 0 && a.shares.length ? open[0] ?? a.oldest : a.oldest;
      const days = daysBetween(oldest, today);
      const state: PayerState = a.cash
        ? "cashPlan"
        : outstanding === 0 && overpaid > 0
          ? "overpaid"
          : outstanding === 0
            ? "settled"
            : a.payments === 0
              ? "waiting"
              : "owes";
      return {
        key,
        bin: a.bin,
        name: a.name,
        claims: a.claims,
        billedCents: a.billed,
        receivedCents: a.got,
        outstandingCents: outstanding,
        oldestOn: oldest,
        daysWaiting: outstanding > 0 ? days : null,
        state,
        says:
          sentenceFor(state, a.name, outstanding, a.got, a.billed, days) +
          (state === "owes" && overpaid > 0 ? ` ${money(overpaid)} of what arrived was more than its own claims asked for, and is not counted against the others.` : "") +
          (a.topOff > 0 ? ` ${money(a.topOff)} more arrived that nobody billed it for — the top-off this programme pays after the claim — which is revenue and not an overpayment.` : ""),
        overpaidCents: overpaid,
        topOffCents: a.topOff,
      };
    })
    // Largest outstanding first: the page exists to answer "who owes me the most".
    .sort((x, y) => y.outstandingCents - x.outstandingCents || y.billedCents - x.billedCents);

  const billedCents = lines.reduce((n, l) => n + l.billedCents, 0);
  const receivedCents = lines.reduce((n, l) => n + l.receivedCents, 0);
  const outstandingCents = lines.reduce((n, l) => n + l.outstandingCents, 0);
  const real = lines.filter((l) => l.state !== "cashPlan");
  const nothingHasArrived = real.length > 0 && real.every((l) => l.receivedCents === 0);

  const claimBalances: ClaimBalance[] = [...by.values()]
    .filter((a) => !a.cash)
    .flatMap((a) => a.shares.map((s) => ({ payerKey: s.payerKey, dateFilled: s.dateFilled, billedCents: s.billed, receivedCents: s.paid, outstandingCents: Math.max(0, s.billed - s.paid) })));
  const unaged = [...by.entries()]
    .filter(([, a]) => !a.cash && a.loosePaid > 0 && a.looseBilled - a.loosePaid > 0)
    .map(([k, a]) => ({ payerKey: k, cents: a.looseBilled - a.loosePaid }));

  return {
    lines,
    billedCents,
    receivedCents,
    outstandingCents,
    unattached: { count: unattachedCount, cents: unattachedCents },
    topOff: { count: topOffCount, cents: topOffCents },
    claimBalances,
    unaged,
    feesOwed: [...fees.values()].sort((x, y) => y.cents - x.cents),
    outside: { count: outsideCount, cents: outsideCents },
    nothingHasArrived,
    says: headline({ lines, real, billedCents, receivedCents, outstandingCents, nothingHasArrived, unattachedCount, unattachedCents }),
  };
}

function sentenceFor(state: PayerState, name: string, outstanding: number, got: number, billed: number, days: number | null): string {
  switch (state) {
    case "cashPlan":
      return `${name} is a plan the pharmacy bills through rather than one that pays: the copay is the money, and the ${money(billed)} here was collected at the counter. Nothing is owed.`;
    case "settled":
      return `${money(billed)} billed and ${money(got)} received. Square.`;
    case "waiting":
      /*
       * The sentence the whole page is for. It says outstanding without saying overdue, because
       * nothing on file says how long this payer takes and the site will not invent a figure.
       */
      return (
        `${money(outstanding)} outstanding. Nothing has arrived from ${name} yet, so this is not late — it is unpaid, which is a different thing.` +
        (days === null ? "" : ` The oldest claim was filled ${days} ${days === 1 ? "day" : "days"} ago.`) +
        " No remittance cycle for this payer is on file; the first one that lands will say what normal looks like."
      );
    case "owes":
      return (
        `${money(outstanding)} outstanding of ${money(billed)} billed. ${name} has remitted before — ${money(got)} so far — so this is a balance from a payer that does pay.` +
        (days === null ? "" : ` Oldest unsettled claim filled ${days} ${days === 1 ? "day" : "days"} ago.`)
      );
    case "overpaid":
      return `${money(got)} received against ${money(billed)} billed — ${money(got - billed)} more than this pharmacy asked for. Worth reading before it is spent.`;
  }
}

function headline(a: {
  lines: PayerLine[];
  real: PayerLine[];
  billedCents: number;
  receivedCents: number;
  outstandingCents: number;
  nothingHasArrived: boolean;
  unattachedCount: number;
  unattachedCents: number;
}): string {
  if (a.lines.length === 0) return "No claims have been billed to any payer yet, so nobody owes anything.";

  const tail =
    a.unattachedCount > 0
      ? ` Separately, ${a.unattachedCount} payment${a.unattachedCount === 1 ? "" : "s"} totalling ${money(a.unattachedCents)} arrived for prescriptions this site does not hold — fills from before its records begin. That money is real and is counted nowhere on this page, because there is no claim here for it to settle.`
      : "";

  if (a.real.length === 0) {
    return `Every plan billed is one the pharmacy bills through rather than one that pays. Nothing is owed by anybody.${tail}`;
  }
  if (a.nothingHasArrived) {
    /*
     * The state this page was hardest to write for. $131,743.31 billed and nothing received is not
     * a fault in the page, in the claims, or in the payers — it is a pharmacy eight days into
     * keeping its own records, before the first remittance cycle has come round.
     */
    return (
      `${money(a.billedCents)} billed to ${a.real.length} payer${a.real.length === 1 ? "" : "s"} and nothing received from any of them yet. ` +
      `That is not this page failing: no remittance has reached the pharmacy since these records began, so every figure in the received column is a true nought rather than a missing one. ` +
      `When the first 835 arrives it will land here.${tail}`
    );
  }
  return `${money(a.billedCents)} billed, ${money(a.receivedCents)} received, ${money(a.outstandingCents)} outstanding across ${a.real.length} payer${a.real.length === 1 ? "" : "s"}.${tail}`;
}
