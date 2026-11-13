/*
 * Makes the scrubbed copy for debugging, in a process of its own.
 *
 * It has to be a separate process, and the reason is measurable rather than tidy-minded. SQLite is
 * a library, not a server: every read and write happens on the thread that asks for it. Reading two
 * hundred thousand rows takes one and three-quarter seconds and, measured with a heartbeat every
 * twenty milliseconds, lets not one of the eighty-four possible beats through. Nothing else on the
 * thread runs. A copy of this pharmacy's database is minutes of that work, so for those minutes the
 * web server cannot answer anything at all — which is precisely what the pharmacist saw: the button
 * pressed, and the page never changed, because the page could not be served.
 *
 * Moving the work here costs one process and fixes it completely. The site stays answerable
 * throughout; this process reports where it has got to on its own output, and the site reads that
 * and writes it to the job record, which is a few bytes at a time and instant.
 *
 * Run as:  node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/make-claude-copy.ts <destination>
 */
import "dotenv/config";
import { writeClaudeCopy } from "../src/lib/backup-scrub";

/** One JSON object per line, so the parent can read it as it arrives rather than at the end. */
function say(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function main(): Promise<void> {
  const destination = process.argv[2];
  if (!destination) {
    say({ result: { ok: false, why: "No destination folder was given to the copy process." } });
    process.exit(1);
  }
  const r = await writeClaudeCopy(destination, (step) => say({ step }));
  /*
   * Only the figures the page prints travel back, not the whole report.
   *
   * The report carries a row count for every table in the site, which is a page of JSON to
   * push through a pipe for two numbers, and — as this got wrong once already — an invitation
   * for the two sides to disagree about the shape.
   */
  const result = r.ok
    ? { ok: true as const, path: r.path, bytes: r.bytes, checked: r.checked, prescriptions: r.report.prescriptions }
    : r;
  say({ result });
  process.exit(result.ok ? 0 : 1);
}

main().catch((e: unknown) => {
  say({ result: { ok: false, why: e instanceof Error ? e.message : String(e) } });
  process.exit(1);
});
