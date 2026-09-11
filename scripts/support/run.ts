import "dotenv/config";
async function main() {
  const { checkInvoicePrices } = await import("../../src/lib/invoice-price-check");
  const r = await checkInvoicePrices();
  console.log(`checked ${r.checked} invoices against a PioneerRx delivery; ${r.agreeing} agree throughout; ${r.linesCompared} drugs compared`);
  console.log(`${r.disagreements.length} disagreements; overbilled $${(r.overbilledCents/100).toFixed(2)}`);
  console.log(`${r.unchecked.length} invoices had no delivery to check against\n`);
  for (const d of r.disagreements) console.log(`[${d.kind}] ${d.say}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
