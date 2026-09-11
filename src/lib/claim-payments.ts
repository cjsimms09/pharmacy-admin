import { chooseClaimForRemittance } from "./match-remittance";
import "server-only";
import nodePath from "node:path";
import { db, schema } from "@/db";
import { eq, isNull } from "drizzle-orm";
import { newId } from "./crypto";
import type { LaterPayment } from "./fills";
import { formatCents } from "./money";

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
export async function recordClaimPayment(p: RecordPayment, user: { name: string }): Promise<{ id: string; matched: boolean; settledReversed: boolean; ambiguous: { count: number; why: string } | null }> {
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
    notes: [p.notes, onlyReversed ? "The only claim this pharmacy holds for that fill was reversed, so the payment is recorded against no claim. Worth asking the plan what it paid for." : null].filter(Boolean).join(" ") || null,
    recordedBy: user.name,
  });
  return { id, matched: claim !== null, settledReversed: onlyReversed, ambiguous };
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

/** Every later payment, in the shape the fill grouping takes. */
export async function laterPayments(): Promise<LaterPayment[]> {
  const rows = await db.query.claimPayments.findMany();
  return rows.map((r) => ({
    rxNumber: r.rxNumber,
    fillNumber: r.fillNumber,
    dateFilled: r.dateFilled,
    ndc11: r.ndc11,
    source: r.source,
    payer: r.payer,
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
  const rows = await db.query.claimPayments.findMany();
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
 * Loads an 835 remittance and records what it paid against the fills it names.
 *
 * The whole point of the Medicare Transaction Facilitator CLI: it downloads these files on a
 * schedule, and until they are read the money in them reaches the bank and nothing here knows.
 *
 * Loading the same file twice is safe. A payment is identified by the remittance's trace number
 * and the claim's own reference, which is what makes a re-download of the same day harmless —
 * and re-downloading is exactly what a scheduled task does.
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
}> {
  const { parse835, payableOnly } = await import("./x12-835");
  const r = parse835(text);
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
 * Reads every remittance in the watched folder that has not been read before.
 *
 * A folder rather than an email, because that is what the CLI produces: it is given a download
 * directory and it fills it on a schedule. Point it at this one and the money appears here without
 * anybody carrying a file across.
 */
export async function sweepRemittances(user: { name: string }): Promise<{
  files: number;
  read: number;
  payments: number;
  amountCents: number;
  matched: number;
  unmatched: number;
  problems: string[];
}> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = await remittanceDir();
  const out = { files: 0, read: 0, payments: 0, amountCents: 0, matched: 0, unmatched: 0, problems: [] as string[] };
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    // Not created yet. Said plainly by the caller rather than treated as an error here.
    return out;
  }
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
  const candidates: { name: string; onDisk: string; text: string }[] = [];
  for (const entry of entries) {
    if (entry === FILED || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    try {
      if ((await fs.stat(full)).isDirectory()) continue;
      const buf = await fs.readFile(full);
      if (/\.zip$/i.test(entry) || buf.subarray(0, 2).toString("latin1") === "PK") {
        for (const e of readZip(buf)) {
          if (e.data.length === 0) continue;
          candidates.push({ name: `${entry} → ${e.name.split("/").pop() ?? e.name}`, onDisk: entry, text: e.data.toString("utf8") });
        }
      } else {
        candidates.push({ name: entry, onDisk: entry, text: buf.toString("utf8") });
      }
    } catch (e) {
      out.problems.push(`${entry}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  out.files = candidates.length;

  const done = new Set<string>();
  for (const c of candidates) {
    try {
      /*
       * An 835 is known by its own segments, the same test an emailed one gets. A file without them
       * is named rather than passed over in silence: this folder is where he puts things, so
       * anything he puts here that nothing happens to is worth a sentence.
       */
      if (!/\bCLP\b/.test(c.text)) {
        out.problems.push(`${c.name}: not a remittance — it carries no claim segments, so nothing was read from it.`);
        continue;
      }
      const r = await importRemittance(c.text, c.name, user);
      out.read++;
      out.payments += r.payments;
      out.amountCents += r.amountCents;
      out.matched += r.matched;
      out.unmatched += r.unmatched;
      out.problems.push(...r.problems);
      done.add(c.onDisk);
    } catch (e) {
      out.problems.push(`${c.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /*
   * Read files are moved aside rather than left where they are.
   *
   * The import refuses a remittance it has already taken, so leaving them would be safe — and would
   * also mean every sweep re-reads every 835 this pharmacy has ever downloaded. Moving them keeps
   * the folder as what it looks like: the things not yet dealt with. They are kept rather than
   * deleted, because an 835 is the evidence behind a payment and is not ours to throw away.
   */
  if (done.size > 0) {
    const filed = path.join(dir, FILED);
    await fs.mkdir(filed, { recursive: true });
    for (const name of done) {
      try {
        await fs.rename(path.join(dir, name), path.join(filed, name));
      } catch (e) {
        out.problems.push(`${name} was read but could not be moved aside: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return out;
}

/** Where a remittance goes once it has been read. Kept, never deleted: it is the evidence. */
const FILED = "filed";

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
  const rows = (await db.query.claimPayments.findMany()).filter((r) => r.source === source);
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
