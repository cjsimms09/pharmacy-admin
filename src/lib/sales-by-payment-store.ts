import "server-only";
import { and, gte, isNull, like, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./audit";
import { isOutOfBooks } from "./books-start";
import { describeSalesByPayment, readSalesByPayment, type SalesByPayment } from "./sales-by-payment";

/**
 * Keeps a day's sales by payment type and says what it agrees with.
 *
 * The reading is `sales-by-payment.ts`. Nothing here books money on either basis — see there. What it
 * adds is two checks nobody else can make:
 *
 *   Card payments less card refunds against the card batch reports banked for the same days. The batch
 *   is the processor's count and this is the till's; they are the same money counted twice by two
 *   systems, so any difference is a batch missing, a batch closed on a different day, or a card taken
 *   outside PioneerRx.
 *
 *   Prescription money against the claims sold on those days: remit from the plans, and what patients
 *   paid. A claim sold in PioneerRx and missing from the site shows up here the day after, rather than
 *   when somebody happens to count.
 *
 * A period before the site's books start is kept as a document and records nothing.
 */
export async function fileSalesByPayment(
  input: { text: string; documentId: string | null },
  by: { userName: string },
): Promise<{ says: string; stored: boolean; refused: boolean }> {
  const read = readSalesByPayment(input.text);
  if (!read.ok) return { says: read.why, stored: false, refused: true };
  const r = read.report;
  const described = describeSalesByPayment(r);
  if (isOutOfBooks(r.periodFrom)) {
    return { says: `${described} It covers days before the site's books start, so it is kept as a document and nothing is recorded from it.`, stored: false, refused: false };
  }

  const period = `${r.periodFrom}|${r.periodTo}`;
  const values = {
    periodFrom: r.periodFrom,
    periodTo: r.periodTo,
    printedOn: r.printedOn,
    cashCents: r.payments.cash,
    checkCents: r.payments.check,
    cardCents: r.payments.card,
    accountCents: r.payments.account,
    couponsCents: r.payments.coupons,
    returnsCashCents: r.payments.returnsCash,
    returnsCardCents: r.payments.returnsCard,
    returnsAccountCents: r.payments.returnsAccount,
    returnsCouponsCents: r.payments.returnsCoupons,
    cardNetCents: r.cardNetCents,
    retailCents: r.retailCents,
    retailTaxCents: r.retailTaxCents,
    rxPatientCents: r.rxPatientCents,
    rxRemitCents: r.rxRemitCents,
    adjustmentsCents: r.adjustmentsCents,
    totalCents: r.totalCents,
    rowsJson: JSON.stringify(r.rows),
    documentId: input.documentId,
    createdBy: by.userName,
    updatedAt: new Date().toISOString(),
  };
  const replaced = Boolean(await db.query.salesByPayment.findFirst({ where: (t, { eq }) => eq(t.period, period), columns: { period: true } }));
  await db
    .insert(schema.salesByPayment)
    .values({ period, ...values })
    .onConflictDoUpdate({ target: schema.salesByPayment.period, set: values });

  const says = `${described}${replaced ? " A re-run of a period already on file: it replaces that one." : ""} ${await checks(r)}`;
  await audit({ action: "sales.by_payment_read", userName: by.userName, entity: "document", entityId: input.documentId ?? undefined, details: says });
  return { says, stored: true, refused: false };
}

async function checks(r: SalesByPayment): Promise<string> {
  const out: string[] = [];

  const batches = await db.query.cashReceipts.findMany({
    where: and(like(schema.cashReceipts.sourceKey, "card-batch|%"), gte(schema.cashReceipts.receivedOn, r.periodFrom), lte(schema.cashReceipts.receivedOn, r.periodTo)),
    columns: { amountCents: true },
  });
  const batchCents = batches.reduce((n, b) => n + b.amountCents, 0);
  if (batches.length === 0) {
    out.push(r.cardNetCents ? `Cards: no card batch report is on file for these days, so the ${money(r.cardNetCents)} cannot be checked yet.` : "Cards: none taken, and no batch on file.");
  } else if (batchCents === r.cardNetCents) {
    out.push(`Cards: the card batch${batches.length === 1 ? "" : "es"} on file come${batches.length === 1 ? "s" : ""} to exactly ${money(batchCents)}.`);
  } else {
    out.push(`Cards: the till says ${money(r.cardNetCents)} and the card batch${batches.length === 1 ? "" : "es"} on file say ${money(batchCents)}, ${money(Math.abs(r.cardNetCents - batchCents))} ${r.cardNetCents > batchCents ? "less in the batches" : "more in the batches"}.`);
  }

  /* Claims sold in the period and not reversed. */
  const [claims] = (
    await db
      .select({ n: sql<number>`count(*)`, remit: sql<number>`coalesce(sum(${schema.claims.remitCents}), 0)`, patient: sql<number>`coalesce(sum(${schema.claims.patientTotalCents}), 0)` })
      .from(schema.claims)
      .where(and(gte(schema.claims.soldOn, r.periodFrom), lte(schema.claims.soldOn, r.periodTo), isNull(schema.claims.reversedOn)))
  );
  const remit = Number(claims?.remit ?? 0);
  const patient = Number(claims?.patient ?? 0);
  const same = (a: number, b: number) => a === b;
  out.push(
    `Prescriptions: ${Number(claims?.n ?? 0)} claims on the site sold these days, remit ${money(remit)}${same(remit, r.rxRemitCents) ? " (agrees)" : ` against PioneerRx's ${money(r.rxRemitCents)}`}, ` +
      `patients ${money(patient)}${same(patient, r.rxPatientCents) ? " (agrees)" : ` against ${money(r.rxPatientCents)}`}.`,
  );
  if (r.accountNetCents) out.push(`${money(r.accountNetCents)} was charged to patients' accounts rather than paid: owed to the pharmacy, and not in any batch or deposit until it is paid off.`);
  return out.join(" ");
}

const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
