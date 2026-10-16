/**
 * PioneerRx's database from the command line, for the session on the pharmacy computer.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/pioneer-sql.ts test
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/pioneer-sql.ts tables [needle]
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/pioneer-sql.ts query "select top 5 * from ..."
 *
 * Reads the credentials the owner typed under Settings → Connections; the same read-only rules as
 * src/lib/pioneer-sql.ts, because it is that file. `tables` reads INFORMATION_SCHEMA into
 * data/pioneer-schema.json (names and counts only) and prints what matches the needle.
 */
import "dotenv/config";

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const lib = await import("../src/lib/pioneer-sql");
  if (cmd === "test") {
    const r = await lib.testConnection();
    console.log(r.ok ? `ok in ${r.tookMs}ms: ${r.tables} tables; ${r.version}; ${r.encrypted ? "encrypted" : "NOT encrypted"}` : `failed: ${r.error}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === "tables") {
    let schema = await lib.storedSchema();
    if (!schema || rest.includes("--fresh")) {
      const r = await lib.discoverSchema();
      console.log(`read ${r.tables} tables, ${r.columns} columns in ${r.tookMs}ms`);
      schema = await lib.storedSchema();
    }
    const needle = (rest.find((x) => !x.startsWith("--")) ?? "").toLowerCase();
    for (const t of schema!.tables) {
      const hit = !needle || t.name.toLowerCase().includes(needle) || t.columns.some((c) => c.name.toLowerCase().includes(needle));
      if (!hit) continue;
      console.log(`${t.schema}.${t.name}  (${t.columns.length} cols${t.rows !== null ? `, ${t.rows} rows` : ""})`);
      if (needle) console.log("   " + t.columns.map((c) => `${c.name}:${c.type}`).join("  "));
    }
    return;
  }
  if (cmd === "query") {
    const r = await lib.query(rest.join(" "), {}, Number(process.env.MAX_ROWS ?? 200));
    console.log(r.columns.join("\t"));
    for (const row of r.rows) console.log(r.columns.map((c) => String(row[c] ?? "")).join("\t"));
    console.log(`-- ${r.rows.length} rows in ${r.tookMs}ms`);
    return;
  }
  console.log("usage: pioneer-sql.ts test | tables [needle] [--fresh] | query \"select ...\"");
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
