/*
 * Imports one Rx Transaction Details file in a process of its own.
 *
 * The daily file is twenty kilobytes and imports in a moment. The twelve-month history the owner
 * is exporting is hundreds of times that, and every libsql call blocks the thread that makes it —
 * inside the web server, an import of that size is minutes during which no page is served. So the
 * large ones run here, and the site reads this process's progress off its output and shows it.
 * Same reader, same store, same report; only the process differs. See scripts/make-claude-copy.ts
 * for the pattern and the measurement behind it.
 *
 * Run as:  node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/import-claims.ts <file> <fileName> <userId>
 * Output is one JSON object per line: { step } as it goes, { result } or { error } at the end.
 */
import "dotenv/config";
import fs from "node:fs";
import { importRxTransactions, describeTransactionImport } from "../src/lib/claims";

function say(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function main(): Promise<void> {
  const [file, fileName, userId] = process.argv.slice(2);
  if (!file || !fileName || !userId) {
    say({ error: "import-claims needs the file path, the file name and the user id." });
    process.exit(1);
  }
  say({ step: `Reading ${fileName}` });
  const buf = fs.readFileSync(file);
  say({ step: `Importing ${(buf.length / 1024).toFixed(0)} KB` });
  const report = await importRxTransactions(buf, fileName, userId);
  say({
    result: {
      text: describeTransactionImport(report),
      claimsAdded: report.claimsAdded,
      duplicates: report.duplicates,
      skipped: report.skipped,
      reversed: report.reversed,
      period: report.period,
      problems: report.problems.slice(0, 20),
    },
  });
  process.exit(0);
}

main().catch((e) => {
  say({ error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
