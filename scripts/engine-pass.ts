/**
 * One engine pass, in a process of its own.
 *
 * The pass loads the catalogue, the claims of the quarter, the directory and the shelf to compute what it stores, and
 * when it ran inside the app that memory stayed in the app: 1.4 GB on a computer with 1.3 GB free, measured 2 October
 * 2026. Run here, it is given back when this exits. The app spawns this (src/lib/engine/run.ts), waits, and reads the
 * one JSON line it prints; the pass itself writes its own engine_run row exactly as before.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/engine-pass.ts <refresh|rebuild> <reason…>
 */
process.env.PHARMACY_ENGINE_INPROCESS = "1";

async function main() {
  const [kind = "refresh", ...rest] = process.argv.slice(2);
  const reason = rest.join(" ") || "child pass";
  const { engineRefresh } = await import("../src/lib/engine/run");
  const r = await engineRefresh(reason, { proofs: kind === "rebuild" });
  process.stdout.write(JSON.stringify(r) + "\n");
  process.exit(r.error ? 1 : 0);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ kind: process.argv[2] ?? "refresh", ms: 0, wrote: {}, error: String(e).slice(0, 500) }) + "\n");
  process.exit(1);
});
