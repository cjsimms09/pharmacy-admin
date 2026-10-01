import { desc, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { compareLines } from "./rank";
import type { Answer } from "./needs-you";

/**
 * What a screen reads. Lookups only: the engine wrote these; nothing here computes.
 *
 * Today is four reads — the open list, the feed states, the latest run of each proof, the months — and nothing
 * else, whatever the day holds. The old home page ran thirty modules' queries on every open.
 */

export type TodayLine = {
  id: string;
  kind: string;
  rank: number;
  title: string;
  detail: string | null;
  amountCents: number | null;
  href: string | null;
  answers: Answer[];
  rows: unknown;
  firstSeen: string;
};

export type TodayView = {
  lines: TodayLine[];
  feeds: { key: string; name: string; state: string; says: string | null; lastDue: string | null; nextDue: string | null }[];
  proofs: { proof: string; scope: string | null; runAt: string; passed: boolean; says: string }[];
  months: (typeof schema.monthStatus.$inferSelect)[];
  engine: { lastRun: string | null; lastRebuild: string | null; error: string | null };
};

export async function todayView(): Promise<TodayView> {
  const [open, feeds, proofs, months, runs] = await Promise.all([
    db.query.needsYou.findMany({ where: isNull(schema.needsYou.resolvedAt) }),
    db.query.feedState.findMany(),
    db.all(sql`select proof, scope, run_at, passed, says from proof_run p where run_at = (select max(run_at) from proof_run q where q.proof = p.proof and coalesce(q.scope, '') = coalesce(p.scope, '')) order by proof, scope`) as Promise<{ proof: string; scope: string | null; run_at: string; passed: number; says: string }[]>,
    db.query.monthStatus.findMany({ orderBy: [desc(schema.monthStatus.month)], limit: 3 }),
    db.query.engineRun.findMany({ orderBy: [desc(schema.engineRun.startedAt)], limit: 6 }),
  ]);
  const lines: TodayLine[] = open
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      rank: r.rank,
      title: r.title,
      detail: r.detail,
      amountCents: r.amountCents,
      href: r.href,
      answers: r.answers ? (JSON.parse(r.answers) as Answer[]) : [],
      rows: r.rowsJson ? JSON.parse(r.rowsJson) : null,
      firstSeen: r.firstSeen,
    }))
    .sort(compareLines);
  const lastRebuild = runs.find((r) => r.kind === "rebuild")?.startedAt ?? null;
  return {
    lines,
    feeds: feeds.map((f) => ({ key: f.key, name: f.name, state: f.state, says: f.says, lastDue: f.lastDue, nextDue: f.nextDue })),
    proofs: proofs.map((p) => ({ proof: p.proof, scope: p.scope, runAt: p.run_at, passed: Boolean(p.passed), says: p.says })),
    months,
    engine: { lastRun: runs[0]?.finishedAt ?? runs[0]?.startedAt ?? null, lastRebuild, error: runs[0]?.error ?? null },
  };
}
