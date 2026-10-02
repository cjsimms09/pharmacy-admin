import { eq } from "drizzle-orm";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import { db, schema } from "@/db";
import { newId } from "../crypto";
import { todayIso } from "../dates";

/**
 * The engine's passes.
 *
 *   refresh   after data lands or a person answers: feeds judged, the months recomputed, the list rebuilt.
 *             Seconds, and safe to run often: everything it writes is keyed, nothing is appended.
 *   rebuild   nightly: refresh, then every proof run and kept.
 *
 * Each pass is a row in engine_run with what it wrote and how long it took, so a silent engine is visible on Today
 * ("the engine last ran at …"). A pass that throws records the error and stops; it never takes the app down and
 * never leaves half a list — the list is rewritten whole on the next pass.
 */

export type EngineReport = { kind: "refresh" | "rebuild"; ms: number; wrote: Record<string, unknown>; error: string | null };

let running: Promise<EngineReport> | null = null;

type PassPlan = { command: string; args: string[] };

/**
 * The pass in a process of its own, where the site has one.
 *
 * A pass loads the catalogue, a quarter of claims, the directory and the shelf to compute what it stores, and when it
 * ran inside the app that memory stayed in the app: 1.4 GB on a computer with 1.3 GB free, measured 2 October 2026.
 * Spawned, it is given back when the child exits. Null where tsx or the script is not on disk — a test, or a
 * checkout that is not this one — and the pass runs here as it always did.
 */
export function enginePassPlan(root: string, exists: (f: string) => boolean = (f) => fsSync.existsSync(f)): PassPlan | null {
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const script = path.join(root, "scripts", "engine-pass.ts");
  const tsconfig = path.join(root, "tsconfig.script.json");
  if (!exists(tsx) || !exists(script) || !exists(tsconfig)) return null;
  return { command: process.execPath, args: [tsx, "--tsconfig", tsconfig, script] };
}

const CHILD_LIMIT_MS = 15 * 60_000;

/** Runs the pass in the child and returns its report; null only where the child could not be started at all. */
function runPassInChild(plan: PassPlan, kind: "refresh" | "rebuild", reason: string): Promise<EngineReport | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (r: EngineReport | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(plan.command, [...plan.args, kind, reason], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PHARMACY_ENGINE_INPROCESS: "1" }, windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      done({ kind, ms: Date.now() - started, wrote: { reason }, error: `The engine pass ran past ${CHILD_LIMIT_MS / 60_000} minutes and was stopped.` });
    }, CHILD_LIMIT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => (stdout += c));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => (stderr += c));
    child.on("error", () => done(null));
    child.on("exit", (code) => {
      const line = stdout.split("\n").filter((l) => l.trim().startsWith("{")).pop();
      if (line) {
        try {
          done(JSON.parse(line) as EngineReport);
          return;
        } catch {
          /* fall through to the error below */
        }
      }
      done({ kind, ms: Date.now() - started, wrote: { reason }, error: `The engine pass stopped without a report (exit ${code}). ${stderr.trim().split("\n").slice(-3).join(" ")}`.trim().slice(0, 500) });
    });
  });
}

export async function engineRefresh(reason: string, opts: { proofs?: boolean; today?: string } = {}): Promise<EngineReport> {
  if (running) return running;
  running = (async () => {
    try {
      if (!opts.today && process.env.PHARMACY_ENGINE_INPROCESS !== "1") {
        const plan = enginePassPlan(process.cwd());
        if (plan) {
          const r = await runPassInChild(plan, opts.proofs ? "rebuild" : "refresh", reason);
          if (r) return r;
        }
      }
      return await passInProcess(reason, opts);
    } finally {
      running = null;
    }
  })();
  return running;
}

/** The pass itself. In the app this runs inside the child; in a test, or where the child cannot start, here. */
async function passInProcess(reason: string, opts: { proofs?: boolean; today?: string } = {}): Promise<EngineReport> {
  {
    const started = Date.now();
    const now = new Date().toISOString();
    /* The pharmacy's own date, not UTC: at nine in the evening in Kansas, UTC is already tomorrow, and a feed due tomorrow is not late. */
    const today = opts.today ?? todayIso();
    const id = newId();
    const kind = opts.proofs ? "rebuild" : "refresh";
    await db.insert(schema.engineRun).values({ id, kind, startedAt: now, wrote: JSON.stringify({ reason }) });
    const wrote: Record<string, unknown> = { reason };
    try {
      const { writeFeedState } = await import("./feeds");
      wrote.feeds = await writeFeedState(now, today);
      const { refreshClaimStanding } = await import("./claims");
      wrote.claims = await refreshClaimStanding(today, now);
      const { monthsToKeep, writeMonth } = await import("./month");
      const months = monthsToKeep(today);
      const figures = [];
      for (const m of months) figures.push(await writeMonth(m, today, now));
      wrote.months = months;
      const { writeCashAhead } = await import("./cash-ahead");
      wrote.cashAhead = await writeCashAhead(today, now);
      const { computeNeedsYou, writeNeedsYou } = await import("./needs-you");
      wrote.needsYou = await writeNeedsYou(await computeNeedsYou(today), now);
      /* The return-soon list, stored: recomputed only when a count, an invoice, a claims file or a price file moved, or the day did. */
      try {
        const { writeReturnSoon } = await import("./return-soon");
        wrote.returnSoon = await writeReturnSoon(today, now, { force: !!opts.proofs });
      } catch (e) {
        wrote.returnSoon = `not computed: ${String(e).slice(0, 160)}`;
      }
      /* The month accounts, stored: the month in progress when anything moved or the day did; closed months overnight. */
      try {
        const { writeMonthAccounts } = await import("./accounts");
        wrote.accounts = await writeMonthAccounts(today, now, { force: !!opts.proofs });
      } catch (e) {
        wrote.accounts = `not computed: ${String(e).slice(0, 160)}`;
      }
      /* The money list, stored: recomputed when anything it reads moved (the held readings' fingerprint), or the day did. */
      try {
        const { writeMoneyFound } = await import("./money-found");
        wrote.moneyFound = await writeMoneyFound(today, now, { force: !!opts.proofs });
      } catch (e) {
        wrote.moneyFound = `not computed: ${String(e).slice(0, 160)}`;
      }
      if (opts.proofs) {
        const p = await import("./proofs");
        const results = [
          ...figures.map((f) => p.bankToCent(f)),
          ...figures.map((f) => p.receiptsToBank(f)),
          await p.claimsEqualPioneer(),
          await p.readerArithmetic(today),
          ...(await Promise.all(months.map((m) => p.remitToClaim(m)))),
          await p.expectedArrived(),
          await p.paymentsOnce(),
        ];
        wrote.proofs = await p.writeProofs(results, now);
        try {
          const { writeOrderFrom } = await import("./order-from");
          wrote.orderFrom = await writeOrderFrom(now);
        } catch (e) {
          wrote.orderFrom = `not computed: ${String(e).slice(0, 160)}`;
        }
        wrote.failed = results.filter((r) => !r.passed).map((r) => `${r.proof}${r.scope ? ` ${r.scope}` : ""}`);
        /* A failed proof is a line on Today; the list is rebuilt once more so it carries them. */
        if ((wrote.failed as string[]).length) wrote.needsYouAfterProofs = await writeNeedsYou(await computeNeedsYou(today), now);
      }
      const ms = Date.now() - started;
      await db.update(schema.engineRun).set({ finishedAt: new Date().toISOString(), ms, wrote: JSON.stringify(wrote) }).where(eq(schema.engineRun.id, id));
      return { kind, ms, wrote, error: null } as EngineReport;
    } catch (e) {
      const ms = Date.now() - started;
      const error = String(e).slice(0, 500);
      await db.update(schema.engineRun).set({ finishedAt: new Date().toISOString(), ms, wrote: JSON.stringify(wrote), error }).where(eq(schema.engineRun.id, id));
      return { kind, ms, wrote, error } as EngineReport;
    }
  }
}

/** Nightly, and the first run after a start: proofs included. */
export async function engineRebuild(reason = "nightly"): Promise<EngineReport> {
  return engineRefresh(reason, { proofs: true });
}

/** For the half-hourly beat: a refresh each time, and a rebuild once a day after two in the morning. */
export async function engineTick(): Promise<void> {
  const last = await db.query.engineRun.findFirst({ where: eq(schema.engineRun.kind, "rebuild"), orderBy: (r, { desc }) => [desc(r.startedAt)], columns: { startedAt: true, finishedAt: true } });
  const hour = new Date().getHours();
  const since = last?.startedAt ? Date.now() - Date.parse(last.startedAt) : Infinity;
  if (hour >= 2 && since > 20 * 60 * 60 * 1000) await engineRebuild("nightly");
  else await engineRefresh("tick");
}

/** After an ingest or an answer. Never awaited by the caller's request; its outcome is on Today either way. */
export function engineAfter(reason: string): void {
  void engineRefresh(reason).catch(() => undefined);
}
