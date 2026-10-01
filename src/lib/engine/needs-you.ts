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
 * Claims the payers have not paid, as pots a person can act on: a payer owed a lot that has never paid (the site
 * cannot say late; it can say unmeasured and large), and a payer with claims past its own measured cycle.
 */
async function claimPots(today: string): Promise<Line[]> {
  const paid = (await db.all(sql`select coalesce(c.pbm_name, c.payer_label) payer, julianday(p.received_on) - julianday(c.date_filled) days from claim_payments p join claims c on c.id = p.claim_id where p.source = 'plan' and c.date_filled >= ${SITE_STARTS_ON}`)) as { payer: string; days: number }[];
  const by = new Map<string, number[]>();
  for (const r of paid) by.set(r.payer, [...(by.get(r.payer) ?? []), r.days]);
  const p90 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(0.9 * s.length))]; };
  const unpaid = (await db.all(sql`select coalesce(c.pbm_name, c.payer_label) payer, c.pcn pcn, c.remit_cents cents, julianday(${today}) - julianday(c.date_filled) age, c.date_filled filled from claims c where c.date_filled >= ${SITE_STARTS_ON} and c.status = 'paid' and c.remit_cents > 0 and c.cash_plan = 0 and c.id not in (select claim_id from claim_payments where claim_id is not null)`)) as { payer: string; pcn: string | null; cents: number; age: number; filled: string }[];
  /*
   * A manufacturer programme is not a plan. The owner, 1 October 2026, of DST / ConnectiveRx (PCN CNRX, every claim
   * Wegovy): "dst IS a copay card!!!" It pays on its own terms and by its own route, which the site learns from the
   * first payment; until then the pot is said as a programme's, never as a plan's late money.
   */
  const programme = (payer: string, pcn: string | null) => /cnrx|connectiverx|copay|voucher|redsail|veridikal|dst pharmacy/i.test(`${payer} ${pcn ?? ""}`);
  const pots = new Map<string, { n: number; cents: number; dueN: number; dueCents: number; oldest: string; cycle: number | null; sample: number; programme: boolean }>();
  for (const u of unpaid) {
    const xs = by.get(u.payer) ?? [];
    const cycle = xs.length >= 25 ? p90(xs) : null;
    const e = pots.get(u.payer) ?? { n: 0, cents: 0, dueN: 0, dueCents: 0, oldest: u.filled, cycle, sample: xs.length, programme: programme(u.payer, u.pcn) };
    e.n++;
    e.cents += u.cents;
    if (u.filled < e.oldest) e.oldest = u.filled;
    if (cycle !== null && u.age > cycle) { e.dueN++; e.dueCents += u.cents; }
    pots.set(u.payer, e);
  }
  const out: Line[] = [];
  for (const [payer, e] of pots) {
    const oldestAge = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${e.oldest}T00:00:00Z`)) / 864e5;
    if (e.cycle === null && e.cents >= 20_000_00 && oldestAge > 21) {
      out.push({
        id: `claims_unmeasured|${payer}`,
        kind: "claims_unmeasured",
        rank: 3,
        title: e.programme
          ? `${payer}, a manufacturer programme: ${money(e.cents)} on ${e.n} claims since ${e.oldest}, ${e.sample === 0 ? "nothing received by any route yet" : `only ${e.sample} payment${e.sample === 1 ? "" : "s"} seen`}`
          : `${payer}: ${money(e.cents)} billed since ${e.oldest}, ${e.sample === 0 ? "nothing ever received" : `only ${e.sample} payment${e.sample === 1 ? "" : "s"} ever received`}`,
        detail: e.programme
          ? `A programme pays on its own terms and by its own route; the first payment will say which and how long it takes. The oldest claim is ${Math.round(oldestAge)} days old. Not a plan, not called late.`
          : `${e.n} claims. The site cannot call this late: it has never measured how this payer pays. It can say the pot is large and the oldest claim is ${Math.round(oldestAge)} days old.`,
        amountCents: e.cents,
        href: "/payers/waiting",
        answers: e.programme
          ? [{ label: "How it pays us", action: "channel", params: { payer } }, { label: "It pays later; wait", action: "wait", params: { payer } }]
          : [{ label: "Which channel pays them", action: "channel", params: { payer } }, { label: "They pay monthly; wait", action: "wait", params: { payer } }],
        rows: { payer, claims: e.n, programme: e.programme },
      });
    } else if (e.cycle !== null && e.dueCents >= 500_00) {
      out.push({
        id: `claims_due|${payer}`,
        kind: "claims_due",
        rank: 3,
        title: `${payer}: ${e.dueN} claims past its ${e.cycle}-day cycle, ${money(e.dueCents)}`,
        detail: `Nine in ten of their payments arrive within ${e.cycle} days of the fill; these are older. ${e.n - e.dueN} more claims (${money(e.cents - e.dueCents)}) are still inside the cycle.`,
        amountCents: e.dueCents,
        href: "/payers/waiting",
        answers: [{ label: "Chase", action: "chase", params: { payer } }, { label: "Looked, they are coming", action: "wait", params: { payer } }],
        rows: { payer, due: e.dueN, cycle: e.cycle },
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
      href: p.proof === "claims_eq_pioneer" ? "/tools/data-health" : p.proof === "remit_to_claim" ? "/claims" : `/money/bank-review?month=${p.scope ?? ""}`,
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
