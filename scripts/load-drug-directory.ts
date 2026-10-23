/*
 * Fetches the FDA's drug directory and Orange Book and loads them, in a process of its own.
 *
 * Why it is not done in the web server, measured rather than assumed. A's memory audit
 * (docs/audits/2026-09-08-memory.md) put one run of this at a 430 MB peak: the two zips, their
 * decompressed text, the parsed products, the parsed packages, the Orange Book, the joined rows and
 * the slices handed to the insert — as many as eight full-size copies of the same directory alive
 * at once, because each stage builds its output before the previous one can be released. Then
 * 217,773 rows are written inside a single transaction, and every one of those writes is a libsql
 * call on the thread that asked for it, so the site answers nothing while it happens.
 *
 * V8 is the part that makes it permanent. It does not hand freed pages back to the operating system
 * promptly, so the peak of a fetch that ran once at seven in the morning was still the site's
 * resident figure at noon. On 8 September the pharmacy's machine ran out of memory twice with the
 * owner at the counter, and this was the largest single thing on it.
 *
 * A process fixes it completely and cheaply, because the operating system takes the memory back
 * when the process exits — all of it, at once, with no dependence on when a garbage collector feels
 * like running. `scripts/make-claude-copy.ts` and `scripts/import-claims.ts` are the same treatment
 * for the same reason; this is the third and the biggest.
 *
 * It writes one JSON object per line on stdout so the parent can show where it has got to while it
 * runs. `src/lib/drug-directory-store.ts` starts it and reads that.
 *
 * Run as:  node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/load-drug-directory.ts <userId>
 */
import "dotenv/config";
import { fetchDrugDirectoryHere } from "../src/lib/drug-directory-store";

/** One JSON object per line, so the parent reads it as it arrives rather than at the end. */
function say(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function main(): Promise<void> {
  /*
   * The user id is who to record against the load, and "scheduler" where a timer started it rather
   * than a person. It is written to `drug_directory_loads.loaded_by`, so an empty argument would be
   * a load nobody can be asked about — hence the fallback rather than a silent null.
   */
  const userId = process.argv[2] || null;

  const result = await fetchDrugDirectoryHere({ userId }, { say: (step) => say({ step }) });

  /*
   * The whole result travels back, and it is small on purpose: five counts or one sentence. The
   * parent's `DirectoryLoad` and this are the same type from the same file, so the two sides cannot
   * drift the way the copy job's did.
   */
  say({ result });
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  say({ result: { ok: false, why: e instanceof Error ? e.message : String(e) } });
  process.exit(1);
});
