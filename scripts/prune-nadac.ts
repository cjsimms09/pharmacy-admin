/**
 * Prune the NADAC table on its own clock.
 *
 * `pruneNadac` had one caller, inside the loader, reached only when a new weekly file had just been
 * loaded and wrapped in a catch that said nothing. 2 found it on 8 September by writing the proof:
 * 770,000 prices older than the cutoff were still held, and nothing on the site could tell a prune
 * that never ran from one that failed every time. A pharmacy that stops receiving NADAC files also
 * stopped pruning, which is the wrong way round.
 *
 * So the prune is a nightly job in its own process (a delete over a million rows blocks the event
 * loop like every other libsql call), run before the NADAC proof so the proof measures the table
 * as it should be. What it did and any error go to `nadac_last_prune` for Data health.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/prune-nadac.ts
 */
import "dotenv/config";

async function main() {
  const started = Date.now();
  const { pruneNadac } = await import("../src/lib/nadac");
  const { setSetting } = await import("../src/lib/settings");
  try {
    const removed = await pruneNadac();
    const line = `${new Date().toISOString()}: removed ${removed.toLocaleString("en-US")} prices in ${Date.now() - started}ms`;
    await setSetting("nadac_last_prune", line);
    console.log(line);
  } catch (e) {
    const line = `${new Date().toISOString()}: failed: ${e instanceof Error ? e.message : String(e)}`;
    await setSetting("nadac_last_prune", line);
    console.error(line);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
