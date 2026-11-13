import "dotenv/config";
/* What on file explains each unplaced September bank line — by arithmetic, before anyone is asked. */
const $ = (c: number) => (c / 100).toFixed(2);
function subsetSum(items: { cents: number; label: string }[], target: number, max = 40): string[] | null {
  const xs = items.slice(0, max);
  const reach = new Map<number, number[]>([[0, []]]);
  for (let i = 0; i < xs.length; i++) {
    for (const [s, path] of [...reach.entries()]) {
      const t = s + xs[i].cents;
      if (t <= target && !reach.has(t)) reach.set(t, [...path, i]);
    }
    if (reach.has(target)) return reach.get(target)!.map((i) => xs[i].label);
  }
  return null;
}
async function main() {
  const { db, schema } = await import("../../src/db");
  const { lastStatementLines } = await import("../../src/app/(app)/money/bank");
  const { unplaced } = await lastStatementLines(["2026-09"]);
  const remits = await db.select().from(schema.remittanceRegister);
  const receipts = await db.select().from(schema.cashReceipts);
  const stmt = await db.select().from(schema.supplierStatementLines);
  const invoices = await db.select().from(schema.supplierInvoices);
  const payments = await db.select().from(schema.supplierPayments);
  const expenses = (await db.select().from(schema.expenses)) as any[];
  const sbp = await db.select().from(schema.salesByPayment);
  const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
  const within = (d: string, from: string, to: string) => d >= from && d <= to;

  console.log(`on file: remits ${remits.length} (sources ${[...new Set(remits.map((r) => r.source))].join(",")}; remitOn ${remits.map((r) => r.remitOn).sort()[0]}..${remits.map((r) => r.remitOn).sort().at(-1)})`);
  console.log(`         receipts ${receipts.length} (kinds ${[...new Set(receipts.map((r) => r.kind))].join(",")}); statement lines ${stmt.length} (${[...new Set(stmt.map((s) => s.supplier))].join(",")}); invoices ${invoices.length}; supplier payments ${payments.length}; expenses ${expenses.length}; sales-by-payment ${sbp.length} (${sbp.map((s) => `${s.periodFrom}..${s.periodTo}`).slice(0, 3).join(" ")}...)`);
  const sorted = [...unplaced].sort((a, b) => a.on.localeCompare(b.on));
  for (const u of sorted) {
    const amt = Math.abs(u.amountCents);
    const d = u.description;
    let verdict = "";
    if (/providerpay\/edi|access health/i.test(d) && u.amountCents > 0) {
      const pool = remits.filter((r) => within(r.remitOn ?? "", addDays(u.on, -4), addDays(u.on, 1))).map((r) => ({ cents: r.amountCents, label: `${r.payerName?.slice(0, 14)} ${r.remitOn} ${$(r.amountCents)}` }));
      const sameDay = remits.filter((r) => r.remitOn === u.on);
      const dayTotal = sameDay.reduce((n, r) => n + r.amountCents, 0);
      const hit = subsetSum(pool, amt);
      verdict = hit ? `= 835s: ${hit.join(" + ")}` : `no subset of ${pool.length} 835s within −4..+1 days; same-day 835s total ${$(dayTotal)} (${sameDay.length})`;
      const rp = receipts.filter((r) => within(r.receivedOn ?? "", addDays(u.on, -4), addDays(u.on, 1))).map((r) => ({ cents: r.amountCents, label: `${(r.payer ?? r.kind).slice(0, 14)} ${r.receivedOn} ${$(r.amountCents)}` }));
      const hit2 = subsetSum(rp, amt);
      if (hit2) verdict += ` | = receipts: ${hit2.join(" + ")}`;
    } else if (/hrtland/i.test(d) && u.amountCents > 0) {
      const cards = receipts.filter((r) => /card/i.test(r.kind) && within(r.receivedOn ?? "", addDays(u.on, -6), u.on)).map((r) => ({ cents: r.amountCents, label: `batch ${r.receivedOn} ${$(r.amountCents)}` }));
      const hit = subsetSum(cards, amt);
      const days = sbp.filter((s) => s.periodFrom === s.periodTo && within(s.periodFrom, addDays(u.on, -6), u.on)).map((s) => ({ cents: s.cardNetCents ?? s.cardCents, label: `sales ${s.periodFrom} card ${$(s.cardNetCents ?? s.cardCents)}` }));
      const hit2 = subsetSum(days, amt);
      verdict = hit ? `= card batches: ${hit.join(" + ")}` : hit2 ? `= daily card sales: ${hit2.join(" + ")}` : `no batch (${cards.length} on file in window) and no day-sales (${days.length}) sums to it; batches: ${cards.map((c) => c.label).join(", ") || "none"}; days: ${days.map((c) => c.label).join(", ") || "none"}`;
    } else if (/mckesson/i.test(d)) {
      const ref = /ACH(\d+)/.exec(d)?.[1] ?? "";
      const byCheck = stmt.filter((s) => /mckesson/i.test(s.supplier) && s.checkNumber && s.checkNumber.replace(/\D/g, "").endsWith(ref.slice(-6)));
      const sum = byCheck.reduce((n, s) => n + s.netCents, 0);
      const byDate = stmt.filter((s) => /mckesson/i.test(s.supplier) && s.clearingDate && within(s.clearingDate, addDays(u.on, -1), addDays(u.on, 1)));
      verdict = byCheck.length ? `McKesson AP report: ${byCheck.length} rows carry this ACH number, net ${$(sum)} ${sum === amt ? "— EXACT" : `(bank ${$(amt)}, off by ${$(amt - sum)})`}` : `AP report has no row with this ACH number; rows clearing ${addDays(u.on, -1)}..${addDays(u.on, 1)}: ${byDate.length}, net ${$(byDate.reduce((n, s) => n + s.netCents, 0))}; check numbers seen: ${[...new Set(stmt.filter((s) => /mckesson/i.test(s.supplier)).map((s) => s.checkNumber))].slice(0, 8).join(",")}`;
    } else if (/independent phar|parmed|anda/i.test(d)) {
      const who = /independent/i.test(d) ? /ipc|independent/i : /parmed/i.test(d) ? /parmed/i : /anda/i;
      const inv = invoices.filter((i) => who.test(i.supplier ?? "") && i.totalCents && within(i.invoiceDate ?? "", addDays(u.on, -45), u.on)).map((i) => ({ cents: i.totalCents!, label: `inv ${i.invoiceDate} ${$(i.totalCents!)}` }));
      const hit = subsetSum(inv, amt);
      const sl = stmt.filter((s) => who.test(s.supplier) && s.netCents > 0).map((s) => ({ cents: s.netCents, label: `stmt ${s.billedOn} ${$(s.netCents)}` }));
      const hit2 = subsetSum(sl, amt);
      verdict = hit ? `= invoices: ${hit.join(" + ")}` : hit2 ? `= statement lines: ${hit2.join(" + ")}` : `no subset of ${inv.length} invoices (last 45 days) or ${sl.length} statement lines sums to it`;
    } else if (/stamps|endicia/i.test(d)) {
      const e = expenses.filter((x) => /endicia|stamps|postage/i.test(`${x.vendor ?? ""} ${x.description ?? ""} ${x.notes ?? ""} ${x.payee ?? ""}`) && x.amountCents === amt);
      verdict = e.length ? `= postage expense ${e.map((x) => `${x.paidOn ?? x.on ?? x.incurredOn} ${$(x.amountCents)}`).join(", ")}` : `no postage expense of ${$(amt)} on file (${expenses.filter((x) => /endicia|stamps|postage/i.test(JSON.stringify(x))).length} postage expenses in all)`;
    } else {
      const e = expenses.filter((x) => x.amountCents === amt);
      const p = payments.filter((x) => x.amountCents === amt);
      const r = receipts.filter((x) => x.amountCents === amt);
      const rm = remits.filter((x) => x.amountCents === amt);
      verdict = [e.length ? `expense ${e.map((x) => `${x.vendorName ?? x.vendor ?? x.payee ?? "?"} ${x.paidOn ?? x.on ?? ""}`).join(",")}` : "", p.length ? `supplier payment ${p.map((x) => `${x.supplier} ${x.paidOn}`).join(",")}` : "", r.length ? `receipt ${r.map((x) => `${x.kind} ${x.payer} ${x.receivedOn}`).join(",")}` : "", rm.length ? `remit ${rm.map((x) => `${x.payerName} ${x.remitOn}`).join(",")}` : ""].filter(Boolean).join(" | ") || "nothing on file for this exact amount";
    }
    console.log(`${u.on} ${$(u.amountCents).padStart(11)}  ${d.slice(0, 34).padEnd(34)}  ${verdict}`);
  }
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
