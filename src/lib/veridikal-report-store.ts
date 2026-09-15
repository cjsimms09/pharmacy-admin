import "server-only";
import { and, eq, gte, like, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./audit";
import { getSettings } from "./settings";
import { checkRowAgainstClaim, readVeridikalReport, type VeridikalProgram, type VeridikalRow } from "./veridikal-report";

/**
 * Posts a Veridikal client summary: one claim payment per row, and nothing on the bank account.
 *
 * The reading, and every check that refuses a report, is `veridikal-report.ts`. The decisions here are the ones that
 * touch money (money map section 15).
 *
 * ── It banks nothing ──
 *
 * The Veridikal ACH is banked from the bank statement (`bank-descriptors.ts`, a direct payer). This report is the same
 * money itemised, so it posts payments against the claims it names and says whether a Veridikal credit of its total is
 * on file; it never banks beside it.
 *
 * ── Amount, and revenue ──
 *
 * The amount is the programme's money for the claim: the voucher, or the manufacturer's ingredient payment. It is what
 * settles the claim's voucher receivable (`payer-owed-store.ts`).
 *
 * The revenue is what the claim did not already carry:
 *   - the fee, always — Veridikal pays it to the pharmacy on top, on every row of both samples;
 *   - plus the payment itself where the claim does not already carry it. PioneerRx's remit includes the voucher
 *     (measured on September's voucher claims: the plan pays remit less voucher), so an eVoucher on a claim that
 *     records that voucher adds nothing; a denial conversion on a claim whose remit already equals the manufacturer's
 *     payment adds nothing. Any other case — no claim on this site, or a claim that records no such money — counts the
 *     payment as new, as `copay-remit-store.ts` does for a voucher with no claim.
 *
 * ── Once ──
 *
 * Every row carries Veridikal's own transaction number, distinct on every row, and the reference is
 * `VERIDIKAL|<programme>|<transaction>`. A row whose reference is already held is not posted again.
 */

const PAYER: Record<VeridikalProgram, string> = { evoucher: "Veridikal (eVoucher)", denial_conversion: "Veridikal (Denial Conversion)" };
const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const veridikalReference = (program: VeridikalProgram, row: Pick<VeridikalRow, "transaction">) => `VERIDIKAL|${program}|${row.transaction}`;

export async function fileVeridikalReport(
  input: { sheets: { name: string; rows: string[][] }[]; documentId: string | null; fileName?: string },
  by: { name: string; id?: string },
): Promise<{ says: string; refused: boolean; posted: number; alreadyHeld: number; matched: number }> {
  const s = await getSettings();
  const read = readVeridikalReport(input.sheets, s.pharmacy_ncpdp || null);
  if (!read.ok) {
    await audit({ action: "claims.veridikal_report_refused", userId: by.id ?? null, userName: by.name, entity: "document", entityId: input.documentId ?? undefined, details: read.why });
    return { says: read.why, refused: true, posted: 0, alreadyHeld: 0, matched: 0 };
  }
  const p = read.report;

  const held = new Set(
    (await db.query.claimPayments.findMany({ where: like(schema.claimPayments.reference, `VERIDIKAL|${p.program}|%`), columns: { reference: true } })).map((r) => r.reference),
  );

  const { recordClaimPayment } = await import("./claim-payments");
  let posted = 0;
  let alreadyHeld = 0;
  let matched = 0;
  let postedCents = 0;
  let newRevenueCents = 0;
  let compared = 0;
  let agreed = 0;
  const differ: string[] = [];
  for (const row of p.rows) {
    const reference = veridikalReference(p.program, row);
    if (held.has(reference)) {
      alreadyHeld++;
      continue;
    }
    if (row.paymentCents === 0 && row.feeCents === 0) continue;
    // A row that is only a fee still records the money that arrived for the claim.
    const amountCents = row.paymentCents !== 0 ? row.paymentCents : row.feeCents;
    const r = await recordClaimPayment(
      {
        rxNumber: row.rxNumber,
        dateFilled: row.fillDate,
        ndc11: row.ndc11,
        bin: row.bin,
        source: "copay_card",
        payer: PAYER[p.program],
        amountCents,
        revenueCents: row.feeCents,
        receivedOn: row.depositOn,
        reference,
        documentId: input.documentId,
        notes: `From Veridikal's ${p.program === "evoucher" ? "eVoucher" : "Denial Conversion"} summary${input.fileName ? ` (${input.fileName})` : ""}, batch ${row.depositOn}, transaction ${row.transaction}: ${money(row.paymentCents)} ${p.program === "evoucher" ? "voucher" : "from the manufacturer"} and a ${money(row.feeCents)} fee paid to the pharmacy.`,
      },
      by,
    );
    posted++;
    postedCents += amountCents;
    /*
     * Whether the claim already carries the payment, now that the matcher has chosen the claim. Where it does not,
     * the payment is new revenue as well as the fee.
     */
    let revenue = row.feeCents;
    let checkNote = "";
    if (r.matched) {
      matched++;
      const pay = await db.query.claimPayments.findFirst({ where: eq(schema.claimPayments.id, r.id), columns: { claimId: true, notes: true } });
      const claim = pay?.claimId
        ? await db.query.claims.findFirst({ where: eq(schema.claims.id, pay.claimId), columns: { remitCents: true, evoucherCents: true, copayCents: true, patientTotalCents: true } })
        : null;
      if (row.paymentCents !== 0) {
        const size = Math.abs(row.paymentCents);
        const carried = p.program === "evoucher" ? (claim?.evoucherCents ?? 0) >= size : (claim?.remitCents ?? 0) >= size;
        if (!carried) revenue += row.paymentCents;
      }
      if (claim) {
        const c = checkRowAgainstClaim(p.program, row, claim);
        if (c.compared) {
          compared++;
          if (c.agrees) {
            agreed++;
            checkNote = " Agrees with the claim on file.";
          } else {
            const said = c.differences.map((d) => `${d.what} ${money(d.reportCents)} on the report, ${money(d.claimCents)} on the claim`).join("; ");
            differ.push(`Rx …${row.rxNumber.slice(-3)} filled ${row.fillDate}: ${said}`);
            checkNote = ` Differs from the claim on file: ${said}.`;
          }
        }
      }
      if (checkNote) await db.update(schema.claimPayments).set({ notes: `${pay?.notes ?? ""}${checkNote}` }).where(eq(schema.claimPayments.id, r.id));
    } else if (row.paymentCents !== 0) {
      revenue += row.paymentCents;
    }
    if (revenue !== row.feeCents) await db.update(schema.claimPayments).set({ revenueCents: revenue }).where(eq(schema.claimPayments.id, r.id));
    newRevenueCents += revenue;
  }

  /* The ACH these rows make up, banked from the bank statement: said, never banked here. */
  const bankSays: string[] = [];
  for (const d of p.byDeposit) {
    const until = new Date(Date.parse(`${d.on}T00:00:00Z`) + 21 * 86_400_000).toISOString().slice(0, 10);
    const credit = await db.query.cashReceipts.findFirst({
      where: and(like(schema.cashReceipts.payer, "Veridikal%"), eq(schema.cashReceipts.amountCents, d.cents), gte(schema.cashReceipts.receivedOn, d.on), lte(schema.cashReceipts.receivedOn, until)),
      columns: { receivedOn: true },
    });
    bankSays.push(credit ? `The Veridikal credit of ${money(d.cents)} for the ${d.on} batch is on the bank statement, ${credit.receivedOn}.` : `No Veridikal bank credit of ${money(d.cents)} for the ${d.on} batch is on file yet; the bank statement banks it.`);
  }

  const says = [
    p.says,
    `${posted} claim payment${posted === 1 ? "" : "s"} posted (${money(postedCents)}), ${matched} matched to a claim on this site, ${money(newRevenueCents)} of it new revenue${alreadyHeld ? `; ${alreadyHeld} already held` : ""}. Nothing banked.`,
    compared
      ? differ.length
        ? `Against the claims: ${agreed} of ${compared} rows agree; ${differ.length} differ, so the claim or the plan's expected payment is wrong — ${differ.join(" | ")}.`
        : `Against the claims: all ${compared} rows compared agree.`
      : posted
        ? "No row could be compared with a claim on this site."
        : "",
    ...bankSays,
  ].filter(Boolean).join(" ");
  await audit({ action: "claims.veridikal_report_read", userId: by.id ?? null, userName: by.name, entity: "document", entityId: input.documentId ?? undefined, details: says });
  return { says, refused: false, posted, alreadyHeld, matched };
}
