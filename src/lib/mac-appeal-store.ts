import "server-only";
import { db, schema } from "@/db";
import { and, eq, gte, isNotNull } from "drizzle-orm";
import { todayIso } from "./dates";
import { isOutOfBooks } from "./books-start";
import { worklist, type Candidate, type PayerTerms, type Worklist } from "./mac-appeal-candidates";

/**
 * The MAC appeal worklist, loaded from the database.
 *
 * The deciding is in `mac-appeal-candidates.ts` and is pure. This is only the loading: which claims
 * to consider, what each payer's terms are, and which claims already have an appeal.
 *
 * ── Why it runs off claims and not remittances ──
 *
 * Caremark allows ten calendar days from the initial claim. An 835 arrives weeks later, so a system
 * that waits for the remittance to reveal an underpayment has already missed every Caremark window
 * it will ever see. The claim itself carries what was paid and what the drug cost, which is all an
 * appeal needs.
 *
 * ── Why weekly is enough, and what breaks it ──
 *
 * PioneerRx is a day behind, so a claim filled on the day of a run is not visible until the next
 * one. Worst case is therefore a claim filled on a Friday, caught the following Friday: day seven of
 * ten, with three days spare. The owner worked this out and he is right.
 *
 * What breaks it is a *missed* run. Skip one week and the next lands on day fourteen, and the whole
 * batch is out of time. So `missedRun` below exists to say so loudly rather than quietly filing
 * nothing.
 */

/** How far back to look. Generous: the longest window on file is a year. */
const LOOK_BACK_DAYS = 400;

/**
 * Every claim worth judging, with the two facts an appeal turns on.
 *
 * `acquisitionCents` comes from PioneerRx, which is the pharmacy's own record of what it paid. The
 * invoice is the evidence a PBM will ask for, and whether one exists is a separate question asked at
 * filing time — a claim with no invoice is still worth showing, because the invoice may simply not
 * have been loaded yet.
 */
async function loadCandidates(from: string): Promise<Candidate[]> {
  const rows = await db
    .select({
      claimId: schema.claims.id,
      rxNumber: schema.claims.rxNumber,
      fillNumber: schema.claims.fillNumber,
      dateFilled: schema.claims.dateFilled,
      ndc11: schema.claims.ndc11,
      drugName: schema.claims.itemName,
      bin: schema.claims.bin,
      pcn: schema.claims.pcn,
      groupNumber: schema.claims.groupNumber,
      pbmName: schema.claims.pbmName,
      paidCents: schema.claims.remitCents,
      acquisitionCents: schema.claims.acquisitionCents,
      quantityThousandths: schema.claims.quantityThousandths,
      daysSupply: schema.claims.daysSupply,
      basisOfReimbursement: schema.claims.basisOfReimbursement,
      importId: schema.claims.importId,
    })
    .from(schema.claims)
    .where(and(eq(schema.claims.status, "paid"), gte(schema.claims.dateFilled, from), isNotNull(schema.claims.ndc11)));

  /*
   * Test imports are dropped here as well as in `loadFills`.
   *
   * An appeal filed on a claim pulled to test matching would be an appeal on a month this pharmacy
   * is not accounting for — and it would go to a PBM under the owner's name.
   */
  const testImports = new Set(
    (await db.query.claimImports.findMany({ where: eq(schema.claimImports.outOfBooks, true), columns: { id: true } })).map((i) => i.id),
  );

  /*
   * Brand or generic, from NADAC. Nothing on a claim says which, and MAC lists price generics — the
   * first version of this work produced a candidate list that was almost entirely Wegovy.
   *
   * The row in force on the fill date, not the newest: a drug reclassified since is still whatever
   * it was on the day it was dispensed.
   */
  /*
   * The price comes from here too, and both are read as at the fill date.
   *
   * This used to keep whichever row was newest, which contradicted the paragraph above it. For the
   * classification that is a small error — a drug is rarely reclassified. For the price it would be
   * a real one: NADAC is republished weekly, so the newest figure is the wrong figure for a claim
   * filled a fortnight ago, and the whole point of comparing the two is to tell a MAC sitting under
   * the national average from a plan that simply paid the national average.
   *
   * So the history is kept per NDC and the row in force on the day is picked per claim.
   */
  const ndcs = [...new Set(rows.map((r) => r.ndc11).filter((n): n is string => n !== null))];
  const history = new Map<string, { on: string; cls: string | null; unitMicros: number | null }[]>();
  if (ndcs.length > 0) {
    const prices = await db.query.nadacPrices.findMany({
      columns: { ndc11: true, classification: true, effectiveOn: true, unitMicros: true },
    });
    const wanted = new Set(ndcs);
    for (const p of prices) {
      if (!wanted.has(p.ndc11)) continue;
      const list = history.get(p.ndc11) ?? [];
      list.push({ on: p.effectiveOn, cls: p.classification ?? null, unitMicros: p.unitMicros ?? null });
      history.set(p.ndc11, list);
    }
    for (const list of history.values()) list.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
  }
  /** The newest NADAC row effective on or before the fill date. */
  const asAt = (ndc11: string | null, on: string) => {
    const list = ndc11 ? history.get(ndc11) : undefined;
    if (!list) return null;
    let found: { on: string; cls: string | null; unitMicros: number | null } | null = null;
    for (const row of list) {
      if (row.on > on) break;
      found = row;
    }
    return found;
  };

  return rows
    .filter((r) => !testImports.has(r.importId))
    .filter((r) => r.paidCents !== null)
    .map((r) => ({
      claimId: r.claimId,
      rxNumber: r.rxNumber,
      fillNumber: r.fillNumber,
      dateFilled: r.dateFilled,
      ndc11: r.ndc11!,
      drugName: r.drugName,
      bin: r.bin,
      pcn: r.pcn,
      groupNumber: r.groupNumber,
      pbmName: r.pbmName ?? "(unnamed)",
      paidCents: r.paidCents!,
      acquisitionCents: r.acquisitionCents,
      quantityThousandths: r.quantityThousandths,
      daysSupply: r.daysSupply,
      basisOfReimbursement: r.basisOfReimbursement,
      classification: asAt(r.ndc11, r.dateFilled)?.cls ?? null,
      /* Micros to cents: NADAC is published to six places because a tablet can cost a third of a cent. */
      nadacPerUnitCents: (() => {
        const micros = asAt(r.ndc11, r.dateFilled)?.unitMicros ?? null;
        return micros === null ? null : micros / 10_000;
      })(),
    }));
}

async function loadTerms(): Promise<PayerTerms[]> {
  const rows = await db.query.macAppealTerms.findMany();
  return rows.map((t) => ({
    pbmName: t.pbmName,
    whoFiles: t.whoFiles ?? null,
    appealWindowDays: t.appealWindowDays ?? null,
    windowBasis: t.windowBasis ?? null,
    channel: t.submissionChannel ?? null,
    target: t.submissionTarget ?? null,
  }));
}

/**
 * Claims that already have a MAC appeal.
 *
 * Every status counts, including withdrawn and lost. Re-filing a claim a PBM has already rejected is
 * how a pharmacy's appeals stop being read.
 */
async function loadAppealed(): Promise<Set<string>> {
  const rows = await db.query.appeals.findMany({
    where: eq(schema.appeals.kind, "mac_appeal"),
    columns: { claimId: true },
  });
  return new Set(rows.map((r) => r.claimId).filter((id): id is string => id !== null));
}

/** The whole worklist, ready for a screen or an alert. */
export async function macAppealWorklist(today = todayIso()): Promise<Worklist> {
  const from = new Date(Date.parse(today + "T00:00:00Z") - LOOK_BACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const [candidates, terms, appealed] = await Promise.all([loadCandidates(from), loadTerms(), loadAppealed()]);
  return worklist(candidates, terms, appealed, today);
}

/**
 * Whether a weekly run has been missed, which is the one thing that makes weekly filing unsafe.
 *
 * Nine days rather than seven: a run a day or two late is ordinary and not worth shouting about,
 * while nine days means a whole slot was skipped and the tightest window — Caremark's ten days — is
 * about to lapse on anything filed at the start of it.
 */
export async function missedRun(today = todayIso()): Promise<{ missed: boolean; lastRun: string | null; daysSince: number | null; says: string }> {
  const { getSettings } = await import("./settings");
  const lastRun = (await getSettings()).mac_appeal_last_run || null;
  if (!lastRun) {
    return {
      missed: false,
      lastRun: null,
      daysSince: null,
      says: "No appeal run has been recorded yet, so there is nothing to have missed.",
    };
  }
  const daysSince = Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(lastRun + "T00:00:00Z")) / 86_400_000);
  const missed = daysSince >= 9;
  return {
    missed,
    lastRun,
    daysSince,
    says: missed
      ? `The last appeal run was ${lastRun}, ${daysSince} days ago. A week was skipped, and Caremark only allows ten days from the fill — anything from the start of that gap is close to out of time or already past it.`
      : `Last appeal run: ${lastRun}, ${daysSince} day${daysSince === 1 ? "" : "s"} ago.`,
  };
}

/** Remember that a run happened, so a skipped week can be noticed. */
export async function recordRun(today = todayIso()): Promise<void> {
  const { setSetting } = await import("./settings");
  await setSetting("mac_appeal_last_run", today);
}

/**
 * Record an appeal as filed.
 *
 * The unique index on `claim_id` means a second attempt on the same claim fails at the database
 * rather than quietly creating a duplicate — the owner's rule, made structural: "it also should
 * record once filed so that it doesnt duplicate request or alerts". The conflict is caught and
 * reported as already-filed rather than thrown, because a retry after a timeout is ordinary and is
 * not an error worth stopping a batch for.
 */
export async function recordFiled(input: {
  claimId: string;
  rxNumber: string;
  fillNumber: number | null;
  dateFilled: string;
  ndc11: string;
  pbmName: string;
  shortfallCents: number;
  deadline: string | null;
  channel: string;
  target: string | null;
  /** The PBM's own reference, where it gives one back. What a chase quotes. */
  confirmation: string | null;
  user: { id: string; name: string };
}): Promise<{ filed: boolean; why: string }> {
  const { newId } = await import("./crypto");
  const now = new Date().toISOString();

  if (isOutOfBooks(input.dateFilled)) {
    return { filed: false, why: "That claim is from before the books begin, so it is test data and must not be appealed." };
  }

  try {
    await db.insert(schema.appeals).values({
      id: newId(),
      kind: "mac_appeal",
      claimId: input.claimId,
      rxNumber: input.rxNumber,
      fillNumber: input.fillNumber,
      dateFilled: input.dateFilled,
      ndc11: input.ndc11,
      pbmName: input.pbmName,
      shortfallCents: input.shortfallCents,
      deadline: input.deadline,
      status: "sent",
      channel: input.channel,
      target: input.target,
      packetJson: JSON.stringify({ confirmation: input.confirmation, filedBy: input.user.name }),
      sentAt: now,
      sentBy: input.user.name,
      sendResult: input.confirmation ? `Accepted, reference ${input.confirmation}` : "Submitted; no reference given",
      createdBy: input.user.id,
    });
    return { filed: true, why: `Recorded as filed with ${input.pbmName}.` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE|constraint/i.test(msg)) {
      return { filed: false, why: "That claim already has an appeal on file, so nothing was recorded a second time." };
    }
    throw e;
  }
}
