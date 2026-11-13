import "dotenv/config";
import { readFileSync } from "node:fs";

/**
 * Records a rule the engine reads (src/lib/engine/rules.ts).
 *
 *   tsx scripts/support/set-rule.ts <kind> <key> <path to a JSON file holding the value> [said by]
 *
 * The value comes from a file so a sentence with quotes in it survives the shell.
 */
async function main(): Promise<void> {
  const [kind, key, file, by] = process.argv.slice(2);
  if (!kind || !key || !file) throw new Error("kind, key, and a JSON file");
  const { setRule, rules } = await import("../../src/lib/engine/rules");
  await setRule({ kind, key, value: JSON.parse(readFileSync(file, "utf8")), saidBy: by ?? "the owner" });
  console.log((await rules()).map((r) => `${r.kind} ${r.key} = ${JSON.stringify(r.value).slice(0, 140)} (${r.saidBy}, ${r.saidOn})`).join("\n"));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(String(e).slice(0, 300));
    process.exit(1);
  },
);
