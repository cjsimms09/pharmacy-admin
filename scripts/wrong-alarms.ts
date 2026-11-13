import "dotenv/config";

/**
 * The morning check's wrong alarms: every time the owner pressed "This is wrong" on a line of Today's card, kept until somebody has said
 * what was done about it. A session reads these first, before it builds anything new — each one is a check that said something untrue
 * on a screen he looked at, and the count is the nearest measure of whether the site is learning (it covers the morning-check card only).
 *
 *   npx tsx --tsconfig tsconfig.script.json scripts/wrong-alarms.ts                      what is open, and the count
 *   npx tsx --tsconfig tsconfig.script.json scripts/wrong-alarms.ts answer <id> <text>   says what was done (the first characters of the id will do)
 *
 * Prints what the card showed him, with long digit runs masked. Days are his days, as the card showed them, not the UTC day a stamp
 * is stored under.
 */
const mask = (s: string) => s.replace(/\d{9,}/g, "#########");

/** The message of an error and of what caused it: the database's own words are one or two levels down from "Failed query: …". */
const causes = (e: unknown): string => {
  const parts: string[] = [];
  for (let c: unknown = e, i = 0; c && i < 5; i++, c = (c as { cause?: unknown }).cause) parts.push(String((c as Error).message ?? c));
  return parts.join(" | ");
};

async function main() {
  const { openWrongAlarms, wrongAlarms, answerWrongAlarm } = await import("../src/lib/check-marks");
  const { atLocal } = await import("../src/lib/dates");
  const day = (stamp: string) => atLocal(stamp).slice(0, 10);
  const [verb, id, ...rest] = process.argv.slice(2);
  if (verb === "answer") {
    const done = await answerWrongAlarm(id ?? "", rest.join(" "));
    console.log(`answered ${done.id}`);
    return;
  }
  const [open, count] = await Promise.all([openWrongAlarms(), wrongAlarms()]);
  console.log(
    count.total === 0
      ? "Nobody has pressed \"This is wrong\" on the morning check yet."
      : `${count.total} time${count.total === 1 ? "" : "s"} "This is wrong" has been pressed since ${count.since ? day(count.since) : "the start"}; ${count.lastThirtyDays} in the last 30 days; ${open.length} not yet answered.`,
  );
  for (const a of open) {
    console.log(`\n${a.id.slice(0, 8)}  ${day(a.at)}  ${a.key}  (${a.stillStands ? "still set aside" : "no longer set aside"})`);
    console.log(`  Should be: ${mask(a.what)}`);
    console.log(`  Found:     ${mask(a.observed)}`);
    if (a.note) console.log(`  He wrote:  ${mask(a.note)}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(
      /no such table: check_marks/i.test(causes(e))
        ? "This database has no check_marks table, because the migration that adds it has not been applied here, so what was pressed cannot be read or answered."
        : String(e instanceof Error ? e.message : e).split("\n")[0],
    );
    process.exit(1);
  },
);
