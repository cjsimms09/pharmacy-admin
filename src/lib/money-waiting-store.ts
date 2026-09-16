import "server-only";
import { moneyWaiting, type Waiting, type WaitingInput } from "./money-waiting";

/**
 * The live reading behind `moneyWaiting`: every payer and programme that has billed inside the books and not been
 * settled, plus money taken at the counter that no document has banked.
 *
 * Everything here comes from readings the site already trusts — `owedNow` for the payers and the programmes (which is
 * where a voucher programme's share of a claim becomes its own line), and the register check for card takings with no
 * batch on file. Nothing new is computed about money; this only gathers and ranks.
 */
export async function moneyWaitingNow(): Promise<Waiting> {
  const { held } = await import("./held");
  const { todayIso } = await import("./dates");
  return held(`money-waiting:${todayIso()}`, load);
}

async function load(): Promise<Waiting> {
  const { todayIso } = await import("./dates");
  const { owedNow } = await import("./payer-owed-store");
  const { getSettings } = await import("./settings");
  const today = todayIso();

  const owed = await owedNow();
  /* A programme pays a voucher after the plan and is its own line in `owedNow` (payer-owed.ts claimShares). */
  const programmes = /redsail|veridikal|rxrescue|aytu|copay/i;
  /*
   * What settles each programme, where the site has been told rather than left to guess. A payer whose route nobody has
   * named says so instead; that sentence is the job. These three are measured facts, not assumptions:
   * RedSail's switch sends a voucher remittance (rehearsed on the 1 September one); Veridikal sends two monthly reports
   * (rehearsed on July's); Aytu pays by credit memo applied against IPD's invoices and never as cash (P-5, IPD's own
   * statement). None of the three has yet reached the inbox on live.
   */
  const settlesProgramme = (name: string): string | null => {
    if (/redsail|copay card|ras copay/i.test(name)) {
      return "RedSail's voucher remittance settles this — the statement its switch sends for the vouchers it paid. None has reached the inbox yet: forward one and the site reads it.";
    }
    if (/veridikal|relayhealth/i.test(name)) {
      return "Veridikal's monthly eVoucher and Denial Conversion reports settle these. The reader is built and waiting for a real one to arrive by email.";
    }
    if (/aytu|rxrescue|ipd/i.test(name)) {
      return "An Aytu credit memo settles this, applied against IPD's invoices rather than paid as cash. Forward the memo, or IPD's statement, and both sides land.";
    }
    return null;
  };
  const pots: WaitingInput["pots"] = owed.lines.map((l) => ({
    key: l.key,
    name: l.name,
    bin: l.bin,
    kind: programmes.test(l.name) ? ("programme" as const) : ("payer" as const),
    claims: l.claims,
    billedCents: l.billedCents,
    receivedCents: l.receivedCents,
    outstandingCents: l.outstandingCents,
    oldestOn: l.oldestOn ?? null,
    settledBy: programmes.test(l.name) ? settlesProgramme(l.name) : null,
  }));

  /*
   * Card money taken at the register with no batch report on file. The batch is the only door for card takings
   * (card-batch-store.ts), so until it is forwarded the money is in the bank and not in the books. Measured by the
   * morning pull against PioneerRx's own register totals (register.ts).
   */
  const s = await getSettings();
  const unbanked: WaitingInput["unbanked"] = [];
  try {
    const check = s.pioneer_register_check ? (JSON.parse(s.pioneer_register_check) as { missingBatches?: { day: string; cents: number }[] }) : null;
    for (const m of check?.missingBatches ?? []) {
      unbanked.push({
        key: `card-batch|${m.day}`,
        name: `Card takings of ${m.day}`,
        cents: m.cents,
        on: m.day,
        settledBy: "Forward that day's card batch report to the inbox. It banks the money; nothing else does.",
        href: "/inbox",
      });
    }
  } catch {
    /* A setting that will not parse is not a reason to lose the list. */
  }

  return moneyWaiting({ pots, unbanked, today });
}
