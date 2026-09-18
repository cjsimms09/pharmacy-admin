import "server-only";
import { and, eq, gte, like, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./audit";
import { getSettings } from "./settings";
import { carriedForVeridikalRow, claimShares, newRevenueCents } from "./payer-owed";
import { checkRowAgainstClaim, readVeridikalReport, VERIDIKAL_PAYER, type VeridikalProgram, type VeridikalRow } from "./veridikal-report";

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
 * The amount is what Veridikal paid for the claim, its Total Due: the voucher or the manufacturer's ingredient payment,
 * with the fee. It is what settles the programme's share of the claim (`claimShares`, `payer-owed-store.ts`).
 *
 * The revenue is only what the claim did not already carry (`carriedForVeridikalRow`). The claim's net already includes
 * the programme's money and $2.50 for it, so on the claim it belongs to an eVoucher (voucher + $2.50 fee) adds nothing,
 * and a conversion (ingredient + $2.00 fee) adds nothing and leaves $0.50 of the net paid by nobody. That $0.50 is a fee,
 * said here and not yet recorded anywhere: fees as records are still to be built. Where no claim on this site carries the
 * money, all of it is new, as `copay-remit-store.ts` counts a voucher with no claim.
 *
 * The first version counted the fee as revenue on every row, before PioneerRx showed the claim's net carries it.
 *
 * ── Once ──
 *
 * Every row carries Veridikal's own transaction number, distinct on every row, and the reference is
 * `VERIDIKAL|<programme>|<transaction>`. A row whose reference is already held is not posted again.
 */

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
  let newRevenueTotal = 0;
  let compared = 0;
  let agreed = 0;
  let unpaidFeeCents = 0;
  const differ: string[] = [];
  for (const row of p.rows) {
    const reference = veridikalReference(p.program, row);
    if (held.has(reference)) {
      alreadyHeld++;
      continue;
    }
    // What Veridikal paid for the claim: payment and fee together, as its ACH carries them.
    const amountCents = row.totalDueCents;
    if (amountCents === 0) continue;
    const r = await recordClaimPayment(
      {
        rxNumber: row.rxNumber,
        dateFilled: row.fillDate,
        ndc11: row.ndc11,
        bin: row.bin,
        source: "copay_card",
        payer: VERIDIKAL_PAYER[p.program],
        amountCents,
        // Until the claim is known, all of it is new; set below once the matcher has chosen the claim.
        revenueCents: amountCents,
        receivedOn: row.depositOn,
        reference,
        documentId: input.documentId,
        notes: `From Veridikal's ${p.program === "evoucher" ? "eVoucher" : "Denial Conversion"} summary${input.fileName ? ` (${input.fileName})` : ""}, batch ${row.depositOn}, transaction ${row.transaction}: ${money(row.paymentCents)} ${p.program === "evoucher" ? "voucher" : "from the manufacturer"} and a ${money(row.feeCents)} fee.`,
      },
      by,
    );
    posted++;
    postedCents += amountCents;
    /*
     * Whether the claim already carries the money, now that the matcher has chosen the claim. Only the part it does not
     * carry is new: a voucher $1.00 over the claim's adds $1.00, not the whole row.
     */
    let revenue = amountCents;
    let checkNote = "";
    if (r.matched) {
      matched++;
      const pay = await db.query.claimPayments.findFirst({ where: eq(schema.claimPayments.id, r.id), columns: { claimId: true, notes: true } });
      const claim = pay?.claimId
        ? await db.query.claims.findFirst({
            where: eq(schema.claims.id, pay.claimId),
            columns: { remitCents: true, evoucherCents: true, evoucherMessageCents: true, evoucherProgramme: true, copayCents: true, patientTotalCents: true },
          })
        : null;
      if (claim) {
        revenue = newRevenueCents(amountCents, carriedForVeridikalRow(p.program, row, claim));
        const shares = claimShares(claim);
        if (p.program === "denial_conversion" && shares.kind === "veridikal_conversion" && amountCents > 0) {
          unpaidFeeCents += shares.unpaidFeeCents;
          checkNote += ` ${money(shares.unpaidFeeCents)} of the claim's net is paid by nobody: Veridikal's conversion fee is less than the claim carries. A fee, not yet recorded as one.`;
        }
        const c = checkRowAgainstClaim(p.program, row, claim);
        if (c.compared) {
          compared++;
          if (c.agrees) {
            agreed++;
            checkNote += " Agrees with the claim on file.";
          } else {
            const said = c.differences.map((d) => `${d.what} ${money(d.reportCents)} on the report, ${money(d.claimCents)} on the claim`).join("; ");
            differ.push(`Rx …${row.rxNumber.slice(-3)} filled ${row.fillDate}: ${said}`);
            checkNote += ` Differs from the claim on file: ${said}.`;
          }
        }
      }
      if (checkNote) await db.update(schema.claimPayments).set({ notes: `${pay?.notes ?? ""}${checkNote}` }).where(eq(schema.claimPayments.id, r.id));
    }
    if (revenue !== amountCents) await db.update(schema.claimPayments).set({ revenueCents: revenue }).where(eq(schema.claimPayments.id, r.id));
    newRevenueTotal += revenue;
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
    `${posted} claim payment${posted === 1 ? "" : "s"} posted (${money(postedCents)}), ${matched} matched to a claim on this site, ${money(newRevenueTotal)} of it new revenue beyond what the claims already carry${alreadyHeld ? `; ${alreadyHeld} already held` : ""}. Nothing banked.`,
    unpaidFeeCents ? `${money(unpaidFeeCents)} of the converted claims' nets is paid by nobody (Veridikal's $2.00 conversion fee against the $2.50 each claim carries): a fee, not yet recorded as one.` : "",
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
