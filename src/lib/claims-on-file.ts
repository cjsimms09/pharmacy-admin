import "server-only";
import { inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { ClaimOnFile, TiedPayment } from "./match-remittance";

/** A claim the site holds, as the matcher reads it and as a screen names it. */
export type ClaimHeld = ClaimOnFile & { itemName: string | null; payerLabel: string | null };

/** The first day the claims feed covers: the earliest day any claims import began from. Null where none has been loaded. */
export async function claimsFeedStartsOn(): Promise<string | null> {
  const from = (await db.query.claimImports.findMany({ columns: { periodFrom: true } })).map((i) => i.periodFrom).filter((d): d is string => !!d).sort();
  return from[0] ?? null;
}

export type ClaimsOnFileOptions = {
  /** Say on each claim what is tied to it (`tied`), for reading a take-back. Left off, no claim says, and no take-back is matched to one. */
  withTied?: boolean;
};

/** The amount and source of every payment tied to each of these claims. */
async function tiedTo(claimIds: string[]): Promise<Map<string, TiedPayment[]>> {
  const byClaim = new Map<string, TiedPayment[]>();
  for (let i = 0; i < claimIds.length; i += 400) {
    const rows = await db.query.claimPayments.findMany({
      where: inArray(schema.claimPayments.claimId, claimIds.slice(i, i + 400)),
      columns: { claimId: true, amountCents: true, source: true },
    });
    for (const r of rows) {
      if (r.claimId === null) continue;
      const list = byClaim.get(r.claimId) ?? [];
      list.push({ amountCents: r.amountCents, source: r.source });
      byClaim.set(r.claimId, list);
    }
  }
  return byClaim;
}

/**
 * Every claim the site holds for each of the given prescriptions, paid and reversed, in the shape the matcher reads
 * (match-remittance.ts). One place, so the matcher that attaches a payment and the screen that says why one is not
 * attached read the same rows the same way.
 */
export async function claimsOnFile(rxNumbers: string[], opts: ClaimsOnFileOptions = {}): Promise<Map<string, ClaimHeld[]>> {
  const byRx = new Map<string, ClaimHeld[]>();
  const rx = [...new Set(rxNumbers)];
  for (let i = 0; i < rx.length; i += 400) {
    const rows = await db.query.claims.findMany({
      where: inArray(schema.claims.rxNumber, rx.slice(i, i + 400)),
      columns: { id: true, rxNumber: true, fillNumber: true, dateFilled: true, ndc11: true, status: true, bin: true, remitCents: true, expectedFacilitatorCents: true, evoucherCents: true, evoucherMessageCents: true, soldOn: true, itemName: true, payerLabel: true },
    });
    const tied = opts.withTied ? await tiedTo(rows.map((r) => r.id)) : null;
    for (const r of rows) {
      const list = byRx.get(r.rxNumber) ?? [];
      list.push({
        id: r.id,
        fillNumber: r.fillNumber,
        dateFilled: r.dateFilled,
        ndc11: r.ndc11,
        bin: r.bin,
        remitCents: r.remitCents,
        facilitatorCents: r.expectedFacilitatorCents ?? null,
        /* Which of a coordinated fill's two rows a manufacturer programme could be paying. */
        carriesVoucher: (r.evoucherCents ?? 0) > 0 || (r.evoucherMessageCents ?? 0) > 0,
        status: r.status,
        soldOn: r.soldOn,
        itemName: r.itemName,
        payerLabel: r.payerLabel,
        ...(tied ? { tied: tied.get(r.id) ?? [] } : {}),
      });
      byRx.set(r.rxNumber, list);
    }
  }
  return byRx;
}
