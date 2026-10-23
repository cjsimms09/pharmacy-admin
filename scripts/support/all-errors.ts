import "dotenv/config";
/**
 * Everything the site currently says is wrong, in one list.
 *
 * The owner: "I need you to look at all errors popping on the site currently... anything that says
 * something isnt right." He had been finding them one screen at a time and sending printouts, which
 * is the site making him do the walking.
 */
import { parsePeriod } from "../../src/lib/ledger";

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const head = (s: string) => console.log(`\n=== ${s} ===`);

async function main() {
  const month = "2026-09";

  head("The account");
  const { accountsFor } = await import("../../src/lib/profit-and-loss");
  for (const basis of ["accrual", "cash"] as const) {
    const { months } = await accountsFor([month], basis);
    const m = months[0];
    console.log(`${basis}: revenue ${money(m.revenueCents)} cogs ${money(m.costOfGoodsCents)} net ${money(m.netProfitCents)}`);
    for (const x of m.missing) console.log(`   MISSING  ${x.slice(0, 118)}`);
    for (const x of m.caveats) console.log(`   CAVEAT   ${x.slice(0, 118)}`);
  }

  head("The books balance");
  const { booksFor } = await import("../../src/lib/ledger-store");
  const period = parsePeriod(month)!;
  const books = await booksFor(period);
  for (const [basis, b] of [["accrual", books.balances.accrual], ["cash", books.balances.cash]] as const) {
    console.log(`${basis}: off by ${money(b.offByCents)}${b.ok ? "" : "  <- DOES NOT BALANCE"}`);
    for (const c of b.checks.filter((x) => !x.ok)) console.log(`   FAILS  ${c.says}: expected ${money(c.expectedCents)}, got ${money(c.actualCents)}`);
  }

  head("Counted twice");
  for (const c of books.countedOnce) {
    if (!c.bothPresent) continue;
    console.log(`   ${c.what}: ${c.says.slice(0, 118)}`);
  }

  head("Claims");
  const { claimFlags } = await import("../../src/lib/claims");
  const f = await claimFlags();
  const b = f.balance;
  console.log(`checked ${b.checkedFills} fills, off by ${money(b.differenceCents)}, ${b.fillsOff} disagree, ${b.unchecked} cannot be checked (${money(b.uncheckedReportMarginCents)})`);
  if (f.unreconciled?.length) console.log(`   ${f.unreconciled.length} fills unreconciled, worst ${money(Math.abs(f.unreconciled[0].unreconciledCents ?? 0))}`);

  head("Invoices");
  const { db, schema } = await import("../../src/db");
  const inv = await db.select().from(schema.supplierInvoices);
  const noDate = inv.filter((i) => !i.invoiceDate);
  const noTotal = inv.filter((i) => i.totalCents === null);
  const noLines = inv.filter((i) => (i.linesRead ?? 0) === 0);
  const noNumber = inv.filter((i) => !(i.invoiceNumber ?? "").trim());
  console.log(`${inv.length} on file`);
  if (noDate.length) console.log(`   ${noDate.length} with no date: ${noDate.map((i) => `${i.supplier} ${money(i.totalCents ?? 0)}`).join("; ").slice(0, 100)}`);
  if (noTotal.length) console.log(`   ${noTotal.length} with no amount read`);
  if (noLines.length) console.log(`   ${noLines.length} with no item lines: ${noLines.map((i) => `${i.supplier} ${money(i.totalCents ?? 0)}`).join("; ").slice(0, 100)}`);
  if (noNumber.length) console.log(`   ${noNumber.length} with no invoice number`);
  const { invoicesFiledTwice } = await import("../../src/lib/books-check");
  const twice = invoicesFiledTwice(inv.map((i) => ({ invoiceNumber: i.invoiceNumber, totalCents: i.totalCents, invoiceDate: i.invoiceDate })));
  if (twice.length) console.log(`   ON FILE TWICE: ${twice.map((t) => `${t.number} x${t.copies} (${money(t.overCents)})`).join(", ")}`);

  head("The inbox");
  const items = await db.select().from(schema.inboxItems);
  const stuck = items.filter((i) => i.status === "stored" && (!i.routedAs || i.routedAs === "unrecognised"));
  console.log(`${items.length} arrivals, ${stuck.length} stored and never sorted`);
  for (const i of stuck) console.log(`   ${String(i.fileName ?? "(no file)").slice(0, 34).padEnd(36)} from ${i.fromAddress}`);

  head("The feeds");
  const { getSettings } = await import("../../src/lib/settings");
  const s = await getSettings();
  for (const k of ["pioneer_pull_claims_result", "pioneer_pull_invoices_result", "pioneer_pull_on_hand_result", "pioneer_pull_retail_result", "sftp_last_result", "mail_last_sweep"] as const) {
    console.log(`   ${k.padEnd(30)} ${String(s[k] ?? "never run").slice(0, 96)}`);
  }

  head("What the site says is blocking it");
  const { moneyFound } = await import("../../src/lib/money-found");
  const mf = await moneyFound();
  console.log(`named as recoverable: ${money(mf.recurringMonthlyCents)}/month across ${mf.rows.length} rows`);
  for (const x of mf.blocked) console.log(`   BLOCKED  ${x.says.slice(0, 114)}`);
}
main().then(() => process.exit(0));
