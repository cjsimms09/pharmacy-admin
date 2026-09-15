/**
 * Whether a deposit has already been banked by another feed.
 *
 * The owner: "we need to make sure we are using this data to make our money tracking even more
 * correct but also make sure we arent duplicating things!" Three feeds see the same deposit — the
 * payer's own payment report lists it by payment number, an 835 carries it with a trace number, a
 * copay statement settles a slice of it — and each of them wants to bank it.
 *
 * This was inside `addCashReceipt`, with a copy of the rule written out again in the tests. A copy
 * of a rule is a rule that drifts, and this file has spent a night finding places where a stated
 * rule and its code had quietly parted company. So the decision lives here, once, and the database
 * function and the tests both call it.
 *
 * ── The day is a window, not a key ──
 *
 * The same deposit does not carry the same date in both feeds. An 835 banks on BPR16, the payment's
 * effective date; the payer's payment report banks on the day it landed in the account. On every
 * Health Mart Atlas deposit on file they differ by one to four days — EFT-31434994 is paid
 * 2026-09-04 and deposited 2026-09-08. The gate used to require the same calendar day, so the
 * second copy went straight through: $37,909.27 on that one deposit, $84,921.40 across the five
 * known mismatched rows.
 *
 * What identifies a deposit exactly is the payer's own reference, because the payer put it on the
 * payment and both feeds copy it down. Digits only, and at least six of them, so "EFT-31434994" and
 * "31434994" are one payment while two short references cannot collide by accident.
 *
 * ── Who this applies to ──
 *
 * Feeds, not people. A `sourceKey` is what an automatic reader supplies, so its presence is how the
 * two are told apart. Money typed in off a bank statement is trusted outright: the bank is the
 * record, and if it shows two deposits of the same amount on the same day then there were two, and
 * refusing the second would be this code overruling the statement it exists to agree with.
 *
 * Pure, so it is tested.
 */

export type BankedReceipt = {
  amountCents: number;
  receivedOn: string | null;
  payer: string | null;
  sourceKey: string | null;
  reference?: string | null;
  month?: string;
  createdBy?: string;
};

export type IncomingReceipt = {
  amountCents: number;
  /** The month it is filed under — compared with receipts typed by hand, which carry no date. */
  month?: string;
  receivedOn?: string | null;
  payer?: string | null;
  sourceKey?: string | null;
  reference?: string | null;
};

export type GateVerdict = { bank: true } | { bank: false; why: string };

/**
 * How far apart the same deposit can look in two feeds.
 *
 * Four days is the widest gap on the payments actually on file. Seven leaves room without reaching a
 * fortnight, where two genuine deposits of the same amount from the same payer stop being unlikely.
 */
export const DEPOSIT_WINDOW_DAYS = 7;

const digits = (v: string | null | undefined): string => (v ?? "").replace(/\D/g, "");
const head = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
const money = (c: number) => (c / 100).toFixed(2);

export function shiftDays(iso: string, by: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

/** True where two dates are close enough to be the same deposit seen twice. */
export function withinWindow(a: string | null | undefined, b: string | null | undefined, days = DEPOSIT_WINDOW_DAYS): boolean {
  if (!a || !b) return false;
  const x = Date.parse(`${a}T00:00:00Z`);
  const y = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= days * 86_400_000;
}

/**
 * The verdict on one incoming deposit against what is already banked.
 *
 * `held` is every receipt worth comparing against — in the database function, the rows inside the
 * window. Passing more than that is harmless; passing fewer is how a duplicate gets through.
 */
export function gateDeposit(held: BankedReceipt[], incoming: IncomingReceipt): GateVerdict {
  /*
   * Its own identity first. A feed re-read — the same file dropped twice — is caught here and is a
   * different thing from two feeds meeting, so it is worth saying differently.
   */
  if (incoming.sourceKey) {
    const same = held.find((h) => h.sourceKey && h.sourceKey === incoming.sourceKey);
    if (same) return { bank: false, why: `already banked from ${same.createdBy ?? "an earlier import"}${same.month ? ` on ${same.month}` : ""}` };
  }

  // Typed by a person: the bank statement is the record and this does not argue with it.
  if (!incoming.sourceKey) return { bank: true };

  const mine = digits(incoming.reference);
  if (mine.length >= 6) {
    const byReference = held.find((h) => digits(h.reference) === mine);
    if (byReference) {
      return {
        bank: false,
        why:
          `${incoming.reference} is already banked as ${money(byReference.amountCents)}` +
          `${byReference.receivedOn ? ` on ${byReference.receivedOn}` : ""}` +
          `${byReference.amountCents === incoming.amountCents ? "" : `, though this copy says ${money(incoming.amountCents)}`}`,
      };
    }
  }

  if (!incoming.receivedOn) return { bank: true };
  /*
   * A receipt a person typed with the form: no date, no key, only a month. Invisible to the window below,
   * so the card batch forwarded after somebody typed the same deposit banked beside it (Session 2, money
   * map G-CARD-8, H2). Compared by month and exact amount, and not by payer: a person types "Heartland"
   * for what the feed calls "Card batch".
   */
  /* Its own month and the months either side: a batch closed on the 30th is typed under the month it reached the bank (G-CARD-9). */
  const around = monthsAround(incoming.month ?? incoming.receivedOn.slice(0, 7));
  const typed = held.find((h) => !h.receivedOn && !h.sourceKey && h.amountCents === incoming.amountCents && h.month && around.includes(h.month));
  if (typed) {
    return {
      bank: false,
      why: `${money(incoming.amountCents)} was already typed in by hand for ${typed.month}${typed.payer ? ` as ${typed.payer}` : ""}. If that is this money, nothing more is needed; if it is different money, remove the typed receipt and forward this again.`,
    };
  }
  /*
   * Two payments the same feed numbered differently are two payments, whatever their amounts. DomaniRx paid
   * $904.00 as …4538 on 26 August and $904.00 as …2227 on 28 August; the bank shows both, and the amount rule
   * refused the second (Session 2, money map G-PP-1). Across feeds the rule still holds, because one deposit
   * really does carry different numbers in different feeds — an 835's trace against the portal's payment number.
   */
  const feedOf = (key: string | null | undefined) => (key ?? "").split("|")[0];
  const numberedApart = (h: BankedReceipt) =>
    digits(h.reference).length >= 6 && mine.length >= 6 && digits(h.reference) !== mine && feedOf(h.sourceKey) !== "" && feedOf(h.sourceKey) === feedOf(incoming.sourceKey);
  const clash = held.find(
    (h) =>
      !numberedApart(h) &&
      h.amountCents === incoming.amountCents &&
      withinWindow(h.receivedOn, incoming.receivedOn) &&
      (!incoming.payer || !h.payer || head(h.payer) === head(incoming.payer)),
  );
  if (clash) {
    return {
      bank: false,
      why:
        `${money(incoming.amountCents)} from ${incoming.payer ?? "a payer"} on ${incoming.receivedOn} is already banked` +
        `${clash.reference ? ` as ${clash.reference}` : ""}` +
        `${clash.receivedOn && clash.receivedOn !== incoming.receivedOn ? ` under ${clash.receivedOn}` : ""}`,
    };
  }
  return { bank: true };
}

/**
 * A bank statement line and the receipt already banked for the same deposit.
 *
 * `gateDeposit` stops two automatic feeds banking one deposit. It deliberately does not argue with a
 * bank statement: "typed by a person: the bank statement is the record". But the bank statement is
 * not only typed — `readBankStatement` banks every deposit line, with no source key, and so every
 * deposit the payer payment report or the Health Mart Atlas EFT notice had already banked would have
 * been banked again. Found on 15 September before any statement had been read; September then held
 * $250,562.16 of third-party receipts that the first statement would have doubled.
 *
 * The bank being the record is exactly why a bank line should **confirm** a receipt rather than add
 * one: the receipt says a deposit happened, the statement proves it did, and it is one deposit.
 *
 * ── The match, and why it ignores the description ──
 *
 * The exact amount, within `DEPOSIT_WINDOW_DAYS`, one receipt to one line. It does not require the
 * payer on the bank line to match the payer on the receipt, and that is deliberate. Health Mart Atlas
 * money is sent by McKesson, a bank line may say MCKESSON, PROVIDERPAY or nothing useful, and McKesson
 * is on the supplier register so the line may even have been placed as a rebate. Requiring the names
 * to agree would miss the confirmation and bank the deposit twice — the worse of the two errors. A
 * matching payer is still preferred where more than one receipt qualifies.
 *
 * One-to-one through `claimed`, so a statement that genuinely shows two deposits of the same amount
 * confirms one receipt and banks the other — the gate's own principle that the bank is not overruled.
 * Where more than one unclaimed receipt qualifies and the payer does not settle it, nothing is guessed:
 * the line is for a person.
 *
 * Pure.
 */
export type HeldForBank = { id: string; amountCents: number; receivedOn: string | null; payer: string | null; reference?: string | null; sourceKey?: string | null };

export type BankDepositMatch =
  | { kind: "confirms"; receipt: HeldForBank; why: string }
  | { kind: "ambiguous"; candidates: HeldForBank[]; why: string }
  | { kind: "none" };

/**
 * Two or three receipts that together come to exactly `amountCents` — up to five such combinations, so a
 * caller can tell one explanation from several. Receipts of zero or more than the amount are ignored.
 */
export function receiptsSummingTo<T extends { amountCents: number }>(pool: T[], amountCents: number): T[][] {
  const usable = pool.filter((h) => h.amountCents > 0 && h.amountCents < amountCents);
  const combos: T[][] = [];
  for (let i = 0; i < usable.length && combos.length < 5; i++) {
    for (let j = i + 1; j < usable.length && combos.length < 5; j++) {
      const two = usable[i].amountCents + usable[j].amountCents;
      if (two === amountCents) combos.push([usable[i], usable[j]]);
      else if (two < amountCents) {
        for (let k = j + 1; k < usable.length && combos.length < 5; k++) {
          if (two + usable[k].amountCents === amountCents) combos.push([usable[i], usable[j], usable[k]]);
        }
      }
    }
  }
  return combos;
}

/** The month before and after a YYYY-MM, and the month itself. */
export function monthsAround(month: string): string[] {
  const d = new Date(Date.parse(`${month}-01T00:00:00Z`));
  const shift = (n: number) => {
    const x = new Date(d);
    x.setUTCMonth(x.getUTCMonth() + n);
    return x.toISOString().slice(0, 7);
  };
  return [shift(-1), month, shift(1)];
}

export function matchHeldDeposit(
  held: HeldForBank[],
  line: { amountCents: number; on: string; payer: string | null },
  claimed: Set<string>,
): BankDepositMatch {
  const candidates = held.filter((h) => !claimed.has(h.id) && h.amountCents === line.amountCents && withinWindow(h.receivedOn, line.on));
  if (candidates.length === 0) {
    /*
     * Two or three receipts the bank paid in as one deposit — two card batches settled together, say.
     * No single receipt matches, so this used to bank the line as new money on top of both (Session 2,
     * money map checkpoint 1, case D, proven on a snapshot). Which receipts they are cannot be recorded
     * against one bank line, so the line goes to a person, named — never banked.
     */
    const pool = held.filter((h) => !claimed.has(h.id) && h.amountCents > 0 && h.amountCents < line.amountCents && h.receivedOn && h.receivedOn <= line.on && withinWindow(h.receivedOn, line.on));
    const combos = receiptsSummingTo(pool, line.amountCents);
    if (combos.length === 0) return { kind: "none" };
    const describeAll = (c: HeldForBank[]) => c.map((h) => `${money(h.amountCents)}${h.payer ? ` from ${h.payer}` : ""}${h.receivedOn ? ` on ${h.receivedOn}` : ""}`).join(" + ");
    return {
      kind: "ambiguous",
      candidates: combos[0],
      why:
        combos.length === 1
          ? `This deposit is exactly ${describeAll(combos[0])}, already banked separately — probably paid in together. Those receipts are this money: nothing needs banking, and banking it with the form would count it twice.`
          : `This deposit equals more than one combination of receipts already banked (${combos.map(describeAll).join("; or ")}). Nothing is banked. Check which; do not bank it with the form, which would count it twice.`,
    };
  }
  const describe = (h: HeldForBank) =>
    `already banked as ${money(h.amountCents)}${h.payer ? ` from ${h.payer}` : ""}${h.reference ? ` (${h.reference})` : ""}${h.receivedOn ? ` on ${h.receivedOn}` : ""}`;
  let pick = candidates;
  if (candidates.length > 1 && line.payer) {
    const named = candidates.filter((h) => h.payer && head(h.payer) === head(line.payer));
    if (named.length > 0) pick = named;
  }
  if (pick.length === 1) {
    return { kind: "confirms", receipt: pick[0], why: `The statement confirms a deposit ${describe(pick[0])}. Nothing new is banked.` };
  }
  return {
    kind: "ambiguous",
    candidates: pick,
    why: `${pick.length} deposits of ${money(line.amountCents)} are already banked within ${DEPOSIT_WINDOW_DAYS} days of ${line.on}, and nothing on the line says which this is. Nothing is banked; it needs a person.`,
  };
}
