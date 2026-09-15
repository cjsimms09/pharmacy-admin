import "server-only";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { newId } from "./crypto";

/**
 * Remembering which payer and which contract a claim's identifiers belong to.
 *
 * The first version searched the contracts on every page load: it found the answer, showed it, and
 * forgot it. Twenty PDFs read again next time, and nobody's decision written down anywhere. A
 * search produces a candidate; a person confirms it; this is where the confirmation lives, and
 * every screen afterwards reads it instead of searching.
 *
 * ── What makes a key ──
 *
 * A BIN identifies a processor, not a plan. One BIN can front a dozen employers on a dozen
 * different contracts, which is exactly the case where getting it wrong matters — an appeal filed
 * against the wrong agreement is worse than no appeal. So a link is keyed on as much as the claim
 * actually carried: BIN, and where they exist the PCN, the group number and the network or contract
 * id. The most specific link that matches wins, and a link with nulls in it is the general case for
 * a processor running one contract.
 */

export type PayerLinkRow = typeof schema.payerLinks.$inferSelect;

export type ClaimKey = {
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  contractId: string | null;
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase() || null;

/**
 * How well a link matches a claim, or null where it does not match at all.
 *
 * A field the link leaves null matches anything; a field it sets must agree. The score is how many
 * fields it pinned down, so the most specific link wins — the row naming BIN, group and contract id
 * beats the row naming only the BIN, which is the whole point of keeping both.
 */
export function matchScore(link: Pick<PayerLinkRow, "bin" | "pcn" | "groupNumber" | "contractId">, key: ClaimKey): number | null {
  let score = 0;
  const pairs: [string | null, string | null][] = [
    [norm(link.bin), norm(key.bin)],
    [norm(link.pcn), norm(key.pcn)],
    [norm(link.groupNumber), norm(key.groupNumber)],
    [norm(link.contractId), norm(key.contractId)],
  ];
  for (const [want, got] of pairs) {
    if (want === null) continue;
    if (want !== got) return null;
    score++;
  }
  // A link that pins nothing down matches every claim, which is never what anybody meant.
  return score === 0 ? null : score;
}

/** The link that applies to a claim: the most specific one that matches. */
export function linkFor(links: PayerLinkRow[], key: ClaimKey): PayerLinkRow | null {
  let best: { row: PayerLinkRow; score: number } | null = null;
  for (const row of links) {
    const score = matchScore(row, key);
    if (score === null) continue;
    if (!best || score > best.score) best = { row, score };
  }
  return best?.row ?? null;
}

export async function allPayerLinks(): Promise<PayerLinkRow[]> {
  return db.query.payerLinks.findMany();
}

/**
 * Records a link, replacing any earlier one with the same key.
 *
 * Replaced rather than versioned: this is not a record of something that happened, it is somebody's
 * current answer to "who is this". A wrong one should be correctable without leaving the wrong
 * answer on file to be read by something else.
 */
export async function savePayerLink(
  key: ClaimKey,
  input: { pbmName: string; contractDocId?: string | null; contractFileName?: string | null; basis?: string | null },
  user: { name: string },
): Promise<{ id: string; replaced: boolean }> {
  const pbmName = input.pbmName.trim();
  if (!pbmName) throw new Error("Give the name of the PBM or plan this belongs to.");
  if (!norm(key.bin) && !norm(key.groupNumber) && !norm(key.contractId)) {
    throw new Error("A link needs at least a BIN, a group number or a contract id — otherwise it would match every claim.");
  }

  const held = await allPayerLinks();
  const same = held.find(
    (r) =>
      norm(r.bin) === norm(key.bin) &&
      norm(r.pcn) === norm(key.pcn) &&
      norm(r.groupNumber) === norm(key.groupNumber) &&
      norm(r.contractId) === norm(key.contractId),
  );
  const values = {
    bin: norm(key.bin),
    pcn: norm(key.pcn),
    groupNumber: norm(key.groupNumber),
    contractId: norm(key.contractId),
    pbmName,
    contractDocId: input.contractDocId ?? null,
    contractFileName: input.contractFileName ?? null,
    basis: input.basis?.trim() || null,
    confirmedBy: user.name,
    confirmedOn: new Date().toISOString(),
  };
  if (same) {
    await db.update(schema.payerLinks).set(values).where(eq(schema.payerLinks.id, same.id));
    return { id: same.id, replaced: true };
  }
  const id = newId();
  await db.insert(schema.payerLinks).values({ id, ...values });
  return { id, replaced: false };
}

export async function deletePayerLink(id: string): Promise<void> {
  await db.delete(schema.payerLinks).where(eq(schema.payerLinks.id, id));
}

/**
 * Applies every link to the claims already held, so naming something fixes the past as well.
 *
 * Confirming a link and leaving last month's claims unattributed is half a job: the reason to
 * settle who a payer is, is to ask what that payer pays, and that question is asked of claims
 * already on file.
 */
export async function applyLinksToClaims(): Promise<{ claims: number }> {
  const [links, claims] = await Promise.all([allPayerLinks(), db.query.claims.findMany({ columns: { id: true, bin: true, pcn: true, groupNumber: true, networkId: true, pbmName: true } })]);
  if (links.length === 0) return { claims: 0 };
  let touched = 0;
  for (const c of claims) {
    const hit = linkFor(links, { bin: c.bin, pcn: c.pcn, groupNumber: c.groupNumber, contractId: c.networkId });
    if (!hit || c.pbmName === hit.pbmName) continue;
    await db.update(schema.claims).set({ pbmName: hit.pbmName, matchMethod: "confirmed_link", payerAmbiguous: false }).where(eq(schema.claims.id, c.id));
    touched++;
  }
  return { claims: touched };
}
