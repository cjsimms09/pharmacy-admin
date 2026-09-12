import { chooseClaimForRemittance } from "./match-remittance";
import "server-only";
import nodePath from "node:path";
import { db, schema } from "@/db";
import { eq, inArray, isNull } from "drizzle-orm";
import { newId } from "./crypto";
import type { LaterPayment } from "./fills";
import { formatCents } from "./money";
import { todayIso } from "./dates";
import { isOutOfBooks } from "./books-start";

/**
 * Money that reaches a claim after it was adjudicated.
 *
 * A claim's revenue is not settled on the day it is transmitted. A Medicare Transaction Facilitator
 * payment arrives weeks later. So does a DIR reconciliation, a copay card posted after the fact, or
 * a secondary that adjudicated late. Held only as what the daily report said on the day, every one
 * of those is money the pharmacy received and this system never counted — and a fill sits on the
 * "dispensed at a loss" list because of a payment that has since arrived.
 *
 * Kept as rows of its own rather than added into the claim, because what was paid on the day has to
 * stay distinguishable from what arrived afterwards. That distinction is the whole point when a
 * payer is being judged: the plan paid what the plan paid, and a facilitator payment on top of it
 * is not the plan's money and must not flatter it.
 *
 * Matched on the fill — prescription, fill number, date and NDC — rather than on a claim id,
 * because a remittance names a prescription and this system's ids mean nothing to anybody outside
 * it. It is also the only join that holds where the fill went to two payers and so has two claim
 * rows.
 */

export type RecordPayment = {
  rxNumber: string;
  fillNumber?: number | null;
  dateFilled?: string | null;
  ndc11?: string | null;
  /*
   * Where the money came from. "rxrescue" is the Aytu / IPD top-off programme, which pays by credit
   * memo weeks after the fill and is kept apart from the facilitator so each can be chased on its
   * own terms.
   */
  source: "mtf" | "dir" | "copay_card" | "secondary" | "manual" | "rxrescue" | "plan";
  /**
   * How much of this is money the claim did not already carry. Defaults to the whole amount.
   *
   * Only different where a payment settles something the claim was already adjudicated for — the
   * RxRescue copay assistance being the case this exists for.
   */
  revenueCents?: number;
  payer?: string | null;
  amountCents: number;
  receivedOn?: string | null;
  reference?: string | null;
  /** The document it was read out of, where there is one. What an undo is keyed on. */
  documentId?: string | null;
  notes?: string | null;
  /**
   * The paying BIN, where the remittance names one.
   *
   * What tells two payers on one fill apart. Without it a secondary payer's 835 can be filed
   * against the primary's claim, which leaves the primary looking paid twice and the secondary
   * ageing unsettled.
   */
  bin?: string | null;
};

/**
 * Records a payment, attaching it to the claim it belongs to where one can be found.
 *
 * The claim id is a convenience, not the key: a payment for a prescription this system has not
 * loaded yet is still recorded, and picks up its claim when the claim arrives. Losing money because
 * the remittance beat the daily report would be an ordering nobody outside this code knows about.
 */
export async function recordClaimPayment(p: RecordPayment, user: { name: string }): Promise<{ id: string; matched: boolean; settledReversed: boolean; ambiguous: { count: number; why: string } | null; outOfBooks: boolean }> {
  const rx = p.rxNumber.trim();
  if (!rx) throw new Error("A payment has to name the prescription it is for.");
  if (!Number.isFinite(p.amountCents) || p.amountCents === 0) throw new Error("Give the amount received.");

  const { claim, onlyReversed, ambiguous } = await findClaim(rx, p.fillNumber ?? null, p.dateFilled ?? null, p.ndc11 ?? null, Math.round(p.amountCents), p.bin ?? null);
  const id = newId();
  await db.insert(schema.claimPayments).values({
    id,
    claimId: claim?.id ?? null,
    rxNumber: rx,
    fillNumber: p.fillNumber ?? claim?.fillNumber ?? null,
    dateFilled: p.dateFilled ?? claim?.dateFilled ?? null,
    ndc11: p.ndc11 ?? claim?.ndc11 ?? null,
    source: p.source,
    payer: p.payer ?? null,
    amountCents: Math.round(p.amountCents),
    revenueCents: Math.round(p.revenueCents ?? p.amountCents),
    receivedOn: p.receivedOn ?? null,
    reference: p.reference ?? null,
    documentId: p.documentId ?? null,
    /*
     * Money that arrived before the books begin is recorded and not counted.
     *
     * Every payment this site takes — a remittance, a facilitator file, a hand-typed one — comes
     * through here, which is why the rule is applied here and not at each reader. Put it in the
     * readers and the next reader written will forget it.
     *
     * The owner: "I do not want to track or keep track of payments from before 09/01.. these are
     * test only and should not show up on any AR reports or anything."
     */
    outOfBooks: isOutOfBooks(p.receivedOn),
    notes: [p.notes, onlyReversed ? "The only claim this pharmacy holds for that fill was reversed, so the payment is recorded against no claim. Worth asking the plan what it paid for." : null].filter(Boolean).join(" ") || null,
    recordedBy: user.name,
  });
  return { id, matched: claim !== null, settledReversed: onlyReversed, ambiguous, outOfBooks: isOutOfBooks(p.receivedOn) };
}

/**
 * The claim a payment belongs to, and never a reversed one.
 *
 * `status` was read from the table and never used, so the first claim carrying the prescription
 * number won — reversed or not. A plan settling a fill the pharmacy had reversed would attach to
 * that reversed claim, and a reversed claim carries no revenue, so the money left every figure on
 * the site while looking like an ordinary matched payment. Found by 2 in the copay reader on
 * 9 September; the same query, and the same fault, was here.
 *
 * Paid claims are matched. Where the only claim for the fill was reversed the payment is recorded
 * against no claim and says so, because that is a real thing worth asking the plan about rather
 * than an absence to tidy away.
 */
/**
 * The paid claim a payment belongs to, and where two fit equally well, neither.
 *
 * The choosing is in `match-remittance.ts`, pure and tested. This part is only the lookup: every
 * claim on the prescription, and whether the paid ones are all that is left after reversals.
 */
async function findClaim(
  rxNumber: string,
  fillNumber: number | null,
  dateFilled: string | null,
  ndc11: string | null,
  amountCents: number | null,
  bin: string | null,
): Promise<{ claim: { id: string; fillNumber: number | null; dateFilled: string; ndc11: string | null } | null; onlyReversed: boolean; ambiguous: { count: number; why: string } | null }> {
  const all = await db.query.claims.findMany({
    where: eq(schema.claims.rxNumber, rxNumber),
    columns: { id: true, fillNumber: true, dateFilled: true, ndc11: true, status: true, bin: true, remitCents: true },
  });
  if (all.length === 0) return { claim: null, onlyReversed: false, ambiguous: null };
  const rows = all.filter((r) => r.status === "paid");
  if (rows.length === 0) return { claim: null, onlyReversed: true, ambiguous: null };
  const chosen = chooseClaimForRemittance(
    rows.map((r) => ({ id: r.id, fillNumber: r.fillNumber, dateFilled: r.dateFilled, ndc11: r.ndc11, bin: r.bin, remitCents: r.remitCents })),
    { fillNumber, dateFilled, ndc11, amountCents, bin },
  );
  return { claim: chosen.claim, onlyReversed: false, ambiguous: chosen.ambiguous };
}

/**
 * Every later payment, in the shape the fill grouping takes.
 *
 * Money from before the books begin is left out. This is what the fill grouping is built from,
 * and the fill grouping is what AR, the money page and the payer judgements all read — so a test
 * remittance included here would reach every figure on the site at once.
 */
export async function laterPayments(): Promise<LaterPayment[]> {
  const rows = await db.query.claimPayments.findMany({ where: eq(schema.claimPayments.outOfBooks, false) });
  /*
   * ── Who paid, which is not who the remittance says sent it ──
   *
   * The owner, 11 September: "Provider pay being the payor is a technicality we are going to
   * ignore. The payor is the person actually paying."
   *
   * Every 835 that arrives through ProviderPay names ProviderPay as the payer in its envelope — all
   * 9,550 of them — because ProviderPay is the entity cutting the cheque. It is a settlement
   * service, not a plan, and nothing about this pharmacy's business is described by the answer
   * "ProviderPay owes us $518,125". Worse, it cannot be unpicked at the remittance level: of the 62
   * traces with matched claims, 32 carry claims from several PBMs at once — one contained Caremark,
   * OptumRx and Maxor Plus together — so the remittance genuinely has no single payer to name.
   *
   * The claim does. `claim_payments` holds no BIN of its own, so the payer is taken from the claim
   * this money settled, through the BIN the pharmacy billed — the same rule `payer-owed-store.ts`
   * already applies to receivables, and for the same reason: it is what was billed rather than what
   * the sender called itself.
   *
   * The envelope name is kept as the fallback rather than discarded. Where a payment has no claim
   * behind it there is nothing to resolve through, and "ProviderPay" is then the only true thing
   * that can be said about it — the alternative is a blank, which reads as missing data rather than
   * as money whose prescription this site does not hold.
   */
  const claimIds = [...new Set(rows.map((r) => r.claimId).filter((id): id is string => id !== null))];
  const payerOfClaim = new Map<string, string | null>();
  for (let i = 0; i < claimIds.length; i += 500) {
    const batch = await db.query.claims.findMany({
      where: inArray(schema.claims.id, claimIds.slice(i, i + 500)),
      columns: { id: true, pbmName: true },
    });
    for (const c of batch) payerOfClaim.set(c.id, c.pbmName);
  }
  return rows.map((r) => ({
    rxNumber: r.rxNumber,
    fillNumber: r.fillNumber,
    dateFilled: r.dateFilled,
    ndc11: r.ndc11,
    source: r.source,
    payer: (r.claimId ? payerOfClaim.get(r.claimId) : null) ?? r.payer,
    /*
     * What the pharmacy actually received, for the record and for the screen.
     */
    receivedCents: r.amountCents,
    /*
     * And the part of it that is new money, which is what a margin may be moved by.
     *
     * They differ only where a payment settles something the claim already carried. Using the
     * received figure for both would count the RxRescue copay assistance twice — once when the ACR
     * claim adjudicated it and again when the memo paid it.
     */
    amountCents: r.revenueCents ?? r.amountCents,
  }));
}

/**
 * Attaches payments recorded before their claim arrived.
 *
 * Run after a claims load. Cheap, and it means a remittance that beat the daily report is not money
 * quietly sitting against nothing.
 */
export async function matchOrphanPayments(): Promise<{ matched: number }> {
  /*
   * Test money included, deliberately.
   *
   * This is the matching itself, not a total. Pulling a real month of 835s to see whether they
   * find their claims is exactly what the owner is doing, and a payment excluded here would never
   * match anything — which would make the test always pass by never running. Nothing this writes
   * reaches a figure: the out-of-books flag travels with the row.
   */
  const orphans = await db.query.claimPayments.findMany({ where: isNull(schema.claimPayments.claimId) });
  let matched = 0;
  for (const p of orphans) {
    // A payment waiting for its claim attaches to a paid one or keeps waiting; it never attaches to
    // a reversed claim, which would take the money out of every figure the moment it landed.
    const { claim } = await findClaim(p.rxNumber, p.fillNumber, p.dateFilled, p.ndc11, p.amountCents, null);
    if (!claim) continue;
    await db.update(schema.claimPayments).set({ claimId: claim.id }).where(eq(schema.claimPayments.id, p.id));
    matched++;
  }
  return { matched };
}

/**
 * What has arrived after the day, by where it came from, for a page that has to show it.
 *
 * A payment is only unmatched if there was ever a claim for it to match. The owner:
 *
 * > "can we have it stop alerting if looking for a claim before 09/01?? this system will never
 * > get anything before 09/01.."
 *
 * He is right, and "not yet matched" was the wrong tense for all of it: the daily claims feed
 * begins on the first day this site was given a report, and a copay-card payment against a
 * prescription filled before that has nothing to match to and never will. Counting those as
 * pending made a number that could only ever go up, on a screen whose whole worth is that the
 * numbers on it can be driven to nought.
 *
 * So they are counted apart. The money is the same money and is still shown — it just is not a job.
 */
export async function laterPaymentSummary(): Promise<
  { source: string; payments: number; amountCents: number; unmatched: number; beforeTheFeed: number }[]
> {
  // In-books money only: this is a total the owner reads, not a matching exercise.
  const rows = await db.query.claimPayments.findMany({ where: eq(schema.claimPayments.outOfBooks, false) });
  /*
   * The first day the claims feed covers. Read from the claims themselves rather than set as a
   * date in the code, so it stays true if an earlier month is ever loaded.
   */
  const covered = (await db.query.claimImports.findMany({ columns: { periodFrom: true } }))
    .map((i) => i.periodFrom)
    .filter((d): d is string => !!d)
    .sort()[0] ?? null;
  /*
   * The earliest fill this site holds is not the same question and was the wrong answer.
   *
   * A daily report carries the fills *completed* that day, and a script filled on 3 August and
   * collected in September arrives in a September report — so the claims table reaches back into
   * August and further while the feed itself begins on the first of September. Reading the cutoff
   * off the fills therefore declared eleven payments still matchable when every one of them was for
   * a prescription dispensed months before anything was watching, some as far back as January.
   */
  const earliest = covered;

  const by = new Map<string, { source: string; payments: number; amountCents: number; unmatched: number; beforeTheFeed: number }>();
  for (const r of rows) {
    const e = by.get(r.source) ?? { source: r.source, payments: 0, amountCents: 0, unmatched: 0, beforeTheFeed: 0 };
    e.payments++;
    e.amountCents += r.amountCents;
    if (!r.claimId) {
      const older = earliest !== null && r.dateFilled !== null && r.dateFilled < earliest;
      if (older) e.beforeTheFeed++;
      else e.unmatched++;
    }
    by.set(r.source, e);
  }
  return [...by.values()].sort((a, b) => b.amountCents - a.amountCents);
}

/**
 * Recovers the patient's residual for claims loaded before it was being kept.
 *
 * The daily report's "Total" column was parsed and thrown away, so every claim already held has a
 * patient payment of nothing — which on a deductible fill is the whole of the money. The raw row is
 * stored against each claim, so it can be recovered without asking for the files again.
 */
export async function backfillPatientTotals(): Promise<{ read: number; filled: number }> {
  const rows = await db.query.claims.findMany({ columns: { id: true, rawJson: true, patientTotalCents: true } });
  let filled = 0;
  let read = 0;
  for (const r of rows) {
    if (r.patientTotalCents !== null || !r.rawJson) continue;
    read++;
    try {
      const raw = JSON.parse(r.rawJson) as Record<string, string>;
      const printed = raw["Total"] ?? raw["Patient Total"] ?? raw["patientTotal"];
      if (printed === undefined) continue;
      const n = Number(String(printed).replace(/[$,()\s]/g, ""));
      if (!Number.isFinite(n)) continue;
      const negative = /^\(.*\)$/.test(String(printed).trim());
      await db
        .update(schema.claims)
        .set({ patientTotalCents: Math.round(n * 100) * (negative ? -1 : 1) })
        .where(eq(schema.claims.id, r.id));
      filled++;
    } catch {
      // A row whose raw text cannot be read is left as it was rather than guessed at.
    }
  }
  return { read, filled };
}

/**
 * Loads every remittance in an 835 file and records what each paid against the fills it names.
 *
 * The whole point of the Medicare Transaction Facilitator CLI: it downloads these files on a
 * schedule, and until they are read the money in them reaches the bank and nothing here knows.
 *
 * Loading the same file twice is safe. A payment is identified by the remittance's trace number
 * and the claim's own reference, which is what makes a re-download of the same day harmless —
 * and re-downloading is exactly what a scheduled task does.
 *
 * ── One file, possibly several remittances ──
 *
 * A file is an envelope around one or more ST/SE transaction sets, and each 835 set is a whole
 * remittance with its own payer, trace and total. This used to read a file as a single remittance,
 * which made a bundle of several come out as one remittance from whichever payer was last, with
 * every payer's claims merged into it — and then fail its own balance check, because one payer's
 * BPR total was being set against all of them. A bundled file therefore posted nothing at all.
 *
 * So the file is split first and each remittance is imported on its own terms: banked against its
 * own total, balanced against its own claims, and attributed to the payer named at its own top.
 * The owner: "each 835 has the payor on it doesn't it.. at the top". Now every one of them is read.
 */
export async function importRemittance(
  text: string,
  fileName: string,
  user: { name: string; id?: string },
  opts: {
    /**
     * Record the remittance's total as money banked, by the month it was paid, so the cash account
     * sees it without anybody typing it. Off for the facilitator sweep, which the books already read
     * by received date; on for a remittance dropped in by hand.
     */
    bank?: boolean;
    /** The file behind it, for the receipt's record. */
    documentId?: string | null;
  } = {},
): Promise<{
  payments: number;
  alreadyHeld: number;
  matched: number;
  unmatched: number;
  /** Payments whose only claim for that fill had been reversed. Not matched, and not simply unknown. */
  paidAReversedFill: number;
  /**
   * Lines that fitted more than one paid claim and were left unattached on purpose.
   *
   * A fill billed to two payers is two claim rows with the same prescription, fill, day and drug.
   * Where the BIN and the amount both fail to say which of them this money settles, guessing makes
   * two claims wrong at once. Counted here so the refusal is visible rather than quiet.
   */
  ambiguous: number;
  amountCents: number;
  skipped: number;
  problems: string[];
  payer: string | null;
  paidOn: string | null;
  settles: boolean;
  banked: boolean;
  /**
   * Money the payer kept back from the whole remittance, and which no account yet carries.
   *
   * DIR fees, recoupments, transaction fees. It is the difference between what the claims say and
   * what the bank receives, and both of those figures are individually right — which is why it was
   * invisible until somebody subtracted them. Reported here so the difference is stated at the
   * moment it arrives, rather than discovered later as a hole in the cash account.
   */
  providerAdjustmentCents: number;
  /** How many remittances the file held. One, almost always; more when a sender bundles them. */
  remittances: number;
}> {
  const { parse835Sets } = await import("./x12-835");
  const sets = parse835Sets(text);

  /*
   * The ordinary case, kept as the straight path: one remittance in, one report out.
   *
   * Only a file that genuinely holds several takes the aggregating branch below, so nothing about
   * reading a normal 835 changed and the report a caller gets back is the same object it always was.
   */
  if (sets.length <= 1) {
    const one = await importOneRemittance(sets[0], fileName, user, opts);
    return { ...one, remittances: sets.length };
  }

  /*
   * A bundle. Each remittance is imported on its own, and the report is the file's total.
   *
   * `payer` is the one thing that cannot be summed. Where every remittance in the file came from
   * the same payer it is that payer; where they did not, saying so is the honest answer and a
   * caller printing it gets "3 payers" rather than one payer's name standing for all of them.
   */
  const out = {
    payments: 0, alreadyHeld: 0, matched: 0, unmatched: 0, paidAReversedFill: 0, ambiguous: 0,
    amountCents: 0, skipped: 0, problems: [] as string[],
    payer: null as string | null, paidOn: null as string | null,
    settles: true, banked: false, providerAdjustmentCents: 0, remittances: sets.length,
  };
  const payers = new Set<string>();
  for (const [i, set] of sets.entries()) {
    const r = await importOneRemittance(set, fileName, user, opts);
    out.payments += r.payments;
    out.alreadyHeld += r.alreadyHeld;
    out.matched += r.matched;
    out.unmatched += r.unmatched;
    out.paidAReversedFill += r.paidAReversedFill;
    out.ambiguous += r.ambiguous;
    out.amountCents += r.amountCents;
    out.skipped += r.skipped;
    out.providerAdjustmentCents += r.providerAdjustmentCents;
    out.banked = out.banked || r.banked;
    // Not every remittance in a bundle settles the same way: a facilitator file could ride along
    // with plans' files, and `settles` is only true of the file if it is true of all of it.
    out.settles = out.settles && r.settles;
    out.paidOn = out.paidOn ?? r.paidOn;
    if (r.payer) payers.add(r.payer);
    // Prefixed, because a problem naming neither the payer nor which of five remittances it came
    // from is a problem nobody can act on.
    out.problems.push(...r.problems.map((p) => `${r.payer ?? `remittance ${i + 1}`}: ${p}`));
  }
  out.payer = payers.size === 1 ? [...payers][0] : `${payers.size} payers`;
  return out;
}

/** One remittance, already parsed out of its file. See `importRemittance` above. */
async function importOneRemittance(
  r: import("./x12-835").Remittance,
  fileName: string,
  user: { name: string; id?: string },
  opts: { bank?: boolean; documentId?: string | null } = {},
) {
  const { payableOnly } = await import("./x12-835");
  const { keep, skipped } = payableOnly(r);
  /*
   * Whose money this is decides what it does to a fill.
   *
   * The facilitator pays on top of what the plan adjudicated, so every dollar is new revenue. A
   * plan's own 835 pays what the claim already carries as its remittance: the money is real and
   * belongs on the bank, but counting it against the fill as well would book the same remittance
   * twice. So a plan's payment settles the claim (revenue nought) and is kept for the match between
   * what was adjudicated and what was paid — which is the whole point of reading it.
   */
  const facilitator = /transaction facilitator|\bmtf\b/i.test(r.payer ?? "");
  const settles = !facilitator;
  const providerAdjustmentCents = r.providerAdjustments.reduce((n, a) => n + a.amountCents, 0);
  const out = {
    payments: 0,
    alreadyHeld: 0,
    matched: 0,
    unmatched: 0,
    paidAReversedFill: 0, ambiguous: 0,
    amountCents: 0,
    skipped: skipped.length,
    problems: [...r.problems],
    payer: r.payer,
    paidOn: r.paidOn,
    settles,
    banked: false,
    providerAdjustmentCents,
  };
  /*
   * A remittance the reader could not make add up posts nothing.
   *
   * The claims and the total are each individually believable; what is not believable is their
   * relationship, and that relationship is the whole reason to read an 835 rather than take the
   * deposit at face value. CLAUDE.md: every reader that decides money is checked by arithmetic
   * before anything is stored. So this stops here, keeps the reader's own account of the
   * difference, and leaves the file to be looked at.
   */
  if (r.balance && r.balance.differenceCents !== 0) {
    // Said in words, not only returned empty: a file held for its arithmetic used to look like a file with nothing in it.
    const money = (n: number) => `${(n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    out.problems.push(`The remittance does not balance: it says it paid ${money(r.balance.paidCents)}, its claim lines come to ${money(r.balance.claimsCents)} less ${money(r.balance.adjustmentsCents)} of provider adjustments, a difference of ${money(r.balance.differenceCents)}. Nothing from it was stored.`);
    return out;
  }

  const held = await db.query.claimPayments.findMany({ columns: { reference: true, rxNumber: true, amountCents: true } });
  const seen = new Set(held.map((h) => `${h.reference ?? ""}|${h.rxNumber}|${h.amountCents}`));

  for (const p of keep) {
    const reference = [r.traceNumber, p.reference].filter(Boolean).join("/") || fileName;
    if (seen.has(`${reference}|${p.rxNumber}|${p.paidCents}`)) {
      out.alreadyHeld++;
      continue;
    }
    const rec = await recordClaimPayment(
      {
        rxNumber: p.rxNumber,
        fillNumber: p.fillNumber,
        dateFilled: p.serviceDate,
        ndc11: p.ndc11,
        // Named for who sent it rather than assumed: this reader takes any 835, not only the MTF's.
        source: facilitator ? "mtf" : "plan",
        payer: r.payer,
        amountCents: p.paidCents!,
        revenueCents: settles ? 0 : p.paidCents!,
        receivedOn: r.paidOn,
        reference,
        documentId: opts.documentId ?? null,
        notes: `From ${fileName}${r.traceNumber ? `, trace ${r.traceNumber}` : ""}.`,
      },
      user,
    );
    out.payments++;
    out.amountCents += p.paidCents!;
    if (rec.matched) out.matched++;
    else if (rec.settledReversed) out.paidAReversedFill++;
    else if (rec.ambiguous) {
      out.ambiguous++;
      if (out.problems.length < 12) out.problems.push(`Rx ${p.rxNumber}: ${rec.ambiguous.why}`);
    } else out.unmatched++;
    seen.add(`${reference}|${p.rxNumber}|${p.paidCents}`);
  }
  if (opts.bank && r.paidOn && (r.totalPaidCents ?? out.amountCents) > 0 && out.payments > 0) {
    const { addCashReceipt } = await import("./expenses");
    await addCashReceipt({
      month: r.paidOn.slice(0, 7),
      kind: facilitator ? "facilitator" : "third_party",
      amountCents: r.totalPaidCents ?? out.amountCents,
      payer: r.payer ?? null,
      /*
       * The deposit and what stands behind it, in one sentence on the receipt.
       *
       * The amount banked is BPR02, which is what actually landed — net of anything the payer held
       * back. The claim payments posted above are gross. Both are right and they differ, and the
       * difference is provider-level money that no account in this site yet carries. Saying so on
       * the receipt puts it where somebody reconciling the bank line will read it, instead of
       * leaving a hole they have to derive.
       */
      notes:
        `From ${fileName}${r.traceNumber ? `, trace ${r.traceNumber}` : ""}, ${out.payments} claims.` +
        (providerAdjustmentCents !== 0
          ? ` The payer held back ${formatCents(providerAdjustmentCents)} at remittance level (${r.providerAdjustments.map((a) => `${a.reasonCode}${a.reference ? ` ${a.reference}` : ""}`).join(", ")}), which is why this deposit is smaller than the claims it settles. That money is not yet on either account.`
          : ""),
      createdBy: user.id ?? user.name,
      // Its identity, so the same remittance read twice banks once — and so a deposit the payer
      // payment report already banked is recognised rather than added again (expenses.ts).
      sourceKey: `835|${(r.payer ?? "payer").trim().toLowerCase()}|${r.traceNumber ?? fileName}|${r.paidOn}`,
      receivedOn: r.paidOn,
      reference: r.traceNumber ?? null,
      documentId: opts.documentId ?? null,
    });
    out.banked = true;
  }
  return out;
}

/**
 * Where the remittances are, which is wherever the CLI was told to put them.
 *
 * Asking the MTF settings rather than keeping a second folder of our own: the CLI is configured
 * once with a download directory, a scheduled task fills it, and anything that reads somewhere else
 * reads an empty folder for ever while the money piles up next door.
 */
export async function remittanceDir(): Promise<string> {
  try {
    const { mtfStatus } = await import("./mtf");
    const s = await mtfStatus();
    if (s.dir) return s.dir;
  } catch {
    // No MTF configuration yet — fall back to a folder beside the database.
  }
  const base = nodePath.dirname(nodePath.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db"));
  return nodePath.join(base, "remittances");
}

/**
 * The synced drop folder, whether or not it exists yet — so a page can say where to point a browser.
 *
 * Named rather than guessed at the call site: two places need to agree about it, and a folder that
 * the instructions and the reader disagree about is a folder the owner fills for nothing.
 */
export function syncedRemittanceDir(): string | null {
  const oneDrive = process.env.OneDrive ?? process.env.ONEDRIVE;
  return oneDrive ? nodePath.join(oneDrive, "ProviderPay") : null;
}

/**
 * Every folder a remittance might land in.
 *
 * There is more than one because the owner is usually not at the machine the site runs on. He said
 * it plainly — *"I just realized I am on a different computer than where the repo is stored"* — and
 * again, of the 835s: *"it would really be nice if these could somehow download right into the site
 * without me having to do anything"*. One folder beside the database serves him only when he
 * happens to be sitting at this machine, and leaves every other month needing an upload by hand.
 *
 * So a synced folder is watched as well. Both machines sign into the same OneDrive, so a browser on
 * either one pointed at `OneDrive\ProviderPay` puts the file within reach of the reader here
 * without anybody carrying it across.
 *
 * It is included only when it exists. Reading a folder that was never created is not an error worth
 * reporting every sweep, and naming it as watched when it is absent would be a lie the owner acts
 * on.
 *
 * A file is read from wherever it is found, and the import refuses a remittance it has already
 * taken — so the same 835 arriving down two paths is read once, not twice.
 */
export async function remittanceDirs(): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const out: string[] = [await remittanceDir()];

  const synced = syncedRemittanceDir();
  if (synced && !out.includes(synced)) {
    try {
      if ((await fs.stat(synced)).isDirectory()) out.push(synced);
    } catch {
      // Not created yet. Offered on /remits rather than invented here.
    }
  }
  return out;
}

/**
 * Reads everything in the watched folders that has not been read before.
 *
 * A folder rather than an email, because that is what a browser produces: point its download
 * location at one of these and the month arrives here without anybody carrying a file across.
 *
 * ── Why this reads more than 835s ──
 *
 * It used to take remittances and complain about everything else. But a month from ProviderPay is
 * three different things, not one — the 835s, the payment report, and the Wells Fargo account
 * history — and they come down in a single sitting from a single portal into a single folder. A
 * sweep that understood only the first left the other two sitting there looking ignored, and the
 * owner having to upload by hand the very files that had already arrived.
 *
 * So a file dropped here is routed exactly as a file handed to the upload button is routed: the
 * bytes decide what it is. Dropping a folder and pressing Send them up now do the same work, which
 * is the only way the two can be relied on to agree.
 */
export async function sweepRemittances(user: { id?: string; name: string }): Promise<{
  files: number;
  read: number;
  payments: number;
  amountCents: number;
  matched: number;
  unmatched: number;
  /** Files that were not 835s but were still dealt with — the payment report, the bank history. */
  alsoRead: string[];
  problems: string[];
}> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const dirs = await remittanceDirs();
  const out = {
    files: 0,
    read: 0,
    payments: 0,
    amountCents: 0,
    matched: 0,
    unmatched: 0,
    alsoRead: [] as string[],
    problems: [] as string[],
  };

  /*
   * Everything in the folder is looked at, and the bytes decide — not the name.
   *
   * This used to want one of five extensions or a name beginning with eight digits. That is a guess
   * about what a portal calls its downloads, and the owner is pointing his browser's download folder
   * straight at this directory: whatever ProviderPay names them, they land here. A file refused for
   * its name is a remittance nobody ever finds out was ignored.
   *
   * A zip is opened rather than refused, because portals send them and one level costs nothing.
   */
  const { readZip } = await import("./zip-read");
  const candidates: { name: string; dir: string; onDisk: string; buf: Buffer }[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      // Not created yet. Said plainly by the caller rather than treated as an error here.
      continue;
    }
    for (const entry of entries) {
      /*
       * The folder explains itself to whoever opens it, and that note is not a report.
       *
       * The first sweep of the synced folder read the README, could make nothing of it, filed it as
       * a document and moved it into `filed` — so the instructions vanished from the folder they
       * were written for. Skipped by name, like the dotfiles above.
       */
      if (entry === FILED || entry.startsWith(".") || /^read ?me/i.test(entry)) continue;
      const full = path.join(dir, entry);
      try {
        if ((await fs.stat(full)).isDirectory()) continue;
        const buf = await fs.readFile(full);
        if (/\.zip$/i.test(entry) || buf.subarray(0, 2).toString("latin1") === "PK") {
          for (const e of readZip(buf)) {
            if (e.data.length === 0 || e.name.endsWith("/")) continue;
            candidates.push({ name: `${entry} → ${e.name.split("/").pop() ?? e.name}`, dir, onDisk: entry, buf: e.data });
          }
        } else {
          candidates.push({ name: entry, dir, onDisk: entry, buf });
        }
      } catch (e) {
        out.problems.push(`${entry}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  out.files = candidates.length;

  const { classify } = await import("./autoroute");
  /** Files that were dealt with, by the folder they came from, so each is filed where it landed. */
  const done = new Map<string, Set<string>>();
  const markDone = (c: { dir: string; onDisk: string }) => {
    const set = done.get(c.dir) ?? new Set<string>();
    set.add(c.onDisk);
    done.set(c.dir, set);
  };

  for (const c of candidates) {
    try {
      const text = c.buf.toString("utf8");

      /* An 835 is known by its own claim segments, the same test an emailed one gets. */
      if (/\bCLP\b/.test(text)) {
        const r = await importRemittance(text, c.name, user);
        out.read++;
        out.payments += r.payments;
        out.amountCents += r.amountCents;
        out.matched += r.matched;
        out.unmatched += r.unmatched;
        out.problems.push(...r.problems);
        /*
         * Deleted only if something was actually taken from it.
         *
         * `markDone` used to be called here unconditionally, which quietly broke the promise the
         * delete loop below makes — "only files that were actually read reach here". A remittance
         * that does not balance posts nothing on purpose, and a file that parsed but posted nothing
         * was being deleted anyway: the one copy of a remittance still needing attention, destroyed
         * because reading it had not thrown.
         *
         * Payments already held count as read. A re-download of yesterday's file posts nothing
         * because every line of it is recognised, and that file is finished with — leaving it would
         * make the folder fill up with remittances the site already has.
         */
        if (r.payments > 0 || r.alreadyHeld > 0) markDone(c);
        else
          out.problems.push(
            `${c.name}: nothing was posted from it, so it has been left in the folder rather than deleted. ` +
              `It is the only copy here, and ProviderPay still holds the original.`,
          );
        continue;
      }

      const kind = classify(c.name, c.buf);

      /* The payment report — what each payer actually sent. Banks the cash side. */
      if (kind.kind === "payer_payments") {
        const { importPayerPayments } = await import("./payer-payments-store");
        const r = await importPayerPayments(text, { userId: user.id ?? "", userName: user.name, fileName: c.name });
        out.alsoRead.push(
          r.ok
            ? `${c.name}: ${r.banked} payment${r.banked === 1 ? "" : "s"} banked${r.alreadyHeld ? `, ${r.alreadyHeld} already held` : ""}`
            : `${c.name}: ${r.why}`,
        );
        if (r.ok) markDone(c);
        else out.problems.push(`${c.name}: ${r.why}`);
        continue;
      }

      /*
       * A remittance that did not parse is refused, never filed.
       *
       * The owner, 11 September 2026: "i do not want the site to get patient names.. or at least to
       * retain them." An 835 carries the member name in its NM1 segments. The parser never reads
       * those — it handles nine segment types and NM1 is not one of them — so an 835 that imports
       * normally leaves no name behind. Filing the raw bytes as a document would undo exactly that,
       * writing the whole file, names included, to disk.
       *
       * Anything that looks like X12 therefore stops here. A truncated or malformed 835 is a thing
       * to go and look at, not a thing to keep a copy of.
       */
      if (looksLikeX12(text)) {
        out.problems.push(
          `${c.name}: this looks like a remittance but no claim lines could be read from it, so nothing was stored. ` +
            `It is not filed as a document either — an 835 names patients and the site does not keep those. ` +
            `The file is still in the folder if it needs looking at.`,
        );
        continue;
      }

      /*
       * Everything else is kept as a document rather than refused.
       *
       * The Wells Fargo account history is the case in point: nothing reads it into the ledger yet,
       * and it is still the only thing that breaks a lump deposit on the bank statement back into
       * the payers behind it. It carries payers, payment numbers and amounts, and no patient.
       */
      const { storeFile } = await import("./files");
      const { db, schema } = await import("@/db");
      const { newId } = await import("./crypto");
      const asFile = new File([new Uint8Array(c.buf)], c.name.split(" → ").pop() ?? c.name);
      const stored = await storeFile(asFile, { allowReportTypes: true });
      await db.insert(schema.documents).values({
        id: newId(),
        category: "report",
        title: c.name,
        fileName: c.name.split(" → ").pop() ?? c.name,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        storageKey: stored.storageKey,
        effectiveOn: todayIso(),
        /*
         * The id where a person pressed the button, the name where the scheduler did.
         *
         * The nightly sweep runs as "Automatic check" and has no user row behind it. The column
         * only has to say who put the file here, and appeals.ts already stores a name for the
         * same reason — better than refusing to file a report because nobody was logged in.
         */
        uploadedBy: user.id ?? user.name,
      });
      out.alsoRead.push(`${c.name}: filed as a document (${kind.kind === "unrecognised" ? "nothing reads it yet" : kind.kind})`);
      markDone(c);
    } catch (e) {
      out.problems.push(`${c.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /*
   * A file that has been read is deleted, not kept.
   *
   * The owner, 11 September 2026: "can we have it delete remits from onedrive folder once it gathers
   * them? we need to keep computer storage as clean as possible."
   *
   * This used to move them into a `filed` folder, on the reasoning that an 835 is the evidence
   * behind a payment and is not ours to throw away. That reasoning was wrong twice over:
   *
   *   — The evidence is not lost. ProviderPay holds every remittance and will hand it back; the
   *     download is a copy, not the original. What the site needs from it — the prescription, the
   *     NDC, the amounts, the payer and the trace number — is in the database before this runs.
   *   — An 835 names patients. Keeping one is keeping a copy of PHI, in a folder that syncs to a
   *     second machine and to cloud storage. Every copy is a place it can leak from, and a copy kept
   *     for no reason is the easiest kind to forget about. "At least to retain them" cuts this way
   *     too: the fewer copies, the better.
   *
   * Only files that were actually read reach here. A remittance that failed to parse, or one refused
   * as unreadable X12, is left exactly where it is — deleting a file nobody has successfully read
   * would destroy the only copy of something still needing attention.
   *
   * A delete that fails is reported rather than swallowed. The import refuses a remittance it has
   * already taken, so a file left behind is untidy and not dangerous; silence about it is worse,
   * because a folder that never empties is how somebody concludes the sweep has stopped working.
   */
  for (const [dir, names] of done) {
    for (const name of names) {
      try {
        await fs.unlink(path.join(dir, name));
      } catch (e) {
        out.problems.push(
          `${name} was read but could not be removed from ${dir}: ${e instanceof Error ? e.message : String(e)}. ` +
            `Nothing was lost — it has been read — but it will sit in the folder until it is deleted by hand.`,
        );
      }
    }
  }
  return out;
}

/**
 * The folder read files used to be moved into. Nothing is put here any more — they are deleted.
 *
 * Still skipped when reading, because folders left over from before the change are full of 835s
 * that have already been imported. Sweeping them again would do no harm — the import refuses a
 * remittance it has already taken — but it would re-read every remittance this pharmacy has ever
 * downloaded on every pass, and quietly undo the point of deleting them.
 */
const FILED = "filed";

/**
 * Whether a file is X12 — an 835 or one of its relatives — judged by its opening envelope.
 *
 * Used to refuse, not to accept. A remittance that parsed is already handled by the time this is
 * asked; what reaches it is something that looks like an 835 and yielded no claim lines. That file
 * must not be written to disk, because an 835 names patients in segments this site deliberately
 * never reads, and storing the raw bytes would retain exactly what the parser was careful to drop.
 *
 * `ISA` and `GS` are the interchange and functional-group envelopes; `ST` opens the transaction set
 * and survives a file that was split or truncated above it. Any of the three, at the start of a line
 * or after a segment terminator, is enough.
 */
function looksLikeX12(text: string): boolean {
  const head = text.slice(0, 4000);
  return /(^|[~\r\n])(ISA|GS|ST)\*/.test(head);
}

/**
 * What the Medicare Transaction Facilitator has actually paid, and when.
 *
 * A refund channel is only worth having if somebody can see what came out of it. The payments land
 * on individual fills, which is right for working out whether a fill made money — and useless for
 * the question actually asked at the end of a month, which is how much this brought in.
 *
 * Counted by the date the money was received rather than the date the prescription was filled. A
 * remittance settles weeks after the fill, so counting by fill date would credit this month's
 * receipts to a month that closed long ago, and the figure would never agree with the bank.
 */
export type MoneyByMonth = { month: string; payments: number; amountCents: number };

export type FacilitatorMoney = {
  source: string;
  monthToDateCents: number;
  monthToDatePayments: number;
  lastMonthCents: number;
  allTimeCents: number;
  allTimePayments: number;
  months: MoneyByMonth[];
  /** The largest payments this month, so the figure can be checked against a remittance. */
  thisMonth: { rxNumber: string; dateFilled: string | null; ndc11: string | null; itemName: string | null; amountCents: number; receivedOn: string | null; reference: string | null }[];
  /** Payments naming a prescription this site has not loaded — money real but unattached. */
  unmatchedCents: number;
  /** Payments for prescriptions dispensed before the feed began: never matchable, so never pending. */
  beforeTheFeed: number;
  unmatched: number;
  /** Payments with no received date, which cannot be put in a month. */
  undatedCents: number;
};

export async function facilitatorMoney(source = "mtf", today = new Date()): Promise<FacilitatorMoney> {
  // In-books money only. These are the month-to-date and all-time figures on the dashboard.
  const rows = (await db.query.claimPayments.findMany({ where: eq(schema.claimPayments.outOfBooks, false) })).filter(
    (r) => r.source === source,
  );
  const claims = await db.query.claims.findMany({ columns: { id: true, itemName: true } });
  const nameOf = new Map(claims.map((c) => [c.id, c.itemName]));

  const monthOf = (iso: string | null) => (iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : null);
  const thisMonth = today.toISOString().slice(0, 7);
  const lastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

  const by = new Map<string, MoneyByMonth>();
  let unmatchedCents = 0;
  let unmatched = 0;
  let undatedCents = 0;

  /* The first day the claims feed covers. Read from the imports, which is what actually defines it. */
  const earliest =
    (await db.query.claimImports.findMany({ columns: { periodFrom: true } }))
      .map((i) => i.periodFrom)
      .filter((d): d is string => !!d)
      .sort()[0] ?? null;
  let beforeTheFeed = 0;
  for (const r of rows) {
    const m = monthOf(r.receivedOn);
    if (m === null) undatedCents += r.amountCents;
    else {
      const e = by.get(m) ?? { month: m, payments: 0, amountCents: 0 };
      e.payments++;
      e.amountCents += r.amountCents;
      by.set(m, e);
    }
    /*
     * "Not yet" is the wrong tense for a payment there was never a claim for.
     *
     * The owner asked for this once already — "can we have it stop alerting if looking for a claim
     * before 09/01?? this system will never get anything before 09/01" — and it was given to
     * `laterPaymentSummary` alone. The dashboard, the MTF page and the money list read this figure
     * instead, so all three went on saying "24 not yet matched to a claim" while /claims correctly
     * reported none outstanding, over the very same rows. Money found even offered an instruction
     * for it: "Load the days they belong to." There are no such days to load.
     *
     * Every one of the 24 is for a prescription dispensed before the daily claims feed begins, some
     * as far back as January. They are counted apart, and the money is still shown.
     */
    if (!r.claimId) {
      const older = earliest !== null && r.dateFilled !== null && r.dateFilled < earliest;
      if (older) beforeTheFeed++;
      else {
        unmatched++;
        unmatchedCents += r.amountCents;
      }
    }
  }

  const months = [...by.values()].sort((a, b) => b.month.localeCompare(a.month));
  const mtd = by.get(thisMonth) ?? { month: thisMonth, payments: 0, amountCents: 0 };

  return {
    source,
    monthToDateCents: mtd.amountCents,
    monthToDatePayments: mtd.payments,
    lastMonthCents: by.get(lastMonth)?.amountCents ?? 0,
    allTimeCents: rows.reduce((n, r) => n + r.amountCents, 0),
    allTimePayments: rows.length,
    /** Payments for prescriptions dispensed before the feed began. Never matchable, so never pending. */
    beforeTheFeed,
    months,
    thisMonth: rows
      .filter((r) => monthOf(r.receivedOn) === thisMonth)
      .sort((a, b) => b.amountCents - a.amountCents)
      .slice(0, 50)
      .map((r) => ({
        rxNumber: r.rxNumber,
        dateFilled: r.dateFilled,
        ndc11: r.ndc11,
        itemName: r.claimId ? (nameOf.get(r.claimId) ?? null) : null,
        amountCents: r.amountCents,
        receivedOn: r.receivedOn,
        reference: r.reference,
      })),
    unmatchedCents,
    unmatched,
    undatedCents,
  };
}

/**
 * Applies an Aytu / IPD credit memo: the RxRescue top-off money, weeks after the fill.
 *
 * A claim on this programme adjudicates for whatever the primary plan pays and the rest arrives
 * later as a credit. Until it is applied the fill sits in the loss list for the whole difference —
 * on one real fortnight, $10,706.20 of money the site would have shown as simply gone.
 *
 * Idempotent on the memo's own transaction id, because these are sent by email and an email is
 * forwarded, re-sent and swept twice. Money applied twice to a claim is not something anybody
 * re-checks afterwards.
 */
export async function importRxRescueCredit(
  buf: Buffer,
  fileName: string,
  user: { name: string },
): Promise<{
  memoId: string | null;
  applied: number;
  alreadyHeld: number;
  matched: number;
  totalCents: number;
  problems: string[];
  /** What the data says about whether only the top-off is new money. Absent on a failed read. */
  check?: import("./rxrescue-credit").TopOffCheck;
}> {
  const { parseRxRescueCredit } = await import("./rxrescue-credit");
  const memo = parseRxRescueCredit(buf.toString("utf8"));
  if (memo.rows.length === 0) {
    return { memoId: null, applied: 0, alreadyHeld: 0, matched: 0, totalCents: 0, problems: memo.problems.length ? memo.problems : ["No credit lines were found in the file."] };
  }

  const held = new Set(
    (await db.query.claimPayments.findMany({ columns: { reference: true, source: true } }))
      .filter((r) => r.source === RXRESCUE)
      .map((r) => r.reference)
      .filter((r): r is string => r !== null),
  );

  let applied = 0;
  let alreadyHeld = 0;
  let matched = 0;
  let totalCents = 0;
  for (const r of memo.rows) {
    if (r.totalCreditCents === null || r.totalCreditCents === 0) continue;
    if (held.has(r.transactionId)) {
      alreadyHeld++;
      continue;
    }
    const res = await recordClaimPayment(
      {
        rxNumber: r.rxNumber,
        fillNumber: null,
        dateFilled: r.transactionDate,
        ndc11: r.ndc11,
        source: RXRESCUE,
        payer: "Aytu / IPD (RxRescue)",
        amountCents: r.totalCreditCents,
        /*
         * Only the top-off is money the claim did not already carry.
         *
         * The ACR claim adjudicates for the copay assistance — Rx 335504's claim row reads
         * $1,096.91, which is exactly the assistance the memo then pays — so counting the whole
         * credit would book that money twice. The top-off is the part the claim never saw.
         *
         * This is the pharmacist's reading of the programme, and it is checked rather than trusted:
         * `topOffCheck` below re-tests it against every line that can settle it.
         */
        revenueCents: r.topOffCents ?? 0,
        receivedOn: r.issuedOn,
        reference: r.transactionId,
        notes: [r.memoId, r.productName, r.topOffCents ? `top-off ${(r.topOffCents / 100).toFixed(2)}` : null, r.copayAssistCents ? `assistance ${(r.copayAssistCents / 100).toFixed(2)}` : null]
          .filter(Boolean)
          .join(" · "),
      },
      user,
    );
    applied++;
    totalCents += r.totalCreditCents;
    if (res.matched) matched++;
  }

  /*
   * ── Re-testing the one thing here that was taken on advice ──────────────────────
   *
   * Only the top-off is treated as money the claim did not already carry. That came from the
   * pharmacist rather than from the data — and a rule taken on trust, with nothing able to
   * contradict it, is exactly how every other error in this system happened.
   *
   * So it is asked again of the data, every time a memo lands. A line with a non-zero top-off is
   * the only kind that can answer: on those, the plan's own claim row either carries the copay
   * assistance alone (the reading we act on) or the whole credit (in which case applying the
   * top-off books that money twice). Lines with no top-off agree with both readings and prove
   * nothing, so they are not counted as evidence.
   *
   * Nothing has to be added to any report for this. The memo carries the figures, and the claim
   * carries its own remittance.
   */
  const { topOffCheck } = await import("./rxrescue-credit");
  const acrClaims = await db.query.claims.findMany({
    where: eq(schema.claims.bin, TOP_OFF_BIN),
    columns: { rxNumber: true, dateFilled: true, ndc11: true, remitCents: true, status: true },
  });
  const remitFor = (rx: string, on: string | null, ndc: string | null): number | null => {
    const hits = acrClaims.filter(
      (c) => c.rxNumber === rx && c.status === "paid" && (on === null || c.dateFilled === on) && (ndc === null || c.ndc11 === ndc),
    );
    // One claim or none. Two is not an answer, and this check exists precisely to avoid guessing.
    return hits.length === 1 ? hits[0].remitCents : null;
  };
  const check = topOffCheck(
    memo.rows.map((r) => ({
      topOffCents: r.topOffCents,
      copayAssistCents: r.copayAssistCents,
      totalCreditCents: r.totalCreditCents,
      claimRemitCents: remitFor(r.rxNumber, r.transactionDate, r.ndc11),
    })),
  );

  const problems = [...memo.problems];
  if (check.verdict === "the whole credit is already in the claim") {
    problems.push(
      `Stop and read this: on ${check.wholeCredit} line${check.wholeCredit === 1 ? "" : "s"} the plan's own claim already carries the whole credit, not just the copay assistance. That means the top-off applied here has been counted twice. Nothing else in the site would notice.`,
    );
  } else if (check.verdict === "contradictory") {
    problems.push(
      `The lines on this memo disagree about what the claim already carries (${check.assistOnly} carry the assistance alone, ${check.wholeCredit} the whole credit, ${check.neither} neither). A rule that holds sometimes is not a rule — the top-off applied here cannot be relied on until somebody looks.`,
    );
  }

  return { memoId: memo.memoId, applied, alreadyHeld, matched, totalCents, problems, check };
}

/** The RxRescue plan's BIN. Its claims are the ones a credit memo settles. */
const TOP_OFF_BIN = "024284";

/** The source name these credits are filed under, so nothing else can be mistaken for them. */
export const RXRESCUE = "rxrescue";
