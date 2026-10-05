import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/*
 * The commit hook runs `npx tsx scripts/check-identifiers.ts` with nothing to stand in for `server-only`, so anything that script
 * reaches which imports it throws there. It did, through src/lib/settings.ts, and the hook's reading of the pharmacy's own numbers
 * failed into the sentence "NOT checked" on every commit until 5 October 2026, while three tracked lines carried one of them.
 */
const resolveRelative = (from: string, rel: string): string | null => {
  const base = path.resolve(path.dirname(from), rel);
  return [base, `${base}.ts`, path.join(base, "index.ts")].find((f) => fs.existsSync(f) && fs.statSync(f).isFile()) ?? null;
};

/** Every file the script reaches by a relative import, itself included. */
function reached(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of fs.readFileSync(file, "utf8").matchAll(/(?:from\s*|import\(\s*)["'](\.\.?\/[^"']+)["']/g)) {
      const next = resolveRelative(file, m[1]);
      assert.ok(next, `${path.relative(".", file)} imports ${m[1]}, which is no file`);
      walk(next);
    }
  };
  walk(path.resolve(entry));
  return [...seen];
}

test("the commit hook's script reaches no module that is server-only", () => {
  const files = reached("scripts/check-identifiers.ts");
  assert.ok(files.length >= 2, "it reaches the scanner as well as itself");
  const guarded = files.filter((f) => /^import\s+["']server-only["']/m.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(".", f));
  assert.deepEqual(guarded, [], "these throw under a plain `npx tsx`, which is how the hook runs");
});

test("the hook reads the pharmacy's own numbers from the database file at the site's default path", () => {
  const script = fs.readFileSync("scripts/check-identifiers.ts", "utf8");
  assert.match(script, /DATABASE_PATH \?\? "\.\/data\/pharmacy-admin\.db"/, "the default is the site's own, as src/db/index.ts has it");
  assert.match(script, /pharmacy_npi/);
  assert.match(script, /pharmacy_ncpdp/);
  assert.match(script, /pharmacy_dea/);
});
