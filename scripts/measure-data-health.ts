/*
 * Measures Data health in a process of its own.
 *
 * The nightly tick first ran the measurement inside the web server, behind `whenIdle`, and the
 * caveat written on it came true the first morning: the app restarted after a deploy, the tick saw
 * twenty hours had passed and ran on the cold start, the measurement read the whole catalogue and
 * the NADAC table into a process already competing for memory with a test run in another session,
 * and the pharmacist at the counter got no page for a minute and a half. `whenIdle` chooses the
 * moment; it does not shorten the block, and every libsql call blocks the thread that makes it.
 *
 * So the work runs here, where it can take its fifteen seconds without the site noticing, and the
 * tick only starts it. Same store, same rows; only the process differs.
 *
 * Run as:  node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/measure-data-health.ts
 */
import "dotenv/config";
import { measureDataHealth } from "../src/lib/data-health-store";
import { setSetting } from "../src/lib/settings";

async function main(): Promise<void> {
  const r = await measureDataHealth();
  await setSetting("data_health_last", new Date().toISOString());
  process.stdout.write(JSON.stringify({ measured: r.measured, skipped: r.skipped, tookMs: r.tookMs }) + "\n");
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(1);
});
