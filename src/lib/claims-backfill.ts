/**
 * Fills in the fills the daily transaction report never delivered, from PioneerRx itself.
 *
 * The owner, asked whether to re-send the reports or take them from the pharmacy system: "Pull from
 * pioneer".
 *
 * On 11 September PioneerRx held 38 fills worth $4,563.35 that this site did not — 25 of them on
 * the 7th. The claims here come from the nightly Rx transaction report, and a report run before its
 * day had finished leaves a hole that later reports do not always fill. The advice used to be to
 * re-send those days' reports by hand, which worked and which nobody should have to do: PioneerRx
 * is already read every night and already holds the same fills.
 *
 * ── Why this cannot double count ──
 *
 * A fill is one Rx number and one refill number. Only fills whose key appears in PioneerRx and not
 * in the claims table are written, so a fill the report delivers tomorrow is never added again — it
 * is already here. Rows are stamped `source: "pioneer_sql"` and carry their own import, so what
 * came from where is visible on any row and can be undone as a group.
 *
 * ── What a backfilled row does and does not carry ──
 *
 * PioneerRx supplies the money, the drug, the plan routing and the acquisition cost. What it does
 * not supply is the transaction key the report uses to pair a reversal with its original. A
 * backfilled fill therefore cannot be reversed by a later report the way a reported one can — it
 * would arrive as an unmatched reversal and be seen. That is the honest trade, and it is the right
 * way round: a fill that is missing is wrong every day until somebody notices, and a reversal that
 * arrives unmatched is visible the moment it lands.
 */

import { db, schema } from "@/db";
import { isOutOfBooks } from "./books-start";
import { and, eq, gte, inArray } from "drizzle-orm";
import { newId } from "./crypto";
import { todayIso } from "./dates";

export type BackfilledFill = {
  rxNumber: string;
  fillNumber: number;
  filledOn: string | null;
  soldOn: string | null;
  ndc11: string | null;
  itemName: string | null;
  bin: string | null;
  pcn: string | null;
  groupNumber: string | null;
  networkId: string | null;
  quantityThousandths: number | null;
  daysSupply: number | null;
  insuranceCents: number;
  patientCents: number;
  acquisitionCents: number | null;
  dispensingFeeCents: number | null;
};

export type BackfillReport = {
  considered: number;
  written: number;
  alreadyHeld: number;
  /** Here as reversed, and PioneerRx still calls them paid. Not missing, and not settled either. */
  heldReversed: { rxNumber: string; fillNumber: number; filledOn: string | null; cents: number }[];
  refused: { rxNumber: string; why: string }[];
  cents: number;
  says: string;
};

/**
 * Writes the fills PioneerRx has and the claims table does not.
 *
 * `from` bounds how far back this will reach, so a bad pull cannot rewrite history: only fills
 * dated on or after it are considered, and the caller passes the month being worked.
 */
export async function backfillClaimsFromPioneer(fills: BackfilledFill[], from: string, user = "the PioneerRx pull"): Promise<BackfillReport> {
  const report: BackfillReport = { considered: fills.length, written: 0, alreadyHeld: 0, heldReversed: [], refused: [], cents: 0, says: "" };
  if (fills.length === 0) {
    report.says = "nothing to fill in";
    return report;
  }

  const inRange = fills.filter((f) => (f.filledOn ?? "") >= from);
  const rxNumbers = [...new Set(inRange.map((f) => f.rxNumber))];
  const held = rxNumbers.length
    ? await db.query.claims.findMany({
        where: and(inArray(schema.claims.rxNumber, rxNumbers), gte(schema.claims.dateFilled, from)),
        columns: { rxNumber: true, fillNumber: true, status: true },
      })
    : [];
  const heldKeys = new Set(held.map((h) => `${h.rxNumber}|${h.fillNumber ?? 0}`));
  /*
   * Which of those are on file only as a reversal.
   *
   * "Already here" and "here, reversed, while PioneerRx still calls it paid" are different facts,
   * and folding the second into the first hid eight fills worth $1,853.22 behind a count that
   * read as settled. A reversed row earns nothing — every revenue figure takes paid rows only —
   * so if PioneerRx is right the money is missing from the account just as surely as a fill that
   * was never delivered.
   *
   * Not written, because the two readings cannot both be true of one fill and choosing between
   * them is a question about what happened at the counter, not one this can settle. Named instead.
   */
  const reversedKeys = new Set(held.filter((h) => h.status === "reversed").map((h) => `${h.rxNumber}|${h.fillNumber ?? 0}`));
  const paidKeys = new Set(held.filter((h) => h.status !== "reversed").map((h) => `${h.rxNumber}|${h.fillNumber ?? 0}`));

  const wanted = inRange.filter((f) => {
    const k = `${f.rxNumber}|${f.fillNumber}`;
    if (paidKeys.has(k)) {
      report.alreadyHeld++;
      return false;
    }
    if (reversedKeys.has(k)) {
      report.heldReversed.push({ rxNumber: f.rxNumber, fillNumber: f.fillNumber, filledOn: f.filledOn, cents: f.insuranceCents });
      return false;
    }
    /*
     * A fill with no date cannot be placed in a month, and a month is what every figure on the
     * account is cut by. Refused rather than dated today.
     */
    if (!f.filledOn) {
      report.refused.push({ rxNumber: f.rxNumber, why: "PioneerRx holds no fill date for it, so it cannot be placed in a month." });
      return false;
    }
    return true;
  });
  if (wanted.length === 0) {
    report.says =
      report.heldReversed.length > 0
        ? `nothing to fill in; ${report.heldReversed.length} fills are here as reversed while PioneerRx still calls them paid`
        : report.alreadyHeld > 0
          ? `every fill PioneerRx has for this period is already here`
          : "nothing to fill in";
    return report;
  }

  /*
   * Its own import row, so a backfilled fill is never mistaken for a reported one.
   *
   * One per day it runs. The claims table cascades on this row, so if a day's backfill ever has to
   * be undone it is one delete rather than a hunt through the claims.
   */
  /*
   * A pull of a month that ends before the books begin is a test, and gets an import row of its own.
   *
   * The owner pulls an old month so that month's remittances have claims to match against, and then
   * none of it may be counted: "these are test only and should not show up on any AR reports or
   * anything." `loadFills` drops every claim belonging to an import flagged this way, so the whole
   * pull disappears from the receivables list, the month's account and the payer judgements at once,
   * while `findClaim` still finds them and the matching still works.
   *
   * A separate row matters. The daily backfill reuses one import per day, so a test pull sharing it
   * would drag that day's real September claims out of the books alongside the test ones.
   *
   * Judged on the newest fill in the pull rather than the range asked for: a range that happens to
   * run up to today but returned nothing after August is still a test, and a range straddling the
   * boundary is not one — it holds real claims, and dropping them would lose real revenue.
   */
  const newestFill = wanted.reduce((m, f) => (f.filledOn && f.filledOn > m ? f.filledOn : m), "");
  const isTestPull = newestFill !== "" && isOutOfBooks(newestFill);

  const stamp = isTestPull
    ? `PioneerRx test pull ${from} to ${newestFill}`
    : `PioneerRx backfill ${todayIso()}`;
  const existing = await db.query.claimImports.findFirst({ where: eq(schema.claimImports.fileName, stamp) });
  const importId = existing?.id ?? newId();
  if (!existing) {
    await db.insert(schema.claimImports).values({
      id: importId,
      fileName: stamp,
      createdBy: user,
      outOfBooks: isTestPull,
    });
  }

  const rows: (typeof schema.claims.$inferInsert)[] = wanted.map((f) => ({
    id: newId(),
    importId,
    rxNumber: f.rxNumber,
    fillNumber: f.fillNumber,
    dateFilled: f.filledOn!,
    ndc11: f.ndc11,
    itemName: f.itemName,
    bin: f.bin,
    pcn: f.pcn,
    groupNumber: f.groupNumber,
    networkId: f.networkId,
    quantityThousandths: f.quantityThousandths,
    daysSupply: f.daysSupply,
    remitCents: f.insuranceCents,
    copayCents: f.patientCents,
    acquisitionCents: f.acquisitionCents,
    dispensingFeePaidCents: f.dispensingFeeCents,
    /* PioneerRx returns adjudicated, non-reversed claims only, so every one of these was paid. */
    status: "paid" as const,
    completedAt: f.soldOn,
    /*
     * Where it came from, on the row itself.
     *
     * Every other claim says "transaction_report". A figure that behaves oddly can be traced to its
     * source without anybody having to remember that a backfill happened.
     */
    source: "pioneer_sql",
  }));

  for (let i = 0; i < rows.length; i += 300) await db.insert(schema.claims).values(rows.slice(i, i + 300));
  report.written = rows.length;
  report.cents = wanted.reduce((n, f) => n + f.insuranceCents, 0);

  const byDay = new Map<string, number>();
  for (const f of wanted) byDay.set(f.filledOn!, (byDay.get(f.filledOn!) ?? 0) + 1);
  const days = [...byDay].sort((a, b) => b[1] - a[1]);
  report.says =
    `${report.written} fill${report.written === 1 ? "" : "s"} worth ` +
    `$${(report.cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} filled in from PioneerRx` +
    `${days.length ? `, mostly ${days.slice(0, 3).map(([d, n]) => `${d} (${n})`).join(", ")}` : ""}` +
    `${report.refused.length ? `; ${report.refused.length} refused for want of a fill date` : ""}` +
    `${report.heldReversed.length ? `; ${report.heldReversed.length} more are here as reversed while PioneerRx still calls them paid, ` +
      `$${(report.heldReversed.reduce((n, x) => n + x.cents, 0) / 100).toFixed(2)} — left alone, because which reading is right is a question about the counter` : ""}`;
  return report;
}
