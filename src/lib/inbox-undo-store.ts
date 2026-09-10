import "server-only";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { audit } from "./audit";
import { effectOf } from "./inbox-undo";

/**
 * Taking a remittance back out, when it should never have been read as one.
 *
 * The owner's worst case, in his own answer: "It filed something as the wrong kind of document."
 * Re-routing was the first half of the fix — it loads the document as what it really is. This is
 * the other half, and it only exists for the two kinds where a wrong reading moves money: an 835
 * and a copay-voucher statement both write a payment against every fill they name and bank their
 * total on the cash account.
 *
 * ── Why it is keyed on the document and on nothing else ──
 *
 * The obvious handle is the check number. It is the wrong one. A statement that prints no check
 * number has none to key on, two statements from one payer can carry the same number, and a
 * payment somebody typed in by hand can carry any number at all. Deleting money on a match like
 * that is how an undo becomes the thing it was built to protect against.
 *
 * The document is what was loaded, so the document is what is unloaded. Every payment and every
 * deposit these two readers write now carries the id of the document it was read out of, and this
 * deletes exactly those rows and no others.
 *
 * ── What it will not do ──
 *
 * It refuses anything recorded before the column existed, because those rows carry no document and
 * there is no honest way to tell which file they came from. It refuses every other kind: a
 * catalogue's prices, a claims file's claims and a reversal's cancellations are not rows this can
 * identify, and `inbox-undo.ts` says so on the screen instead of pretending otherwise.
 *
 * Nothing is re-derived and nothing is recomputed: the counts returned are the rows deleted.
 */

export type UndoResult = {
  ok: boolean;
  /** What was removed, in words, for the audit trail and for the screen. */
  said: string;
  payments: number;
  paymentCents: number;
  deposits: number;
  depositCents: number;
};

export async function undoInboxItem(itemId: string, user: { id?: string | null; name: string }): Promise<UndoResult> {
  const none = { payments: 0, paymentCents: 0, deposits: 0, depositCents: 0 };

  const item = await db.query.inboxItems.findFirst({ where: eq(schema.inboxItems.id, itemId) });
  if (!item) return { ok: false, said: "That arrival is not on file.", ...none };
  if (!item.documentId) {
    return { ok: false, said: "Nothing was stored for this arrival, so there is nothing to take back.", ...none };
  }

  const effect = effectOf(item.routedAs);
  if (!effect || effect.reversal !== "removable") {
    /*
     * Said in the same words the screen uses, because a person who read the screen and then pressed
     * the button should not be told something different by the result.
     */
    const what = item.routedAs ? item.routedAs.replace(/_/g, " ") : "nothing";
    return {
      ok: false,
      said: `This was loaded as ${what}, and the site cannot take that back out. ${effect?.leaves ?? "What it wrote has to be dealt with where it was written."}`,
      ...none,
    };
  }

  const doc = item.documentId;

  /*
   * Read before deleting, so the result says what actually went rather than what was asked for.
   * A count from `.rowsAffected` would be right too; these rows are also worth naming in the audit.
   */
  const payments = await db
    .select({ id: schema.claimPayments.id, amountCents: schema.claimPayments.amountCents, rxNumber: schema.claimPayments.rxNumber })
    .from(schema.claimPayments)
    .where(eq(schema.claimPayments.documentId, doc));
  const deposits = await db
    .select({ id: schema.cashReceipts.id, amountCents: schema.cashReceipts.amountCents })
    .from(schema.cashReceipts)
    .where(eq(schema.cashReceipts.documentId, doc));

  if (payments.length === 0 && deposits.length === 0) {
    return {
      ok: false,
      said:
        "Nothing on the books is marked as having come from this document. Either it was already taken back out, or it was loaded before the site started recording which document a payment came from — in which case the rows are still there and this cannot safely tell which they are.",
      ...none,
    };
  }

  const paymentCents = payments.reduce((n, p) => n + p.amountCents, 0);
  const depositCents = deposits.reduce((n, d) => n + d.amountCents, 0);

  await db.delete(schema.claimPayments).where(eq(schema.claimPayments.documentId, doc));
  await db.delete(schema.cashReceipts).where(eq(schema.cashReceipts.documentId, doc));

  const said =
    `${payments.length} payment${payments.length === 1 ? "" : "s"} (${money(paymentCents)}) and ` +
    `${deposits.length} bank deposit${deposits.length === 1 ? "" : "s"} (${money(depositCents)}) removed, ` +
    `read from ${item.fileName ?? "this document"} as ${(item.routedAs ?? "").replace(/_/g, " ")}.`;

  await db
    .update(schema.inboxItems)
    .set({
      routedAs: "unrecognised",
      routeResult: `Taken back out by ${user.name}: ${said} The document is still here; tell it what this is and it will load it properly.`,
    })
    .where(eq(schema.inboxItems.id, itemId));

  await audit({
    action: "inbox.undone",
    userId: user.id ?? null,
    userName: user.name,
    entity: "document",
    entityId: doc,
    details: `${said} Payments: ${payments.map((p) => p.rxNumber).slice(0, 20).join(", ")}`.slice(0, 500),
  });

  return { ok: true, said, payments: payments.length, paymentCents, deposits: deposits.length, depositCents };
}

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
