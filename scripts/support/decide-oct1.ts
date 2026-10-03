import "dotenv/config";
/* His answers of 1 October, afternoon: WholeScripts noted as OTC purchases; the drawer week settled as 16-19 Sept, $30.00 short. */
async function main() {
  const { db, schema } = await import("../../src/db");
  const { like, and, eq } = await import("drizzle-orm");
  const { decideBankLine, replaceUnplaced, lastStatementLines } = await import("../../src/app/(app)/money/bank");
  const user = await db.query.users.findFirst({ columns: { id: true, name: true } });
  if (!user) throw new Error("no user");
  for (const l of await db.query.bankLines.findMany({ where: and(like(schema.bankLines.description, "Purch WHOLESCRIPTS%"), eq(schema.bankLines.placedAs, "unplaced")) })) {
    console.log(JSON.stringify(await decideBankLine(l.id, { kind: "noted", category: "Drug purchases (OTC)", note: "Xymogen OTC products bought through WholeScripts by card. PioneerRx's receipts from Xymogen are for different amounts, so this waits for WholeScripts' own invoice. The owner, 1 October 2026: \"ignore wholescript for now but categorize correctly\"." }, user)));
  }
  const drawer = await db.query.bankLines.findFirst({ where: and(eq(schema.bankLines.on, "2026-09-23"), eq(schema.bankLines.amountCents, 111276)) });
  if (drawer) console.log(JSON.stringify(await decideBankLine(drawer.id, { kind: "confirms_run", from: "2026-09-16", to: "2026-09-19", note: "The register's 16-19 September came to $1,142.76; the bank received $1,112.76. The 19th cannot belong to the next deposit (that one is 21-29 September to within a dollar), so this is the four days, $30.00 short." }, user)));
  const r = await replaceUnplaced(["2026-09"], user);
  console.log(`${r.tried} re-placed: ${r.said}`);
  const { unplaced } = await lastStatementLines(["2026-09"]);
  console.log(`still open: ${unplaced.length}`);
  for (const u of unplaced.sort((a, b) => a.on.localeCompare(b.on))) console.log(`   ${u.on} ${(u.amountCents / 100).toFixed(2).padStart(11)}  ${u.description.slice(0, 40).padEnd(40)}  ${(u.why ?? "").slice(0, 100)}`);
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 900)); process.exit(1); });
