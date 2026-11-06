import "server-only";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { newId } from "./crypto";

/**
 * The BINs this pharmacy actually bills that nothing here can name.
 *
 * The claims importer prints them at the end of an import line — "BINs not on the listing: 003858,
 * 004336, 005377 …" — and that line scrolls away. Eighteen payers the site cannot name is not a
 * footnote to an import: it is eighteen payers whose reimbursement cannot be grouped, whose MAC
 * appeals have no help-desk number, and whose contract cannot be found when a rate looks wrong.
 *
 * So the gap is a list, ordered by the money behind it, with somewhere to close each one. A BIN
 * billed once last Tuesday and a BIN carrying a fifth of the pharmacy's revenue are not the same
 * problem, and a list that treats them alike gets read once.
 *
 * Nothing here guesses what a BIN belongs to. A BIN wrongly attributed is worse than an unnamed
 * one: an appeal sent to the wrong PBM is not merely wasted, it is a rate the pharmacy then
 * believes it has challenged.
 */

export type UnknownBin = {
  bin: string;
  claims: number;
  /** What those claims were reimbursed, in cents. */
  receivedCents: number;
  /** The payer name as the claim itself carried it, where it carried one. */
  labels: string[];
  firstSeen: string | null;
  lastSeen: string | null;
};

export async function unknownBins(): Promise<UnknownBin[]> {
  const [claims, bins] = await Promise.all([
    db.query.claims.findMany({
      columns: { bin: true, pbmName: true, payerLabel: true, remitCents: true, copayCents: true, dateFilled: true },
    }),
    db.query.payerBins.findMany({ columns: { bin: true } }),
  ]);
  const known = new Set(bins.map((b) => b.bin));

  const by = new Map<string, UnknownBin>();
  for (const c of claims) {
    const bin = (c.bin ?? "").trim();
    if (!bin || known.has(bin)) continue;
    // A claim the resolver already named some other way is not a gap.
    if (c.pbmName) continue;
    let e = by.get(bin);
    if (!e) {
      e = { bin, claims: 0, receivedCents: 0, labels: [], firstSeen: null, lastSeen: null };
      by.set(bin, e);
    }
    e.claims++;
    e.receivedCents += (c.remitCents ?? 0) + (c.copayCents ?? 0);
    const label = (c.payerLabel ?? "").trim();
    if (label && !e.labels.includes(label)) e.labels.push(label);
    const on = c.dateFilled ?? null;
    if (on && (!e.firstSeen || on < e.firstSeen)) e.firstSeen = on;
    if (on && (!e.lastSeen || on > e.lastSeen)) e.lastSeen = on;
  }
  return [...by.values()].sort((a, b) => b.receivedCents - a.receivedCents || b.claims - a.claims);
}

/**
 * Names a BIN, and re-attributes the claims already held under it.
 *
 * Naming it and leaving last month's claims unattributed would be half the job: the reason to name
 * a BIN is to be able to ask what that payer pays, and that question is asked of claims already
 * held. So the rows are updated in the same breath, and the count of them is reported — which is
 * also the check that the name reached anything.
 */
export async function nameBin(
  bin: string,
  pbmName: string,
  extra: { helpDesk?: string | null; notes?: string | null },
  user: { name: string },
): Promise<{ claims: number }> {
  const b = bin.replace(/\D/g, "");
  const name = pbmName.trim();
  if (!b) throw new Error("Give the BIN as it appears on the claim.");
  if (!name) throw new Error("Give the name of the PBM or plan that BIN belongs to.");

  const existing = await db.query.payerBins.findFirst({ where: eq(schema.payerBins.bin, b) });
  if (existing) {
    await db.update(schema.payerBins).set({ pbmName: name, helpDesk: extra.helpDesk?.trim() || existing.helpDesk, notes: extra.notes?.trim() || existing.notes }).where(eq(schema.payerBins.id, existing.id));
  } else {
    await db.insert(schema.payerBins).values({
      id: newId(),
      bin: b,
      pbmName: name,
      helpDesk: extra.helpDesk?.trim() || null,
      notes: [extra.notes?.trim(), `Named by ${user.name} from a claim, not from the published listing.`].filter(Boolean).join(" "),
    });
  }

  const rows = await db.query.claims.findMany({ columns: { id: true, bin: true, pbmName: true } });
  let touched = 0;
  for (const c of rows) {
    if ((c.bin ?? "").trim() !== b || c.pbmName) continue;
    await db.update(schema.claims).set({ pbmName: name }).where(eq(schema.claims.id, c.id));
    touched++;
  }
  return { claims: touched };
}
