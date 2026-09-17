import "server-only";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
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

/**
 * What the remittances have taught that nobody has written down yet.
 *
 * The owner, 16 September 2026: "does our system get smarter and learn to attach bin/pcn or scripts
 * to payors once we start getting more 835s?? the system needs to learn."
 *
 * It did not. There is a store of links and it works — 141 of them, naming 1,242 of September's
 * claims — but every one was taught by a person confirming a candidate. An 835 arriving, naming its
 * payer, and settling a claim whose BIN nobody has ever identified taught the site nothing at all.
 * Measured the same afternoon: 63 September claims carrying $1,725.59 had no settled payer name,
 * and each one is a claim that cannot be chased because nobody knows who to chase.
 *
 * A remittance is a better witness than a search. The payer named itself, paid a specific claim, and
 * the claim carries the identifiers it was billed under; the association is a fact, not a guess.
 *
 * ── The three things it refuses to do ──
 *
 * It never overwrites a link a person confirmed. A human decision outranks a machine's inference
 * every time, and the failure of getting this backwards is silent — an appeal filed against the
 * wrong agreement.
 *
 * It never names a claim that already has a settled name. The point is the gaps, and a remittance's
 * payer name is the payer, which is not always the plan the claim was billed to.
 *
 * And it refuses where two payers have paid claims on the same key. That is the shape of a processor
 * fronting several plans, which is precisely the case where a single name would be wrong, so it
 * leaves those for a person and says how many it left.
 *
 * Pure, so what it would learn can be examined before any of it is stored.
 */
export type LearnedFrom = { key: ClaimKey; payer: string };

/**
 * Whether a name on a remittance is somebody moving money for a plan, rather than the plan itself.
 *
 * The check that stopped this feature being worse than not having it — one pass too late.
 *
 * Written, deployed, and only then asked what it would teach against the live data. The answer was
 * one link: a BIN belongs to "Health Mart Atlas". I reported that nothing had been written because
 * the pass had not run. It had run, at 17:10, twenty minutes earlier, and the setting that says so
 * was one query away: **1 payer link learned, 3 claims named.** Three of his claims spent the night
 * under the name of their courier, and the sentence telling him they had not was mine.
 *
 * `unlearnCourierLinks` takes it back, nightly and for nothing.
 *
 * Health Mart Atlas does not owe this pharmacy anything. It is the PSAO the money travels through,
 * and its own payment report names the real plan in a sentence beside the figure — Caremark, Prime
 * Therapeutics, MedImpact. Every payer name on file today is one of these: ProviderPay, Health Mart
 * Atlas, RedSail, the Medicare facilitator. So a learner that trusted the payer field would have
 * quietly renamed unidentified claims after their courier, and a wrong name that looks settled is
 * worse than an honest blank — the blank gets asked about.
 *
 * So today this learns nothing, which is the true answer, and it starts learning the day a plan
 * sends its own 835 under its own name. That is the shape the owner asked for: "the system needs to
 * learn" — from evidence, and not from whatever string happens to be in a field.
 */
export function routesMoneyForOthers(payer: string): boolean {
  return /provider\s*pay|health\s*mart|access\s*health|redsail|veridikal|transaction\s*facilit|rxrescue|aytu|psao/i.test(payer);
}

export function linksToLearn(
  paid: { key: ClaimKey; payer: string | null }[],
  existing: Pick<PayerLinkRow, "bin" | "pcn" | "groupNumber" | "contractId">[],
): { learn: LearnedFrom[]; conflicting: number } {
  const byKey = new Map<string, { key: ClaimKey; payers: Set<string> }>();
  for (const p of paid) {
    const name = (p.payer ?? "").trim();
    if (!name) continue;
    /* A courier is not a payer. See `routesMoneyForOthers`, and what asking the live data cost to find out. */
    if (routesMoneyForOthers(name)) continue;
    /* The same rule `savePayerLink` enforces: a key with nothing in it would match every claim. */
    if (!norm(p.key.bin) && !norm(p.key.groupNumber) && !norm(p.key.contractId)) continue;
    /* Already known, however it was learned. */
    if (linkFor(existing as PayerLinkRow[], p.key)) continue;
    const id = [norm(p.key.bin), norm(p.key.pcn), norm(p.key.groupNumber), norm(p.key.contractId)].join("|");
    const cur = byKey.get(id) ?? { key: p.key, payers: new Set<string>() };
    cur.payers.add(name);
    byKey.set(id, cur);
  }
  const learn: LearnedFrom[] = [];
  let conflicting = 0;
  for (const { key, payers } of byKey.values()) {
    if (payers.size === 1) learn.push({ key, payer: [...payers][0] });
    else conflicting++;
  }
  return { learn, conflicting };
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

/**
 * Learns from the remittances already on file, and names the claims nobody could name.
 *
 * Runs on the nightly tick, so every 835 that arrives makes the next unnamed claim more likely to
 * be named without anybody doing anything. Idempotent: a key already linked is skipped, so running
 * it twice learns nothing the second time.
 *
 * Only claims with no settled payer name are offered as evidence — see `linksToLearn` for why, and
 * for the three things it refuses to conclude.
 */
/**
 * Takes back links this learned that it should never have written.
 *
 * It did write one. On 16 September 2026 at 17:10 — twenty minutes before the courier guard was
 * deployed, and while I was telling the owner "nothing was written: the pass had not run" — the
 * nightly pass learned that BIN 005377 belongs to **Health Mart Atlas** and stamped three of his
 * claims with it. Health Mart Atlas is the PSAO the money travels through. It owes this pharmacy
 * nothing, and three claims were sitting under the name of their courier.
 *
 * I was wrong about it twice over: wrong to ship the learner before asking what it would teach, and
 * wrong again to tell him nothing had happened without checking the one setting that would have
 * said so. The guard stops the next one. This undoes the last one, because a machine that can be
 * wrong and cannot take it back is a machine nobody should let near a ledger.
 *
 * Only ever its own rows: `confirmedBy` is "an 835" on a link this wrote and a person's name on a
 * link they wrote, and a human decision is never touched here whatever it says.
 */
export async function unlearnCourierLinks(): Promise<{ removed: number; names: string[] }> {
  const mine = (await allPayerLinks()).filter((l) => l.confirmedBy === "an 835" && routesMoneyForOthers(l.pbmName));
  for (const l of mine) {
    await db.delete(schema.payerLinks).where(eq(schema.payerLinks.id, l.id));
    /*
     * And the claims it stamped, back to unresolved rather than to some other guess. "Nobody knows"
     * is the true state and it is the state that gets asked about; a courier's name looks settled
     * and would never be questioned again.
     */
    await db
      .update(schema.claims)
      .set({ pbmName: null, matchMethod: "unresolved" })
      .where(and(eq(schema.claims.pbmName, l.pbmName), eq(schema.claims.matchMethod, "confirmed_link")));
  }
  return { removed: mine.length, names: [...new Set(mine.map((l) => l.pbmName))] };
}

export async function learnLinksFromRemittances(): Promise<{ learned: number; conflicting: number; claimsNamed: number; unlearned: number }> {
  /* Anything it got wrong before the guard existed comes out first, every night, for nothing. */
  const undone = await unlearnCourierLinks();

  const rows = await db
    .select({
      bin: schema.claims.bin,
      pcn: schema.claims.pcn,
      groupNumber: schema.claims.groupNumber,
      contractId: schema.claims.networkId,
      pbmName: schema.claims.pbmName,
      matchMethod: schema.claims.matchMethod,
      payer: schema.claimPayments.payer,
      source: schema.claimPayments.source,
      claimId: schema.claimPayments.claimId,
    })
    .from(schema.claimPayments)
    .innerJoin(schema.claims, eq(schema.claimPayments.claimId, schema.claims.id));

  /*
   * The gaps only. A claim the site can already name is not evidence about anything: the remittance
   * names the payer that paid, which is not always the plan the claim was billed to, and overwriting
   * a working name with it would lose more than it found.
   */
  const unnamed = rows.filter(
    (r) =>
      /* A facilitator's or programme's payment names the route, never the plan. */
      r.source === "plan" && (!(r.pbmName ?? "").trim() || r.matchMethod === "unresolved" || r.matchMethod === "none"),
  );
  const existing = await allPayerLinks();
  const { learn, conflicting } = linksToLearn(
    unnamed.map((r) => ({ key: { bin: r.bin, pcn: r.pcn, groupNumber: r.groupNumber, contractId: r.contractId }, payer: r.payer })),
    existing,
  );

  for (const l of learn) {
    await db.insert(schema.payerLinks).values({
      id: newId(),
      bin: norm(l.key.bin),
      pcn: norm(l.key.pcn),
      groupNumber: norm(l.key.groupNumber),
      contractId: norm(l.key.contractId),
      pbmName: l.payer,
      contractDocId: null,
      contractFileName: null,
      /* Said plainly on the row, because a person has to be able to tell a machine's inference from their own decision and undo it. */
      basis: "Learned from a remittance: this payer paid a claim billed under these identifiers, and nothing else had named it.",
      confirmedBy: "an 835",
      confirmedOn: new Date().toISOString(),
    });
  }

  const applied = learn.length > 0 ? await applyLinksToClaims() : { claims: 0 };
  return { learned: learn.length, conflicting, claimsNamed: applied.claims, unlearned: undone.removed };
}
