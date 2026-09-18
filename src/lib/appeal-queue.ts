/**
 * Which claims are worth a MAC appeal, priced from what the site holds.
 *
 * The packet builder (`appeal-packet.ts`) assembles one appeal from six facts. This decides which
 * claims get a packet at all: every paid third-party claim is priced against the contract rate on
 * file for its PBM (the row for its network id where one is named, else the PBM's one row), with
 * the benchmarks the site has — NADAC in force on the fill date, the AWP the claim printed, the
 * invoice line nearest the fill — and a packet is built for each one paid under the contract
 * figure. The queue is the packets that can be sent today, and, apart from them, the reasons the
 * rest cannot, counted, so the owner sees what one fix would unlock.
 *
 * Pure.
 */
import { parseFormula, expectedCents } from "./rate-formula";
import { buildPacket, type AppealClaim, type AppealTerms, type Invoice, type Packet } from "./appeal-packet";

export type QueueClaim = AppealClaim & { claimId: string; networkId: string | null; classification: "B" | "G" | null; awpTotalCents: number | null; nadacUnitMicros: number | null };

export type RateRow = {
  pbmName: string;
  network: string;
  lineOfBusiness: string;
  brandRate: string | null;
  genericRate: string | null;
  /** The days the row is in force; null at either end means open. A claim outside them is not priced on it. */
  effectiveDate?: string | null;
  effectiveTo?: string | null;
  /** "superseded" once a later document replaced this one; such a row prices nothing. */
  status?: string | null;
};

export type QueueRow = {
  claim: QueueClaim;
  packet: Packet;
  formulaText: string | null;
  /** The rate row used, for the audit trail. */
  rateNetwork: string | null;
};

export type Queue = {
  ready: QueueRow[];
  /** Paid under the contract figure but not sendable, with the reasons. */
  held: QueueRow[];
  /** Priced and paid at or above the contract figure. Counted, not listed. */
  paidToRate: number;
  /** Could not be priced at all: no rate row, unreadable formula, no benchmark, no quantity. */
  unpriced: number;
  readyCents: number;
  heldCents: number;
  /** Each reason a packet was held, with how many claims and how much it holds back. */
  reasons: { reason: string; claims: number; cents: number }[];
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** The rate row for a claim: its network id's row where named, else the PBM's single row. */
export function rateFor(rates: RateRow[], claim: { pbmName: string; networkId: string | null; dateFilled?: string | null }): RateRow | null {
  const day = claim.dateFilled ?? null;
  /*
   * Only rows in force on the day the claim was filled, and never one a later document replaced.
   * A rate sheet's successor applied to last year's claim, or last year's applied to this one, is
   * an appeal citing the wrong exhibit.
   */
  const inForce = (r: RateRow) =>
    r.status !== "superseded" && (!day || ((!r.effectiveDate || r.effectiveDate <= day) && (!r.effectiveTo || r.effectiveTo >= day)));
  const mine = rates.filter((r) => norm(r.pbmName) === norm(claim.pbmName) && inForce(r));
  if (mine.length === 0) return null;
  if (claim.networkId) {
    const hit = mine.find((r) => norm(r.network).includes(norm(claim.networkId)) || norm(claim.networkId).includes(norm(r.network)));
    if (hit) return hit;
  }
  if (mine.length === 1) return mine[0];
  // Several rows and no network id on the claim: which contract priced it is not known, and a
  // guess here is an appeal citing the wrong rate. Counted as unpriced instead.
  return null;
}

export function buildQueue(input: {
  claims: QueueClaim[];
  rates: RateRow[];
  terms: Map<string, AppealTerms>;
  /** The invoice line nearest each claim's fill date, per claim id. */
  invoices: Map<string, Invoice>;
  today: string;
  pharmacy: { name: string; ncpdp: string | null; npi: string | null };
  /** Claim ids that already have an appeal, so nothing is appealed twice. */
  appealed: Set<string>;
  minShortfallCents?: number;
}): Queue {
  const ready: QueueRow[] = [];
  const held: QueueRow[] = [];
  let paidToRate = 0;
  let unpriced = 0;
  const reasons = new Map<string, { claims: number; cents: number }>();

  for (const c of input.claims) {
    if (input.appealed.has(c.claimId)) continue;
    const rate = rateFor(input.rates, c);
    const text = rate ? (c.classification === "B" ? rate.brandRate : rate.genericRate) ?? rate.genericRate ?? rate.brandRate : null;
    const formula = parseFormula(text);
    const units = c.quantityThousandths ? c.quantityThousandths / 1000 : null;
    const expected = expectedCents(formula, c.quantityThousandths, {
      nadacMicros: c.nadacUnitMicros,
      awpMicros: c.awpTotalCents != null && units ? Math.round((c.awpTotalCents * 10_000) / units) : null,
    });
    if (expected.totalCents == null) {
      unpriced++;
      continue;
    }
    if (expected.totalCents - c.paidCents < (input.minShortfallCents ?? 300)) {
      paidToRate++;
      continue;
    }
    const terms = input.terms.get(norm(c.pbmName)) ?? null;
    const packet = buildPacket({
      claim: c,
      terms,
      expected: { totalCents: expected.totalCents, atMost: expected.atMost, why: expected.why, formulaText: formula.kind === "priced" ? formula.text : null },
      invoice: input.invoices.get(c.claimId) ?? null,
      today: input.today,
      minShortfallCents: input.minShortfallCents,
      pharmacy: input.pharmacy,
    });
    const row: QueueRow = { claim: c, packet, formulaText: formula.kind === "priced" ? formula.text : null, rateNetwork: rate?.network ?? null };
    if (packet.ok) ready.push(row);
    else {
      held.push(row);
      for (const b of packet.blockers) {
        const key = b.replace(/\d[\d,.]*/g, "N").replace(/for \S+$/, "").replace(/NDC \S+/g, "NDC");
        const e = reasons.get(key) ?? { claims: 0, cents: 0 };
        e.claims++;
        e.cents += packet.shortfallCents;
        reasons.set(key, e);
      }
    }
  }
  const byMoney = (a: QueueRow, b: QueueRow) => b.packet.shortfallCents - a.packet.shortfallCents;
  ready.sort((a, b) => (a.packet.daysLeft ?? 999) - (b.packet.daysLeft ?? 999) || byMoney(a, b));
  held.sort(byMoney);
  return {
    ready,
    held,
    paidToRate,
    unpriced,
    readyCents: ready.reduce((n, r) => n + r.packet.shortfallCents, 0),
    heldCents: held.reduce((n, r) => n + r.packet.shortfallCents, 0),
    reasons: [...reasons.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.cents - a.cents),
  };
}

/** Whether a submission target is an address the mailbox can send to. */
export function emailTarget(channel: string | null, target: string | null): string | null {
  const t = (target ?? "").trim();
  const m = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (!m) return null;
  if (channel && /portal|fax|mail\b|post/i.test(channel) && !/e-?mail/i.test(channel)) return null;
  return m[0];
}

/** The packet as lines for a one-page PDF. */
export function packetLines(p: Packet, title: string): { text: string; bold?: boolean; size?: number; gapBefore?: number }[] {
  const lines: { text: string; bold?: boolean; size?: number; gapBefore?: number }[] = [{ text: title, bold: true, size: 14 }];
  for (const f of p.fields) lines.push({ text: `${f.label}: ${f.value}` });
  lines.push({ text: "Request", bold: true, gapBefore: 8 });
  for (const chunk of p.narrative.match(/.{1,110}(\s|$)/g) ?? [p.narrative]) lines.push({ text: chunk.trim() });
  lines.push({ text: "Enclosed", bold: true, gapBefore: 8 });
  for (const a of p.attachments) lines.push({ text: `• ${a}` });
  if (p.deadline) lines.push({ text: `Appeal window closes ${p.deadline} (${p.deadlineBasis})`, gapBefore: 8 });
  return lines;
}
