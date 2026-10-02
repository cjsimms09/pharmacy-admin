import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { rankForAlertKey, rankForMoney, type Rank } from "./rank";
import { SITE_STARTS_ON } from "../books-start";

/**
 * The one list: everything a person must answer, computed when data lands and every night, stored, ranked.
 *
 * ── Sources ──
 *
 *   bank lines nothing could place          the Money page's open lines, with the answers decideBankLine takes
 *   documents held or unrecognised          the inbox's held items, with "read again" and the kinds it could be
 *   feeds past their date                   expected.ts, judged (feed-state.ts keeps the whole table)
 *   the old alert machinery                 alerts.ts, every line it produces, re-ranked by consequence
 *   claims: a payer owed a lot and never measured; a payer with claims past its own cycle
 *   the previous month not closed
 *
 * ── The three rules of the list ──
 *
 *   A line's id is stable across passes, so the same question is one row however many times it is computed.
 *   A line answered by a person (resolved_by "answer") never returns, even if its source still produces it.
 *   A line the data settles (its source stops producing it) resolves itself, and reopens if the source does again.
 *
 * Reading is engine/read.ts; nothing here is read by a screen directly.
 */

export type Answer = { label: string; action: string; params?: Record<string, string | number> };

export type Line = {
  id: string;
  kind: string;
  rank: Rank;
  title: string;
  detail?: string | null;
  amountCents?: number | null;
  href?: string | null;
  answers?: Answer[];
  rows?: unknown;
};

const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shiftDays = (iso: string, by: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + by * 864e5).toISOString().slice(0, 10);
const firstSentence = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").split(/(?<=\.)\s/)[0].slice(0, 220);

async function bankLines(today: string): Promise<Line[]> {
  const rows = await db.query.bankLines.findMany({ where: and(eq(schema.bankLines.placedAs, "unplaced"), gte(schema.bankLines.on, shiftDays(today, -120))) });
  return rows.map((r) => {
    const cheque = /^(CHECK|CHQ|CHEQUE|DRAFT)\s*#?\s*\d+$/i.test(r.description.trim());
    const answers: Answer[] = r.amountCents < 0
      ? cheque
        ? [{ label: "What it was for", action: "cheque" }, { label: "Predates the books", action: "before_books" }]
        : [{ label: "A cost, under a category", action: "books_bill" }, { label: "Predates the books", action: "before_books" }, { label: "Note it and stop asking", action: "noted" }]
      : [{ label: "A deposit from a named payer", action: "deposit" }, { label: "Predates the books", action: "before_books" }];
    return {
      id: `bank_line|${r.id}`,
      kind: "bank_line",
      rank: rankForMoney(r.amountCents),
      title: `${r.on} · ${r.amountCents < 0 ? "−" : "+"}${money(r.amountCents)} · ${r.description.replace(/\s+/g, " ").trim().slice(0, 60)}`,
      detail: firstSentence(r.why),
      amountCents: r.amountCents,
      href: `/money/bank-review?month=${r.on.slice(0, 7)}`,
      answers,
      rows: { bankLineId: r.id, key: r.key },
    };
  });
}

async function heldDocuments(today: string): Promise<Line[]> {
  const since = `${shiftDays(today, -60)}T00:00:00`;
  const rows = await db.query.inboxItems.findMany({
    where: and(eq(schema.inboxItems.status, "stored"), gte(schema.inboxItems.receivedAt, since)),
    columns: { id: true, receivedAt: true, fromAddress: true, subject: true, fileName: true, routedAs: true, routeResult: true, imported: true, documentId: true },
  });
  return rows
    .filter((r) => r.imported === false || r.routedAs === "unrecognised")
    .filter((r) => !/needs the model/i.test(r.routeResult ?? ""))
    .map((r) => {
      const sender = (r.fromAddress.split("@")[1] ?? r.fromAddress).toLowerCase();
      const supplierish = /mckesson|parmed|ipc|ipd|anda|rxsystems|providerpay|accesshealth|wwfppa|redsail|emprise/.test(sender);
      return {
        id: `document_held|${r.id}`,
        kind: "document_held",
        rank: (supplierish ? 4 : 5) as Rank,
        title: `${r.receivedAt.slice(0, 10)} · ${r.subject.slice(0, 50) || r.fileName || "a document"} · ${sender}`,
        detail: firstSentence(r.routeResult) || "Filed, and nothing was read from it.",
        href: `/inbox#${r.id}`,
        answers: [{ label: "Read it again", action: "reread", params: { itemId: r.id } }, { label: "Say what it is", action: "teach", params: { itemId: r.id } }],
        rows: { inboxItemId: r.id, documentId: r.documentId },
      };
    });
}

async function feedsLate(): Promise<Line[]> {
  const rows = await db.query.feedState.findMany();
  return rows
    .filter((r) => r.state === "overdue" || r.state === "never_arrived")
    .map((r) => ({
      id: `feed|${r.key}`,
      kind: "feed_overdue",
      rank: (/835|remit|payment|providerpay|access|bank|statement/i.test(r.key + r.name) ? 3 : 4) as Rank,
      title: `${r.name}: ${r.state === "overdue" ? "overdue" : "never arrived"}${r.lastDue ? `, due ${r.lastDue}` : ""}`,
      detail: r.says,
      href: "/expected",
      answers: [{ label: "Where it comes from", action: "open" }],
      rows: { feedKey: r.key },
    }));
}

async function alertLines(): Promise<Line[]> {
  const { alerts } = await import("../alerts");
  const list = await alerts();
  return list.map((a) => ({
    id: `alert|${a.key}|${(a.subject ?? "").slice(0, 40)}`,
    kind: "alert",
    rank: rankForAlertKey(a.key),
    title: a.title,
    detail: a.why,
    href: a.href,
    answers: [{ label: a.action ?? "Open", action: "open" }],
    rows: { alertKey: a.key, level: a.level },
  }));
}

/**
 * Claims the payers have not paid, as pots a person can act on, read from the claim standing (engine/claims.ts) so
 * Today, the month and Cash ahead never disagree: a payer owed a lot that has never been measured (the site cannot
 * say late; it can say unmeasured and large), and a payer with claims past their plan groups' own cycles. A leg a
 * person has settled, written off or called paid elsewhere is in no pot.
 */
async function claimPots(today: string): Promise<Line[]> {
  const { TERMINAL_DECISIONS } = await import("./claims");
  const rows = (await db.all(sql`select payer, pcn, programme, state, short_cents cents, date_filled filled, cycle_days cycle, decision from claim_standing where state in ('unpaid', 'due', 'unmeasured', 'programme')`)) as { payer: string; pcn: string | null; programme: number; state: string; cents: number; filled: string; cycle: number | null; decision: string | null }[];
  const pots = new Map<string, { n: number; cents: number; dueN: number; dueCents: number; oldest: string; measured: boolean; cycleMin: number | null; cycleMax: number | null; programme: boolean; pcn: string | null }>();
  for (const r of rows) {
    if (TERMINAL_DECISIONS.has(r.decision ?? "")) continue;
    const e = pots.get(r.payer) ?? { n: 0, cents: 0, dueN: 0, dueCents: 0, oldest: r.filled, measured: false, cycleMin: null, cycleMax: null, programme: !!r.programme, pcn: r.pcn };
    e.n++;
    e.cents += r.cents;
    if (r.filled < e.oldest) e.oldest = r.filled;
    if (r.cycle !== null) e.measured = true;
    if (r.state === "due" && r.cycle !== null) {
      e.dueN++;
      e.dueCents += r.cents;
      e.cycleMin = e.cycleMin === null ? r.cycle : Math.min(e.cycleMin, r.cycle);
      e.cycleMax = e.cycleMax === null ? r.cycle : Math.max(e.cycleMax, r.cycle);
    }
    pots.set(r.payer, e);
  }
  const { rules } = await import("./rules");
  const routes = await rules("programme_route");
  const routeFor = (payer: string, pcn: string | null) => routes.find((r) => new RegExp(r.key, "i").test(`${payer} ${pcn ?? ""}`)) ?? null;
  const out: Line[] = [];
  for (const [payer, e] of pots) {
    const route = e.programme ? routeFor(payer, e.pcn) : null;
    const routeDays = route && typeof route.value.cycleDays === "number" ? (route.value.cycleDays as number) : null;
    const oldestAge = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${e.oldest}T00:00:00Z`)) / 864e5;
    const href = `/v2/claims?payer=${encodeURIComponent(payer)}`;
    /* The month in the id: a line a person answers never returns, and a payer's pot must — next month, with next month's claims. */
    const month = today.slice(0, 7);
    /* A programme whose route and cycle are known is a pot inside its cycle: nothing to ask until the cycle has passed. */
    if (route && routeDays !== null && oldestAge <= routeDays) continue;
    if (!e.measured && e.cents >= 20_000_00 && oldestAge > 21) {
      out.push({
        id: `claims_unmeasured|${payer}|${month}`,
        kind: "claims_unmeasured",
        rank: 3,
        title: e.programme ? `${payer}, a manufacturer programme: ${money(e.cents)} on ${e.n} claims since ${e.oldest}` : `${payer}: ${money(e.cents)} billed since ${e.oldest}, no cycle measured yet`,
        detail: e.programme
          ? route
            ? `${String(route.value.note ?? "")} The oldest claim is ${Math.round(oldestAge)} days old, past the ${routeDays ?? "?"}-day cycle measured on ${route.saidOn}.`
            : `A programme pays on its own terms and by its own route; the first payment will say which and how long it takes. The oldest claim is ${Math.round(oldestAge)} days old. Not a plan, not called late.`
          : `${e.n} claims. The site cannot call this late: it has fewer than 25 payments tied to this payer's claims, so it has never measured how they pay. It can say the pot is large and the oldest claim is ${Math.round(oldestAge)} days old.`,
        amountCents: e.cents,
        href,
        answers: e.programme
          ? [{ label: "How it pays us", action: "channel", params: { payer } }, { label: "It pays later; wait", action: "wait", params: { payer } }]
          : [{ label: "Which channel pays them", action: "channel", params: { payer } }, { label: "They pay monthly; wait", action: "wait", params: { payer } }],
        rows: { payer, claims: e.n, programme: e.programme },
      });
    } else if (e.dueCents >= 500_00) {
      out.push({
        id: `claims_due|${payer}|${month}`,
        kind: "claims_due",
        rank: 3,
        title: e.cycleMin === e.cycleMax ? `${payer}: ${e.dueN} claims past its ${e.cycleMax}-day cycle, ${money(e.dueCents)}` : `${payer}: ${e.dueN} claims past their plans' cycles (${e.cycleMin}–${e.cycleMax} days), ${money(e.dueCents)}`,
        detail: `Nine in ten of their payments arrive within ${e.cycleMin === e.cycleMax ? `${e.cycleMax} days` : `${e.cycleMin} to ${e.cycleMax} days, by plan`} of the fill; these are older. ${e.n - e.dueN} more claims (${money(e.cents - e.dueCents)}) are still inside their cycle.`,
        amountCents: e.dueCents,
        href,
        answers: [{ label: "Chase", action: "chase", params: { payer } }, { label: "They pay later; ask again in a fortnight", action: "wait", params: { payer } }],
        rows: { payer, due: e.dueN, cycle: e.cycleMax },
      });
    }
  }
  return out;
}

async function monthNotClosed(today: string): Promise<Line[]> {
  const prev = new Date(Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`) - 864e5).toISOString().slice(0, 7);
  if (prev < SITE_STARTS_ON.slice(0, 7)) return [];
  const m = await db.query.monthStatus.findFirst({ where: eq(schema.monthStatus.month, prev) });
  if (!m || m.closeState === "closed") return [];
  const parts: string[] = [];
  if (m.bankLines === 0) parts.push("no bank statement on file");
  if (m.bankOpenLines > 0) parts.push(`${m.bankOpenLines} bank line${m.bankOpenLines === 1 ? "" : "s"} open`);
  if (m.receiptsGapCents && Math.abs(m.receiptsGapCents) > 0 && !m.receiptsGapSays) parts.push(`receipts differ from the bank by ${money(m.receiptsGapCents)}`);
  return [
    {
      id: `close|${prev}`,
      kind: "close",
      rank: 4,
      title: `${prev} is ${m.closeState === "ready" ? "ready to close" : "not closed"}${parts.length ? `: ${parts.join(", ")}` : ""}`,
      detail: m.closeState === "ready" ? "Every line placed and every proof passed. One press closes it." : "It closes itself when every line is placed and every proof passes.",
      href: `/money/monthly?month=${prev}`,
      answers: m.closeState === "ready" ? [{ label: "Close the month", action: "close_month", params: { month: prev } }] : [{ label: "Open the month", action: "open" }],
      rows: { month: prev },
    },
  ];
}

/**
 * A proof that failed last night is a line, except where its items are already lines (held documents) or the
 * month has not ended (a month with no statement yet is not a failure, it is October).
 */
async function proofFailures(today: string): Promise<Line[]> {
  const latest = (await db.all(sql`select proof, scope, run_at, passed, says from proof_run p where run_at = (select max(run_at) from proof_run q where q.proof = p.proof and coalesce(q.scope, '') = coalesce(p.scope, ''))`)) as { proof: string; scope: string | null; run_at: string; passed: number; says: string }[];
  const out: Line[] = [];
  for (const p of latest) {
    if (p.passed) continue;
    if (p.proof === "reader_arithmetic" || p.proof === "expected_arrived") continue;
    if ((p.proof === "bank_to_cent" || p.proof === "receipts_to_bank" || p.proof === "remit_to_claim") && p.scope && p.scope >= today.slice(0, 7)) continue;
    if (p.proof === "bank_to_cent" && /no bank statement is on file/.test(p.says)) continue;
    out.push({
      id: `proof|${p.proof}|${p.scope ?? ""}`,
      kind: "proof_failed",
      rank: p.proof === "claims_eq_pioneer" ? 3 : 4,
      title: p.says,
      detail: `A proof the engine runs every night, failed on ${p.run_at.slice(0, 10)}.`,
      href: p.proof === "claims_eq_pioneer" ? "/tools/data-health" : p.proof === "remit_to_claim" || p.proof === "payments_once" ? "/v2/claims?tab=unmatched" : `/money/bank-review?month=${p.scope ?? ""}`,
      answers: [{ label: "Open", action: "open" }],
      rows: { proof: p.proof, scope: p.scope },
    });
  }
  return out;
}

/** Everything the sources produce right now. Pure in intent: nothing is written. */
export async function computeNeedsYou(today: string): Promise<Line[]> {
  const parts = await Promise.all([bankLines(today), heldDocuments(today), feedsLate(), alertLines(), claimPots(today), monthNotClosed(today), proofFailures(today)]);
  const seen = new Set<string>();
  const out: Line[] = [];
  for (const l of parts.flat()) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    out.push(l);
  }
  return out;
}

/**
 * Writes the list, keeping the three rules: a stable id, an answered line never returns, a settled line resolves
 * itself and reopens if its source produces it again.
 */
export async function writeNeedsYou(lines: Line[], now: string): Promise<{ opened: number; kept: number; resolved: number; suppressed: number }> {
  const existing = await db.query.needsYou.findMany();
  const byId = new Map(existing.map((r) => [r.id, r]));
  const present = new Set(lines.map((l) => l.id));
  let opened = 0;
  let kept = 0;
  let resolved = 0;
  let suppressed = 0;
  for (const l of lines) {
    const row = byId.get(l.id);
    const values = {
      kind: l.kind,
      rank: l.rank,
      title: l.title,
      detail: l.detail ?? null,
      amountCents: l.amountCents ?? null,
      href: l.href ?? null,
      answers: l.answers ? JSON.stringify(l.answers) : null,
      rowsJson: l.rows === undefined ? null : JSON.stringify(l.rows),
      lastSeen: now,
    };
    if (!row) {
      await db.insert(schema.needsYou).values({ id: l.id, firstSeen: now, ...values });
      opened++;
    } else if (row.resolvedAt && row.resolvedBy === "answer") {
      suppressed++;
    } else if (row.resolvedAt) {
      await db.update(schema.needsYou).set({ ...values, resolvedAt: null, resolvedBy: null }).where(eq(schema.needsYou.id, l.id));
      opened++;
    } else {
      await db.update(schema.needsYou).set(values).where(eq(schema.needsYou.id, l.id));
      kept++;
    }
  }
  const gone = existing.filter((r) => !r.resolvedAt && !present.has(r.id)).map((r) => r.id);
  if (gone.length) {
    await db.update(schema.needsYou).set({ resolvedAt: now, resolvedBy: "data" }).where(inArray(schema.needsYou.id, gone));
    resolved = gone.length;
  }
  return { opened, kept, resolved, suppressed };
}

/** A person answered this line: it is settled and it does not come back. */
export async function resolveByAnswer(id: string, now: string): Promise<void> {
  await db.update(schema.needsYou).set({ resolvedAt: now, resolvedBy: "answer" }).where(and(eq(schema.needsYou.id, id), isNull(schema.needsYou.resolvedAt)));
}
