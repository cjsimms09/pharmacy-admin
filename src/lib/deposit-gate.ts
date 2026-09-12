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
  const clash = held.find(
    (h) =>
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
