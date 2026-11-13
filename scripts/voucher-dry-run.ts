import "dotenv/config";
import { claimShares } from "../src/lib/payer-owed";
import { chooseClaimForRemittance, type ClaimCandidate } from "../src/lib/match-remittance";
import { VERIDIKAL_CLAIM_FEE_CENTS } from "../src/lib/veridikal-report";

/**
 * What would happen when RedSail and Veridikal pay for this month's fills — run against the real
 * claims, today, without waiting for the remittance.
 *
 * The owner, 16 September 2026: "we should still be able to test our logic.. we know what we get from
 * claims, know what we get on veridikal and redsail... does our logic make snese.. we should still be
 * able to test this".
 *
 * Nothing on file has matched a claim yet — every voucher payment the site holds is for a fill
 * between 30 April and 25 August, and these books begin on 1 September — so the live proof has to
 * wait for a September remittance in late October. The logic does not. Both halves are known: the
 * claims are here with their voucher columns, and the two programmes' file shapes are here in the
 * hundred and forty-nine rows they have already sent. What sits between them is ours.
 *
 * So this builds the row each programme would send for each of this month's voucher claims — the
 * amount from the claim's own columns, the keys from the fields their files carry — and runs it
 * through the same matcher and the same share arithmetic the real import uses. Not a copy of them:
 * the same functions.
 *
 * READ-ONLY. It writes nothing, stores nothing and is safe to run at any time.
 *
 *   npx tsx scripts/voucher-dry-run.ts
 */

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const { db } = await import("../src/db");
  const { SITE_STARTS_ON } = await import("../src/lib/books-start");
  const c = (db as unknown as { $client: { execute: (s: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;

  const rows = await c.execute(
    `select id, rx_number, fill_number, date_filled, ndc11, bin, remit_cents, status,
            evoucher_cents, evoucher_message_cents, evoucher_programme
       from claims
      where date_filled >= '${SITE_STARTS_ON}'
        and (coalesce(evoucher_cents,0) > 0 or coalesce(evoucher_message_cents,0) > 0)`,
  );

  /* Every paid claim on those prescriptions, which is what the matcher is offered in real life. */
  const byRx = new Map<string, ClaimCandidate[]>();
  const all = await c.execute(
    `select id, rx_number, fill_number, date_filled, ndc11, bin, remit_cents, evoucher_cents, evoucher_message_cents
       from claims where status = 'paid' and date_filled >= '${SITE_STARTS_ON}'`,
  );
  for (const r of all.rows) {
    const rx = String(r.rx_number);
    const list = byRx.get(rx) ?? [];
    list.push({
      id: String(r.id),
      fillNumber: r.fill_number === null ? null : Number(r.fill_number),
      dateFilled: String(r.date_filled),
      ndc11: r.ndc11 === null ? null : String(r.ndc11),
      bin: r.bin === null ? null : String(r.bin),
      remitCents: r.remit_cents === null ? null : Number(r.remit_cents),
      /* Which row of a coordinated fill a manufacturer programme could be paying. */
      carriesVoucher: Number(r.evoucher_cents ?? 0) > 0 || Number(r.evoucher_message_cents ?? 0) > 0,
    });
    byRx.set(rx, list);
  }

  let n = 0;
  let planTotal = 0;
  let programmeTotal = 0;
  let feeTotal = 0;
  let matched = 0;
  let wrongClaim = 0;
  let ambiguous = 0;
  let unmatched = 0;
  let reversed = 0;
  let splitDoesNotAddUp = 0;
  const byProgramme = new Map<string, { n: number; cents: number }>();
  const problems: string[] = [];

  for (const r of rows.rows) {
    n++;
    const remit = Number(r.remit_cents ?? 0);
    const share = claimShares({
      remitCents: remit,
      evoucherCents: Number(r.evoucher_cents ?? 0),
      evoucherMessageCents: Number(r.evoucher_message_cents ?? 0),
      evoucherProgramme: (r.evoucher_programme as string) ?? null,
    });
    planTotal += share.planCents;
    programmeTotal += share.programmeCents;
    feeTotal += share.unpaidFeeCents;
    const key = share.programme ?? "(none)";
    const cur = byProgramme.get(key) ?? { n: 0, cents: 0 };
    cur.n++;
    cur.cents += share.programmeCents;
    byProgramme.set(key, cur);

    /* The arithmetic that must never fail: the two shares and the unpaid fee are the whole net. */
    if (share.planCents + share.programmeCents + share.unpaidFeeCents !== remit) {
      splitDoesNotAddUp++;
      problems.push(`a ${key} claim's shares come to ${money(share.planCents + share.programmeCents + share.unpaidFeeCents)} against a net of ${money(remit)}`);
    }

    if (String(r.status) !== "paid") {
      reversed++;
      continue;
    }

    /*
     * The row that programme would send. RedSail's 835 carries the prescription, the service date,
     * the NDC and the amount; Veridikal's summary carries those and the BIN, and pays the voucher
     * plus its $2.50 claim fee.
     */
    const veridikal = /veridikal/i.test(key);
    const line = {
      fillNumber: null,
      dateFilled: String(r.date_filled),
      ndc11: r.ndc11 === null ? null : String(r.ndc11),
      amountCents: share.programmeCents || (veridikal ? VERIDIKAL_CLAIM_FEE_CENTS : null),
      bin: veridikal ? (r.bin === null ? null : String(r.bin)) : null,
      fromProgramme: true,
    };
    const chosen = chooseClaimForRemittance(byRx.get(String(r.rx_number)) ?? [], line);
    if (chosen.ambiguous) {
      ambiguous++;
      problems.push(`a ${key} claim could not be told from another on the same prescription: ${chosen.ambiguous.why}`);
    } else if (!chosen.claim) {
      unmatched++;
      problems.push(`a ${key} claim for a fill on ${String(r.date_filled)} matched nothing`);
    } else if (chosen.claim.id !== String(r.id)) {
      wrongClaim++;
      problems.push(`a ${key} payment attached to a different claim on the same prescription (fill of ${chosen.claim.dateFilled} rather than ${String(r.date_filled)})`);
    } else {
      matched++;
    }
  }

  console.log(`\nVoucher claims filled since ${SITE_STARTS_ON}: ${n}\n`);
  console.log(`  the plans owe        ${money(planTotal)}`);
  console.log(`  the programmes owe   ${money(programmeTotal)}`);
  console.log(`  fee nobody pays      ${money(feeTotal)}`);
  console.log(`  ${money(planTotal + programmeTotal + feeTotal)} in all, and every claim's shares add back to its own net: ${splitDoesNotAddUp === 0 ? "yes" : `NO — ${splitDoesNotAddUp} do not`}\n`);
  for (const [k, v] of byProgramme) console.log(`  ${k.padEnd(42)} ${String(v.n).padStart(4)} claims  ${money(v.cents)}`);

  console.log(`\nIf each programme paid its share tomorrow, on the keys their files carry:\n`);
  console.log(`  ${String(matched).padStart(4)} would attach to the right claim`);
  console.log(`  ${String(wrongClaim).padStart(4)} would attach to the WRONG claim`);
  console.log(`  ${String(ambiguous).padStart(4)} would be refused as ambiguous and said so`);
  console.log(`  ${String(unmatched).padStart(4)} would find no claim`);
  console.log(`  ${String(reversed).padStart(4)} are reversed claims, which take no payment`);

  if (problems.length > 0) {
    console.log(`\nWhat would go wrong (${problems.length}, first 12):`);
    for (const p of problems.slice(0, 12)) console.log(`  - ${p}`);
  } else {
    console.log(`\nNothing would go wrong.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(String(e).slice(0, 600));
    process.exit(1);
  });
