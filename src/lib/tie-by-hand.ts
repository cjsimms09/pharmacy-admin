import "server-only";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./audit";
import { fmt } from "./dates";
import { formatCents } from "./money";
import { causeInfo } from "./untied-payments";
import { whatItFits } from "./untied-payments-store";

/*
 * A payment that fits two or more claims equally is left tied to none: the site keeps no payer BIN on a payment, neither a voucher nor the amount
 * singles one claim out, and a payment tied to the wrong claim makes two claims wrong at once. The owner can tell them apart, so this is how he
 * says which. It is the only way a payment is tied by someone and not by the matcher, it is refused for every other group of payments, and it is
 * undone by the same screen. His name stays on the payment (`tied_by`): the sweep that revisits tied payments leaves it where he put it, and the
 * same money arriving again by another report is read as this payment (claim-payments.ts).
 */

type Actor = { id: string; name: string };

/**
 * Ties the payment to the claim chosen, if the site still reads the payment as fitting that claim among several. It is asked at the press, so what
 * it acts on is what is true then: a payment tied since the page was drawn, or one a later claims load now ties by itself, is refused and not moved.
 * Returns what was done, in a sentence the page shows. Throws, in a sentence a person can act on, where it does nothing.
 */
export async function tieByHand(paymentId: string, claimId: string, user: Actor): Promise<string> {
  const fit = await whatItFits(paymentId);
  if (!fit) throw new Error("That payment is not waiting for a claim any more: it is tied already, or it was received before the books begin.");
  if (fit.cause !== "fits_several") throw new Error(`The site now reads that payment as "${causeInfo(fit.cause, null).label}", not as fitting several claims, so there is no claim to choose. Reload the page.`);
  if (!fit.claimIds.includes(claimId)) throw new Error("That claim is not one of the claims this payment fits.");

  await db
    .update(schema.claimPayments)
    .set({ claimId, tiedBy: user.name })
    .where(and(eq(schema.claimPayments.id, paymentId), isNull(schema.claimPayments.claimId)));
  const now = await db.query.claimPayments.findFirst({ where: eq(schema.claimPayments.id, paymentId), columns: { claimId: true, tiedBy: true } });
  if (now?.claimId !== claimId || now.tiedBy !== user.name) throw new Error("The payment was tied by something else a moment ago, so nothing was changed. Reload the page.");

  const p = fit.payment;
  await audit({
    action: "claim_payment.tie_by_hand",
    userId: user.id,
    userName: user.name,
    entity: "claim_payment",
    entityId: paymentId,
    details: `Tied the ${formatCents(p.amountCents)} received ${p.receivedOn ? fmt(p.receivedOn) : "on no date"} to claim ${claimId}, one of ${fit.claimIds.length} it fit equally.`,
  });
  return `Attached the ${formatCents(p.amountCents)} received ${p.receivedOn ? fmt(p.receivedOn) : "on no date"} to the claim you chose. It is listed under "Attached by hand" below, where it can be taken back.`;
}

/** Takes back a tie made by hand: the payment is tied to no claim again and is read again like any other. Refused for a payment the matcher tied. */
export async function untieByHand(paymentId: string, user: Actor): Promise<string> {
  const p = await db.query.claimPayments.findFirst({
    where: and(eq(schema.claimPayments.id, paymentId), isNotNull(schema.claimPayments.tiedBy), isNotNull(schema.claimPayments.claimId)),
    columns: { claimId: true, amountCents: true, receivedOn: true, tiedBy: true },
  });
  if (!p) throw new Error("That payment was not tied by hand, so there is nothing here to take back.");
  await db.update(schema.claimPayments).set({ claimId: null, tiedBy: null }).where(eq(schema.claimPayments.id, paymentId));
  await audit({
    action: "claim_payment.untie_by_hand",
    userId: user.id,
    userName: user.name,
    entity: "claim_payment",
    entityId: paymentId,
    details: `Took back the tie of the ${formatCents(p.amountCents)} received ${p.receivedOn ? fmt(p.receivedOn) : "on no date"} to claim ${p.claimId}, made by ${p.tiedBy}.`,
  });
  return `Took the ${formatCents(p.amountCents)} received ${p.receivedOn ? fmt(p.receivedOn) : "on no date"} off the claim. It is read again with the others that are tied to none.`;
}
