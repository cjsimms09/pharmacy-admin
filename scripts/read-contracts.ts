/*
 * Reads the whole contract library from the command line, in a process of its own.
 *
 * The site can already do every step of this from its pages — adopt the folder, index the text,
 * sort what is worth reading, send documents to the reader, collect the results, apply what is
 * certain. What the pages cannot do is run the library end to end: a press sends at most forty
 * scans, answers in a minute, and leaves the rest for the next press; the results come back from
 * the batch API in their own time; and every libsql call blocks the web server for as long as it
 * runs. Three hundred and fifty-seven documents is an afternoon of presses, or this.
 *
 * It does nothing the pages do not do, through the same functions, so what it writes is exactly
 * what a person pressing the buttons would have written. It only loops, waits, and reports.
 *
 * ── Stages, run one at a time ──
 *
 *   survey            free. Adopts new files, indexes text, recovers stale failures, sorts every
 *                     document that has a text layer by rule, sends the scans to the small model
 *                     for sorting, and prints what a read would cost — text-layer documents and
 *                     scans separately, because the two cost very different money.
 *   read [--scans]    paid. Sends every document worth reading and not yet read, text-layer ones
 *                     only unless --scans; waits for the batch API; collects; repeats until nothing
 *                     is left. Chunked so no single send exceeds the monthly ceiling.
 *   apply             applies everything certain across every read document (applyAllReads) and
 *                     prints what was deferred and why.
 *
 * Run as:  node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/read-contracts.ts <stage>
 * Progress is one JSON object per line on stdout, like scripts/make-claude-copy.ts.
 */
import "dotenv/config";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { adoptUnattached, contractLibrary, applyAllReads } from "../src/lib/contract-docs";
import { indexContracts, contractIndexState } from "../src/lib/contract-search";
import { queueExtraction, collectExtraction, recoverFailures, queueTriage, collectTriage } from "../src/lib/contract-extract";
import { shouldRead, type TriageKind } from "../src/lib/contract-triage";
import { estimateCost } from "../src/lib/contract-run";
import { monthlyCap, rates as priceRates } from "../src/lib/ai-spend";
import { getSettings } from "../src/lib/settings";

const say = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dollars = (n: number) => `$${n.toFixed(2)}`;

/** The reads are audited under a real user, as the pages do; the first owner on file. */
async function who(): Promise<{ id: string; name: string }> {
  const u = (await db.query.users.findMany()).sort((a, b) => (a.role === "owner" ? -1 : 1) - (b.role === "owner" ? -1 : 1))[0];
  if (!u) throw new Error("No user on file to audit the run under.");
  return { id: u.id, name: `${u.name} (contract run)` };
}

type Doc = typeof schema.contractDocs.$inferSelect;

/** Whether a document's file has a text layer, from the index; null where it was never indexed. */
async function textLayer(): Promise<Map<string, boolean>> {
  const rows = await db.query.contractText.findMany({ columns: { fileName: true, chars: true, source: true } });
  const out = new Map<string, boolean>();
  for (const r of rows) if (r.fileName) out.set(r.fileName, (r.chars ?? 0) > 0 && r.source !== "read");
  return out;
}

async function survey() {
  const u = await who();
  say({ step: "adopting files with no row" });
  const adopted = await adoptUnattached();
  say({ adopted });

  say({ step: "indexing text (free)" });
  const idx = await indexContracts();
  say({ indexed: idx });

  say({ step: "recovering stale failures (free)" });
  const rec = await recoverFailures(u.id, u.name);
  say({ recovered: { batches: rec.batches, gone: rec.gone, stillRunning: rec.stillRunning, recovered: rec.recovered, explained: rec.explained.length, note: rec.note } });
  for (const e of rec.explained.slice(0, 10)) say({ explained: e });

  say({ step: "sorting: text-layer documents by rule, scans by the small model" });
  let scansLeft = Infinity;
  const sorts: unknown[] = [];
  while (scansLeft > 0) {
    const t = await queueTriage(u.id, u.name);
    sorts.push({ sortedByText: t.sortedByText, sentToModel: t.sentToModel, batches: t.batches.length, skipped: t.skipped.length, estimate: t.estimate, scansLeft: t.scansLeft });
    scansLeft = t.scansLeft;
    if (t.sentToModel === 0 && t.sortedByText === 0) break;
  }
  say({ sorts });

  await report();
}

/** What is left to read and what it would cost, text-layer and scans apart. */
async function report() {
  const lib = await contractLibrary();
  const s = await getSettings();
  const model = (s.ai_model ?? "").trim() || "claude-opus-5";
  const rates = await priceRates();
  const cap = await monthlyCap();
  const hasText = await textLayer();
  const docs = await db.query.contractDocs.findMany();

  const tally = { text: { docs: 0, pages: 0, low: 0, high: 0 }, scan: { docs: 0, pages: 0, low: 0, high: 0 }, done: 0, failed: 0, queued: 0, ruledOut: 0, unsorted: 0, tooBig: 0 };
  for (const d of docs) {
    if (!d.fileName) continue;
    if (d.extractionState === "done") { tally.done++; continue; }
    if (d.extractionState === "queued") { tally.queued++; continue; }
    if (d.extractionState === "failed") tally.failed++;
    if (d.triage === "not_relevant") { tally.ruledOut++; continue; }
    if (!d.triage && !d.triageBatch) tally.unsorted++;
    if ((d.pages ?? 0) > 300) { tally.tooBig++; continue; }
    const pages = d.pages ?? 12;
    const est = estimateCost(pages, model, rates);
    const side = hasText.get(d.fileName) === false ? tally.scan : tally.text;
    side.docs++; side.pages += pages; side.low += est.low; side.high += est.high;
  }
  say({
    library: { files: lib.filesInFolder, rows: docs.length, done: tally.done, failed: tally.failed, queued: tally.queued, ruledOut: tally.ruledOut, unsorted: tally.unsorted, tooBig: tally.tooBig, model, keyPresent: lib.keyPresent },
    textLayer: { docs: tally.text.docs, pages: tally.text.pages, cost: `${dollars(tally.text.low)}–${dollars(tally.text.high)}` },
    scans: { docs: tally.scan.docs, pages: tally.scan.pages, cost: `${dollars(tally.scan.low)}–${dollars(tally.scan.high)}` },
    ceiling: { cap: cap.cap, spentOnOtherAi: dollars(cap.spent), left: cap.cap === null ? "none" : dollars(cap.left) },
    index: await contractIndexState(),
  });
}

/** Waits for every queued batch, collecting as results land. */
async function drain(u: { id: string; name: string }, everyMs: number) {
  for (;;) {
    const c = await collectExtraction(u.id, u.name);
    say({ collected: { done: c.done, failed: c.failed, stillRunning: c.stillRunning, rejected: c.rejected.length } });
    for (const r of c.rejected) say({ rejected: r });
    if (c.stillRunning === 0) return;
    await sleep(everyMs);
  }
}

async function read(scans: boolean) {
  const u = await who();
  // Anything the sort sent to the small model and never collected is collected first, free.
  const tc = await collectTriage(u.id, u.name);
  say({ triageCollected: tc });

  const hasText = await textLayer();
  const s = await getSettings();
  const model = (s.ai_model ?? "").trim() || "claude-opus-5";
  const rates = await priceRates();

  for (let round = 1; ; round++) {
    const docs = (await db.query.contractDocs.findMany()).filter(
      (d) => d.fileName && d.extractionState !== "done" && d.extractionState !== "queued" && shouldRead(d.triage as TriageKind | null) && (d.pages ?? 0) <= 300,
    );
    // Sorted so the document that has waited longest (a failure, then never-read) goes first; the
    // page count decides the chunking, not the order.
    const wanted = docs.filter((d) => scans || hasText.get(d.fileName!) !== false);
    if (wanted.length === 0) { say({ step: `round ${round}: nothing left to read${scans ? "" : " with a text layer"}` }); break; }

    // Chunk under the ceiling: the queue refuses a send whose high estimate would breach it.
    const cap = await monthlyCap();
    const room = cap.cap === null ? Infinity : Math.max(0, cap.cap - cap.spent) * 0.9;
    const chunk: Doc[] = [];
    let high = 0;
    for (const d of wanted) {
      const est = estimateCost(d.pages ?? 12, model, rates).high;
      if (chunk.length > 0 && high + est > room) break;
      chunk.push(d); high += est;
      if (chunk.length >= 100) break; // the batch's own request limit
    }
    say({ step: `round ${round}: sending ${chunk.length} of ${wanted.length} (${dollars(high)} at most, room ${room === Infinity ? "unlimited" : dollars(room)})` });
    const q = await queueExtraction(u.id, u.name, chunk.map((d) => d.id));
    say({ queued: { queued: q.queued, batches: q.batches.length, skipped: q.skipped.length, estimate: q.estimate } });
    for (const sk of q.skipped.slice(0, 20)) say({ skipped: sk });
    if (q.queued === 0) { say({ step: "the queue accepted nothing; stopping so this does not spin" }); break; }
    await sleep(60_000);
    await drain(u, 3 * 60_000);
  }
  await report();
}

async function apply() {
  const u = await who();
  const r = await applyAllReads({ name: u.name });
  say({ applied: r });
}

async function main() {
  const stage = process.argv[2];
  const scans = process.argv.includes("--scans");
  if (stage === "survey") await survey();
  else if (stage === "read") await read(scans);
  else if (stage === "apply") await apply();
  else if (stage === "report") await report();
  else throw new Error("stage must be survey, read [--scans], apply or report");
  // One document a user is looking at is never touched here, so nothing needs releasing; exit
  // rather than wait on the client's idle handle.
  void eq;
  process.exit(0);
}

main().catch((e) => { say({ error: String(e?.message ?? e) }); process.exit(1); });
