import "dotenv/config";
/* His answers of 1 October on the cheques, recorded on the lines, then the month re-placed. */
async function main() {
  const { db, schema } = await import("../../src/db");
  const { eq, like } = await import("drizzle-orm");
  const { decideBankLine, replaceUnplaced, lastStatementLines } = await import("../../src/app/(app)/money/bank");
  const { updateStandingCost } = await import("../../src/lib/standing-costs");
  const user = await db.query.users.findFirst({ columns: { id: true, name: true } });
  if (!user) throw new Error("no user");
  const lineFor = async (desc: string) => db.query.bankLines.findFirst({ where: like(schema.bankLines.description, `${desc}%`) });

  /* "check for 2625 was for monthly lease and will be every month": the standing cost on file as Rent, $2,625.44 on the 18th, is it. */
  const rent = await db.query.standingCosts.findFirst({ where: eq(schema.standingCosts.name, "Rent") });
  if (rent && rent.amountCents !== 262500) {
    await updateStandingCost(rent.id, { name: "Rent", amountCents: 262500, categoryId: rent.categoryId, vendorId: rent.vendorId, fromMonth: rent.fromMonth, toMonth: rent.toMonth, paidDay: 4, notes: `${rent.notes ?? ""} The owner, 1 October 2026: "monthly lease and will be every month" — $2,625.00 by cheque, clearing on the 4th (was entered as $2,625.44 on the 18th).`.trim() });
    console.log(`Rent standing cost: ${(rent.amountCents / 100).toFixed(2)} day ${rent.paidDay} -> 2625.00 day 4`);
  }
  const c2455 = await lineFor("CHECK 2455");
  if (c2455) console.log(JSON.stringify(await decideBankLine(c2455.id, { kind: "before_books", note: "A drug invoice from before September, paid by cheque. The owner, 1 October 2026: \"1278 check was for drug invoice from before sept\". The books begin 1 September; nothing is booked." }, user)));
  const c2457 = await lineFor("CHECK 2457");
  if (c2457) console.log(JSON.stringify(await decideBankLine(c2457.id, { kind: "books_bill", category: "Licences and registrations", vendor: "Staff reimbursement", note: "Reimbursing a technician for a licence renewal. The owner, 1 October 2026." }, user)));
  const r = await replaceUnplaced(["2026-09"], user);
  console.log(`${r.tried} re-placed: ${r.said}`);
  const { unplaced } = await lastStatementLines(["2026-09"]);
  console.log(`still open: ${unplaced.length}`);
  for (const u of unplaced.sort((a, b) => a.on.localeCompare(b.on))) console.log(`   ${u.on} ${(u.amountCents / 100).toFixed(2).padStart(11)}  ${u.description.slice(0, 40).padEnd(40)}  ${(u.why ?? "").slice(0, 110)}`);
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 900)); process.exit(1); });
