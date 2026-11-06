/**
 * Money the pharmacy has earned and not been paid, in one list, with the document that would settle each pot.
 *
 * ── Why this exists ──
 *
 * The site can already say what every payer owes (`payer-owed.ts`), what each claim is waiting for (`ar-report.ts`) and
 * which feeds are late (`feeds.ts`). None of them answers the question the owner actually asks, which is: what is my
 * money doing, and who do I have to chase this morning? A payer table sorted by name does not, because the answer is
 * one or two lines in it; a claim-level report does not, because 1,717 claims waiting is not a job.
 *
 * So this is the pots, largest first, each with the one thing that would settle it. Three kinds of pot:
 *
 *   a payer that bills and has never sent a document the site reads   the biggest and the quietest
 *   a programme that pays vouchers after the fact                     RedSail, Veridikal, the Aytu top-off
 *   money the pharmacy has taken but not banked                       card batches never forwarded, and the like
 *
 * ── What it must never do ──
 *
 * Call anything late without a cycle to call it late against. `payer-owed.ts` has refused invented deadlines since
 * 9 September and this refuses them too: a pot says how long it has been waiting and, where the site knows the payer's
 * cycle, whether that is past it. Where it does not, it says the cycle is not on file — which is itself a job, and a
 * better one than a red flag somebody learns to ignore.
 *
 * Pure. `money-waiting-store.ts` does the reading.
 */

export type WaitingKind = "payer" | "programme" | "unbanked";

export type WaitingInput = {
  /** One per payer or programme that has billed inside the books. */
  pots: {
    key: string;
    name: string;
    bin: string | null;
    kind: WaitingKind;
    claims: number;
    billedCents: number;
    receivedCents: number;
    outstandingCents: number;
    /** The fill date of the oldest claim billed to it. */
    oldestOn: string | null;
    /** The day something last arrived from it, where anything has. */
    lastPaidOn?: string | null;
    /** What the pharmacy is told settles this pot, where somebody has said. Never guessed. */
    settledBy?: string | null;
  }[];
  /** Money taken and not banked: a card batch never forwarded, a deposit nothing explains. */
  unbanked: { key: string; name: string; cents: number; on: string; settledBy: string; href: string }[];
  today: string;
};

export type WaitingRow = {
  key: string;
  kind: WaitingKind;
  name: string;
  /** The BIN, where the pot is a payer: four of this pharmacy's payers print the same name under different ones. */
  bin: string | null;
  /** What is waiting, in money. */
  cents: number;
  /** How long the oldest of it has been waiting, in days. Null where nothing dates it. */
  waitingDays: number | null;
  /** The sentence under the figure: what this is. */
  what: string;
  /** The one thing that would settle it, and who has to do it. */
  settles: string;
  href: string;
  /** True where nothing has ever arrived from this pot. The quiet ones. */
  neverAnything: boolean;
};

export type Waiting = {
  rows: WaitingRow[];
  totalCents: number;
  /** Of the total, what has never had anything arrive at all. */
  neverAnythingCents: number;
  /** One sentence for the top of the screen. */
  says: string;
};

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function days(from: string | null | undefined, to: string): number | null {
  if (!from) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** The pots of money waiting on somebody, largest first. Anything settled, or settled to the cent, is not in it. */
export function moneyWaiting(input: WaitingInput): Waiting {
  const rows: WaitingRow[] = [];

  for (const p of input.pots) {
    if (p.outstandingCents <= 0) continue;
    const neverAnything = p.receivedCents === 0;
    const waitingDays = days(p.oldestOn, input.today);
    const part = p.receivedCents > 0 ? `${money(p.receivedCents)} of ${money(p.billedCents)} has arrived` : `nothing has arrived`;
    rows.push({
      key: p.key,
      kind: p.kind,
      name: p.name,
      bin: p.bin,
      cents: p.outstandingCents,
      waitingDays,
      what:
        p.kind === "programme"
          ? `${p.claims} claim${p.claims === 1 ? "" : "s"} carry a voucher this programme pays after the plan, and ${part}.`
          : `${p.claims} claim${p.claims === 1 ? "" : "s"} billed, and ${part}.`,
      settles: p.settledBy
        ? p.settledBy
        : neverAnything
          ? "No document has ever settled one of its claims, and none is named. Say what settles it, or ask the payer how it remits."
          : "It has paid before, so its next remittance settles this. Nothing to do unless it stops.",
      /* The payer table, not the payer's own page: four payers here share a name across BINs, so the name opens the wrong one. */
      href: p.kind === "programme" ? "/payers/ar" : "/payers/owed",
      neverAnything,
    });
  }

  for (const u of input.unbanked) {
    rows.push({
      key: u.key,
      kind: "unbanked",
      name: u.name,
      bin: null,
      cents: u.cents,
      waitingDays: days(u.on, input.today),
      what: "Taken at the counter and not in the cash account, because the document that banks it has not arrived.",
      settles: u.settledBy,
      href: u.href,
      neverAnything: true,
    });
  }

  rows.sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
  const totalCents = rows.reduce((n, r) => n + r.cents, 0);
  const neverAnythingCents = rows.filter((r) => r.neverAnything).reduce((n, r) => n + r.cents, 0);
  const quiet = rows.filter((r) => r.neverAnything).length;
  return {
    rows,
    totalCents,
    neverAnythingCents,
    says:
      rows.length === 0
        ? "Nothing is waiting: every claim billed has been settled, and everything taken at the counter is banked."
        : `${money(totalCents)} is waiting on somebody, across ${rows.length} payer${rows.length === 1 ? "" : "s"} and programme${rows.length === 1 ? "" : "s"}. ` +
          (quiet > 0
            ? `${money(neverAnythingCents)} of it is from ${quiet} that ${quiet === 1 ? "has" : "have"} never sent anything the site reads — the money nobody would notice the absence of.`
            : "Every one of them has paid before, so this is money in transit rather than money to chase."),
  };
}
