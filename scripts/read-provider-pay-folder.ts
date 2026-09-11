/**
 * Reads whatever is sitting in the watched ProviderPay folders, as the site's own sweep does.
 *
 * The /remits page has a button for this, but the button needs a signed-in manager and the owner is
 * usually at another machine. This is the same call, for checking a month after a download: it says
 * what was read, what matched, and what it could not make sense of.
 *
 * Nothing here is special-cased for testing. Money received before the books begin is flagged
 * out-of-books by the import itself, so a month pulled to prove that matching works never reaches a
 * total, whichever way the sweep was started.
 *
 * Run: `tsx --tsconfig tsconfig.test.json scripts/read-provider-pay-folder.ts`
 */
import "dotenv/config";

async function main() {
  const { remittanceDirs, sweepRemittances } = await import("../src/lib/claim-payments");
  const dirs = await remittanceDirs();
  console.log("watching:");
  for (const d of dirs) console.log("  " + d);
  console.log("");

  const r = await sweepRemittances({ name: "Folder read" });
  const money = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

  console.log("files seen:         " + r.files);
  console.log("remittances read:   " + r.read);
  console.log("claim payments:     " + r.payments);
  console.log("amount:             " + money(r.amountCents));
  console.log("matched to a claim: " + r.matched);
  console.log("held, no claim:     " + r.unmatched);
  if (r.alsoRead.length) {
    console.log("\nalso read:");
    for (const a of r.alsoRead) console.log("  - " + a);
  }
  if (r.problems.length) {
    console.log("\nproblems (" + r.problems.length + "):");
    for (const p of r.problems.slice(0, 20)) console.log("  - " + p);
    if (r.problems.length > 20) console.log("  ... and " + (r.problems.length - 20) + " more");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
