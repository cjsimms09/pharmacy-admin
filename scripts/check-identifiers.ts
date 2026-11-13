/**
 * Refuses a commit that carries a real identifier.
 *
 *   npx tsx scripts/check-identifiers.ts            what is staged, which is what a commit hook runs
 *   npx tsx scripts/check-identifiers.ts --all      every text file the repository tracks
 *
 * Install it as the hook:
 *   git config core.hooksPath .githooks
 *
 * The rule is `src/lib/identifier-scan.ts`, pure and tested. This part only decides which files to read, and it reads
 * the STAGED content rather than the working copy — the thing about to be committed is what matters, and they differ
 * exactly when somebody is part-way through fixing one.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findIdentifiers, looksBinary, sayFindings } from "../src/lib/identifier-scan";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/* Files whose whole business is naming these shapes. The rule's own tests and the scanner itself say the words. */
const EXEMPT = [/^src\/lib\/identifier-scan\.ts$/, /^tests\/identifier-scan\.test\.ts$/, /^scripts\/check-identifiers\.ts$/, /^docs\/CONSTITUTION\.md$/];
const BINARY = /\.(png|jpe?g|gif|pdf|ico|woff2?|ttf|zip|db|xlsx?|docx?)$/i;

/**
 * This pharmacy's own registered numbers, read where they actually live rather than written into the repository.
 *
 * The settings hold them; where the database is not reachable — a hook on a machine with no data — OWN_IDENTIFIERS can
 * carry them, comma separated. With neither, the shapes above still run and this one is skipped, and the run says so
 * rather than implying it checked.
 *
 * They are read from the database file itself, at the site's own default path. This used to go through
 * src/lib/settings.ts, which is `server-only` and throws under a plain `npx tsx`, so the hook said "NOT checked" on every
 * commit and the pharmacy's own provider number sat in three tracked lines until it was found on 5 October 2026 by
 * running the check with the stub the scripts use. A check that cannot run and says so in a sentence nobody reads is
 * the same fault as one that passes by looking at nothing.
 */
async function ownIdentifiers(): Promise<{ values: string[]; from: string }> {
  const fromEnv = (process.env.OWN_IDENTIFIERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length) return { values: fromEnv, from: "OWN_IDENTIFIERS" };
  const file = path.resolve(process.env.DATABASE_PATH ?? "./data/pharmacy-admin.db");
  if (!fs.existsSync(file)) return { values: [], from: "" };
  try {
    const { createClient } = await import("@libsql/client");
    const client = createClient({ url: `file:${file}` });
    try {
      const r = await client.execute("select value from settings where key in ('pharmacy_npi', 'pharmacy_ncpdp', 'pharmacy_dea', 'pharmacy_nabp')");
      /* A placeholder such as "n/a" is not an identifier, and as one it would flag every file that says it. */
      const values = r.rows.map((row) => String(row.value ?? "").trim()).filter((v) => v.length >= 7);
      return { values, from: "the site's settings" };
    } finally {
      client.close();
    }
  } catch {
    return { values: [], from: "" };
  }
}

async function main(): Promise<void> {
  const all = process.argv.includes("--all");
  const files = (all ? git("ls-files") : git("diff", "--cached", "--name-only", "--diff-filter=ACMR"))
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !BINARY.test(f) && !EXEMPT.some((re) => re.test(f)));

  const own = await ownIdentifiers();
  const said: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = all ? git("show", `HEAD:${file}`) : git("show", `:${file}`);
    } catch {
      continue; // Not in the index or not in HEAD: nothing to judge.
    }
    /*
     * A file git kept as bytes rather than text. Written as an escape, not as the character itself: a literal NUL in
     * this source made git call this very script binary, and stripping it turned the test into `includes("")` — true of
     * every file, so the checker skipped all 1,123 of them and reported itself clean. A check that passes by looking at
     * nothing is the fault this repository keeps finding; it found it here on 16 September 2026.
     */
    if (text.includes("\u0000")) continue;
    said.push(...sayFindings(file, findIdentifiers(text, file, own.values)));
  }

  const ownSaid = own.values.length
    ? `This pharmacy's own numbers were checked too, from ${own.from}.`
    : "This pharmacy's own numbers were NOT checked: neither OWN_IDENTIFIERS nor a reachable database was given.";
  if (said.length === 0) {
    console.log(`No real identifier in ${files.length} file${files.length === 1 ? "" : "s"}. ${ownSaid}`);
    return;
  }
  console.error(ownSaid);
  console.error(`\nThis carries ${said.length} thing${said.length === 1 ? "" : "s"} that must not reach a public repository:\n`);
  for (const line of said) console.error(`  ${line}`);
  console.error(
    `\nChange the value rather than the check: a fixture keeps its shape with invented numbers, and every identifier in it\n` +
      `has to be changed consistently, or a document that names one thing twice stops naming one thing.\n`,
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(String(e).slice(0, 500));
  process.exit(1);
});
