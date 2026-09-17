import "server-only";
import { db } from "@/db";
import { judgeAll, expectedSummary, type Expectation, type Judged } from "./expected";

/**
 * What the pharmacy is waiting on, read from what has actually arrived.
 *
 * The catalogue below is the list of everything somebody outside this building is supposed to send,
 * and it is written by hand on purpose. A list generated from what has arrived can only ever contain
 * things that arrive, so the one document nobody ever sent — the one this page exists to find —
 * would be the one entry missing from it. Four of the rows here have never delivered once.
 *
 * Each row's arrival is counted from the table the reader fills, not from a job's claim to have run,
 * for the same reason `feeds.ts` does it: a reader that silently stopped storing looks identical to
 * a sender that stopped sending, and only the stored row tells them apart.
 *
 * ── The cadences here are a fallback, not the answer ──
 *
 * Every row hands `judge` the dates it has actually arrived on, and the rhythm measured from those
 * beats the one written here (`cadence-learn.ts`). The owner: "this tool needs to be smart and know
 * when to expect things.. and adjust as needed". Ten arrivals of McKesson's drill-down say more
 * about McKesson's rhythm than any number typed into this file, and they say it better every week.
 *
 * What is written here survives for the rows that have never arrived — which cannot be measured, by
 * definition, and are exactly the rows that matter most. Every row says which of the two it used, so
 * a date nobody has measured is never mistaken for one that was.
 */

type Client = { execute: (sql: string, args?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
const sql = () => (db as unknown as { $client: Client }).$client;
const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" ? Number(v) || 0 : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export type ExpectedNow = {
  readAt: string;
  rows: Judged[];
  summary: ReturnType<typeof expectedSummary>;
};

export async function expectedNow(opts: { today?: string } = {}): Promise<ExpectedNow> {
  if (!opts.today) {
    const { held } = await import("./held");
    const { todayIso } = await import("./dates");
    return held(`expected:${todayIso()}`, () => load(todayIso()));
  }
  return load(opts.today);
}

async function load(today: string): Promise<ExpectedNow> {
  const c = sql();
  const [routes, routeDays, claims, onHand, bank, sales, nadac, catalogue, invoices, plan835, cardBatches] = await Promise.all([
    c.execute("select routed_as as k, count(*) as n, max(received_at) as at from inbox_items group by routed_as"),
    /*
     * Every distinct day each route has ever delivered on, so the rhythm can be measured instead of
     * declared (`cadence-learn.ts`). One day, not one message: two invoices in a morning is one
     * arrival, because the question is when the sender sends.
     */
    c.execute("select routed_as as k, substr(received_at, 1, 10) as d from inbox_items group by routed_as, substr(received_at, 1, 10) order by d"),
    c.execute("select max(date_filled) as at, count(*) as n from claims"),
    c.execute("select max(counted_on) as at, count(*) as n from on_hand_imports"),
    c.execute('select max("on") as at, count(*) as n from bank_lines'),
    c.execute("select max(period_to) as at, count(*) as n from sales_months"),
    c.execute("select max(file_as_of) as at, count(*) as n from nadac_prices"),
    c.execute("select max(created_at) as at, count(*) as n from supplier_imports"),
    c.execute("select max(invoice_date) as at, count(*) as n from supplier_invoices"),
    c.execute("select max(received_on) as at, count(*) as n from claim_payments where source = 'plan'"),
    c.execute("select max(received_on) as at, count(*) as n from cash_receipts where source_key like 'card-batch|%'"),
  ]);

  const byRoute = new Map<string, { n: number; at: string | null }>();
  for (const r of routes.rows) byRoute.set(String(r.k ?? ""), { n: num(r.n), at: str(r.at) });
  const daysByRoute = new Map<string, string[]>();
  for (const r of routeDays.rows) {
    const k = String(r.k ?? "");
    const d = str(r.d);
    if (!d) continue;
    const list = daysByRoute.get(k) ?? [];
    list.push(d);
    daysByRoute.set(k, list);
  }
  /*
   * The hour of day each route usually lands, measured from its own timestamps.
   *
   * A report that runs at 23:31 is not late at nine in the morning, and saying it is puts a row amber
   * through the whole working day, every day. See arrivalHour.
   */
  const stamps = await c.execute("select routed_as as k, received_at as at from inbox_items where received_at >= date('now', '-60 days')");
  const stampsByRoute = new Map<string, string[]>();
  for (const r of stamps.rows) {
    const k = String(r.k ?? "");
    const at = str(r.at);
    if (!at) continue;
    stampsByRoute.set(k, [...(stampsByRoute.get(k) ?? []), at]);
  }
  const { arrivalHour } = await import("./cadence-learn");
  const route = (k: string) => ({ ...(byRoute.get(k) ?? { n: 0, at: null }), days: daysByRoute.get(k) ?? [], hour: arrivalHour(stampsByRoute.get(k) ?? []) });
  const table = (r: { rows: Record<string, unknown>[] }) => ({ n: num(r.rows[0]?.n), at: str(r.rows[0]?.at) });

  /*
   * The days each table's own feed delivered on, for the same measurement.
   *
   * Newest 60, not all of them: a sender's rhythm this quarter is the one being judged, and a
   * pattern it kept in the spring should not hold a verdict about this week. Sixty days of a daily
   * feed is two months; sixty of a monthly one is five years, which is more history than any of
   * these have.
   */
  const daysOf = async (q: string): Promise<string[]> => {
    const r = await c.execute(q);
    return r.rows.map((x) => str(x.d)).filter((x): x is string => x !== null);
  };
  /*
   * Invoices are not judged by a rhythm at all. They are judged by the receipts.
   *
   * The owner, 16 September 2026, in three messages: "mckesson is about the only invoice we receive
   * daily.. dont alert me we havent gotten an anda invoice in 7 days"; "we are getting receipts from
   * pioneer. so for invoices it should use those for alerts.. but only on companies that are set to
   * receive invoices like parmed, anda, ipd, ipc, and mckesson"; "everything else we are usiong
   * pioneer receipt as invoice".
   *
   * He is right, and it makes the clever part unnecessary. ANDA's silence means nothing on its own —
   * no delivery, no invoice, nothing wrong. What means something is a delivery PioneerRx booked in
   * with no invoice behind it, because then a document exists somewhere and the pharmacy does not
   * have it. That is an event, not a calendar, and `invoicesStillOwed()` already measures it against
   * the wholesalers' own invoice numbers.
   *
   * So: one row per supplier that actually sends invoices, and no row at all for the ones where the
   * receipt is the invoice — which is most of them, and none of them can ever raise anything here.
   */
  /*
   * What each sender sent that the site refused to take — and still has not got.
   *
   * Veridikal, 15 September 2026: both monthly reports arrived and both were refused for their
   * declared type. This page then reported Veridikal as having never sent anything, which is the one
   * conclusion guaranteed to send him after the wrong person.
   *
   * ── And then the opposite fault, on the same row, the next morning ──
   *
   * He forwarded both. They were read: 62 eVoucher rows and 41 conversions, $8,848.91 between them,
   * on the site and reconciled. This row went on saying "the site turned them away... forward the
   * message again" — advice to do a thing he had already done, about a fault that was already fixed.
   *
   * The alert had it right and this did not, which is the worse half: two places asking one question
   * and giving different answers, and the one he happened to read was the wrong one. So both now use
   * `refusalsWorthReporting` — a refusal stops counting the moment the same document arrives, from
   * any address, which is how a forward fixes it.
   */
  const refusedRaw = await c.execute(
    "select from_address, subject, received_at, reason, status from inbox_items where status != 'stored' and received_at >= date('now', '-45 days')",
  );
  const storedRaw = await c.execute(
    "select from_address, subject, received_at from inbox_items where status = 'stored' and received_at >= date('now', '-45 days')",
  );
  const asSwept = (rows: Record<string, unknown>[]) =>
    rows.map((r) => ({
      fromAddress: String(r.from_address ?? ""),
      subject: String(r.subject ?? ""),
      receivedAt: String(r.received_at ?? ""),
      reason: str(r.reason),
      status: str(r.status),
    }));
  const { refusalsWorthReporting } = await import("./inbox-refusals");
  const outstanding = refusalsWorthReporting(asSwept(refusedRaw.rows), asSwept(storedRaw.rows));
  const refusedBy = (like: string) => {
    const mine = outstanding.filter((m) => m.fromAddress.toLowerCase().includes(like));
    if (mine.length === 0) return undefined;
    const newest = mine.reduce((a, b) => (b.receivedAt > a.receivedAt ? b : a));
    return { count: mine.length, last: newest.receivedAt, why: newest.reason ?? "" };
  };

  /* RedSail's remittance arrives over SFTP as an 835, not by email, so it is counted where it lands. */
  const [redsail, redsailDays] = await Promise.all([
    c.execute("select max(received_on) as at, count(*) as n from claim_payments where lower(payer) like '%redsail%'"),
    daysOf("select distinct received_on as d from claim_payments where lower(payer) like '%redsail%' and received_on is not null order by d desc limit 60"),
  ]);

  const { invoicesStillOwed } = await import("./invoices");
  const owed = (await invoicesStillOwed()).filter((o) => !o.receiptIsTheInvoice && o.received > 0);

  const [claimDays, onHandDays, bankDays, nadacDays, catalogueDays, plan835Days, cardBatchDays, mtf, mtfDays, wells, wellsDays] = await Promise.all([
    daysOf("select distinct date_filled as d from claims where date_filled is not null order by d desc limit 60"),
    daysOf("select distinct counted_on as d from on_hand_imports where counted_on is not null order by d desc limit 60"),
    daysOf('select distinct substr("on", 1, 10) as d from bank_lines where "on" is not null order by d desc limit 60'),
    daysOf("select distinct file_as_of as d from nadac_prices where file_as_of is not null order by d desc limit 60"),
    daysOf("select distinct substr(created_at, 1, 10) as d from supplier_imports order by d desc limit 60"),
    daysOf("select distinct received_on as d from claim_payments where source = 'plan' and received_on is not null order by d desc limit 60"),
    daysOf("select distinct received_on as d from cash_receipts where source_key like 'card-batch|%' and received_on is not null order by d desc limit 60"),
    c.execute("select max(received_on) as at, count(*) as n from claim_payments where source = 'mtf'"),
    daysOf("select distinct received_on as d from claim_payments where source = 'mtf' and received_on is not null order by d desc limit 60"),
    /*
     * The Wells Fargo / ProviderPay account history, found the same way the monthly checklist finds
     * it — by the portal's own file name. Nobody sends this one: he downloads it on the first of the
     * month, so the arrival that counts is the day it was filed here.
     */
    c.execute("select max(uploaded_at) as at, count(*) as n from documents where file_name like '%ransaction%istory%'"),
    daysOf("select distinct substr(uploaded_at, 1, 10) as d from documents where file_name like '%ransaction%istory%' order by d desc limit 60"),
  ]);

  /* When each PioneerRx pull last ran: the arrival, for feeds whose content is dated a day behind. */
  const pullRows = await c.execute("select key, value from settings where key in ('pioneer_pull_claims_on','pioneer_pull_on_hand_on')");
  const pullRan = {
    claims: str(pullRows.rows.find((r) => r.key === "pioneer_pull_claims_on")?.value),
    onHand: str(pullRows.rows.find((r) => r.key === "pioneer_pull_on_hand_on")?.value),
  };

  const t = {
    claims: table(claims),
    onHand: table(onHand),
    bank: table(bank),
    sales: table(sales),
    nadac: table(nadac),
    catalogue: table(catalogue),
    invoices: table(invoices),
    plan835: table(plan835),
    cardBatches: table(cardBatches),
  };

  const list: Expectation[] = [
    // ── Every open day, out of PioneerRx ──
    {
      key: "claims",
      label: "Claims export",
      from: "PioneerRx",
      whyItMatters: "Every reimbursement figure on the site is built from these fills. A day missing is a day of income nobody can see.",
      cadence: { kind: "daily", skipSundays: true },
      graceDays: 1,
      /*
       * When the export last ran, not the newest fill on it.
       *
       * A daily export of yesterday's fills is always a day behind by design, so judged on the
       * newest fill date this row said "Due" every single day of its life. What is being asked is
       * whether the export arrived, and the pull records exactly that.
       */
      lastAt: pullRan.claims ?? t.claims.at,
      everCount: t.claims.n,
      expected: true,
      arrivals: claimDays,
      href: "/claims",
    },
    {
      key: "on_hand",
      label: "Balance on hand",
      from: "PioneerRx",
      whyItMatters: "Without a count nothing can be told short, and the shelf value in the books is last week's.",
      cadence: { kind: "daily", skipSundays: true },
      arrivesByHour: route("on_hand").hour,
      graceDays: 1,
      lastAt: t.onHand.at ?? route("on_hand").at,
      everCount: t.onHand.n + route("on_hand").n,
      expected: true,
      arrivals: [...onHandDays, ...route("on_hand").days],
      href: "/purchasing/shelf",
    },
    {
      key: "rx_transactions",
      label: "Rx transaction detail",
      from: "PioneerRx",
      whyItMatters: "What each fill was charged and reversed — the detail behind a claim that a remittance is checked against.",
      cadence: { kind: "daily", skipSundays: true },
      arrivesByHour: route("rx_transactions").hour,
      graceDays: 2,
      lastAt: route("rx_transactions").at,
      everCount: route("rx_transactions").n,
      expected: true,
      arrivals: route("rx_transactions").days,
      href: "/claims",
    },
    {
      key: "card_batch",
      label: "Credit card batch",
      from: "the card terminal",
      whyItMatters: "It banks the day's card takings and carries the card mix.",
      cadence: { kind: "daily", skipSundays: true },
      arrivesByHour: route("card_batch").hour,
      graceDays: 2,
      lastAt: t.cardBatches.at ?? route("card_batch").at,
      everCount: Math.max(t.cardBatches.n, route("card_batch").n),
      expected: true,
      note:
        "A day with no batch is no longer money lost: the register banks that day's card takings itself, and a batch " +
        "arriving later takes the receipt over. Only the card mix is lost with the email.",
      arrivals: [...cardBatchDays, ...route("card_batch").days],
      href: "/money",
    },
    {
      key: "purchase_drilldown",
      label: "McKesson Purchase Drill Down",
      from: "McKesson",
      whyItMatters: "What was bought at what price — the other half of every margin on the site.",
      cadence: { kind: "daily", skipSundays: true },
      arrivesByHour: route("purchase_drilldown").hour,
      graceDays: 2,
      lastAt: route("purchase_drilldown").at,
      everCount: route("purchase_drilldown").n,
      expected: true,
      arrivals: route("purchase_drilldown").days,
      href: "/purchasing",
    },

    // ── Weekly ──
    {
      key: "nadac",
      label: "NADAC pricing file",
      from: "CMS",
      whyItMatters: "The benchmark most Medicaid and some commercial plans pay against. A stale file misprices every comparison.",
      cadence: { kind: "weekly", weekday: 3 },
      graceDays: 3,
      lastAt: t.nadac.at,
      everCount: t.nadac.n,
      expected: true,
      arrivals: nadacDays,
      href: "/nadac",
    },
    {
      key: "catalogue",
      label: "Wholesaler price file",
      from: "PioneerRx, per supplier",
      whyItMatters: "Acquisition cost. Without it a claim cannot be told profitable from loss-making.",
      cadence: { kind: "weekly", weekday: 1 },
      graceDays: 3,
      lastAt: t.catalogue.at ?? route("pioneer_catalog").at,
      everCount: t.catalogue.n + route("pioneer_catalog").n,
      expected: true,
      arrivals: [...catalogueDays, ...route("pioneer_catalog").days],
      href: "/purchasing",
    },

    // ── Monthly, and not expected a day before their date ──
    {
      key: "bank",
      label: "Bank statement",
      from: "Emprise",
      whyItMatters: "The only outside proof that the money the site says arrived actually arrived. Nothing reconciles without it.",
      /*
       * Month end, on his instruction, and not asked for before it.
       *
       * The owner, 17 September 2026: "emprise you get at end of month.. stop asking." The row was
       * set to the 5th of the following month, which is when a statement usually turns up, and it
       * had never arrived — so it sat in "never once arrived" from the day the page was built,
       * every day, about a document he had told me the timing of.
       *
       * Day 31 clamps to the last day of whatever month it is. `startsOn` keeps it quiet until the
       * first one is genuinely owed rather than reporting an absence that is not yet an absence.
       * It is a scan: there is no CSV export, which is why the reader reads a PDF.
       */
      cadence: { kind: "monthly", dayOfMonth: 31 },
      graceDays: 7,
      startsOn: "2026-09-30",
      lastAt: t.bank.at,
      everCount: t.bank.n,
      expected: true,
      note: "He collects this at the end of the month; nothing chases it before then.",
      arrivals: bankDays,
      href: "/money/bank",
    },
    {
      key: "wells_fargo_account",
      label: "Wells Fargo / ProviderPay account history",
      from: "the ProviderPay portal — fetched by hand, nobody sends it",
      whyItMatters:
        "What each payer paid in and what was swept across to the operating account. It is what proves the deposits on the bank statement are the payments on the report and not more money.",
      /*
       * "same with wells fargo" — 17 September 2026, of Emprise's "you get at end of month.. stop
       * asking". He said on the 16th that he fetches it on the first of the month and on the 17th
       * that it should stop asking before then; both describe one thing, which is that it belongs to
       * the month end and not to any day before it.
       */
      cadence: { kind: "monthly", dayOfMonth: 31 },
      graceDays: 5,
      startsOn: "2026-09-30",
      lastAt: str(wells.rows[0]?.at),
      everCount: num(wells.rows[0]?.n),
      expected: true,
      note: "Fetched from the portal at the month end; nothing arrives by itself and nothing chases it before then.",
      arrivals: wellsDays,
      href: "/money",
    },
    {
      key: "sales",
      label: "System Sales Summary",
      from: "PioneerRx",
      whyItMatters: "Retail and patient-paid sales. Without it the books hold prescriptions and nothing else the shop sold.",
      cadence: { kind: "monthly", dayOfMonth: 3 },
      graceDays: 7,
      lastAt: t.sales.at ?? route("accrual_sales").at,
      everCount: t.sales.n,
      expected: true,
      arrivals: route("accrual_sales").days,
      href: "/money",
    },
    {
      key: "ipd_statement",
      label: "IPD statement of account",
      from: "IPD",
      whyItMatters:
        "It says which invoices a credit memo settled. Aytu's top-off credits usually cover the bill, so without the statement the site cannot tell a paid invoice from an unpaid one.",
      /* The owner, 15 September 2026: paid on the 10th and the 25th, by invoice date — the 10th covers the 15th to month end, the 25th the 1st to the 15th. */
      cadence: { kind: "semimonthly", days: [10, 25] },
      graceDays: 5,
      lastAt: route("ipd_statement").at,
      everCount: route("ipd_statement").n,
      expected: true,
      note: "Forwarded to this conversation so far, never to the mailbox — so the site has never read one itself.",
      arrivals: route("ipd_statement").days,
      href: "/invoices",
    },
    {
      key: "veridikal",
      label: "Veridikal voucher report",
      from: "Veridikal",
      whyItMatters: "The eVoucher and denial-conversion money. Every claim carrying a Veridikal message is owed against this report and settled by nothing else.",
      cadence: { kind: "monthly", dayOfMonth: 15 },
      graceDays: 10,
      lastAt: route("veridikal_report").at,
      everCount: route("veridikal_report").n,
      expected: true,
      note: "July's was rehearsed by hand to prove the reader.",
      refused: refusedBy("veridikal"),
      arrivals: route("veridikal_report").days,
      href: "/payers/waiting",
    },
    {
      key: "card_statement",
      label: "Card processing statement",
      from: "the card processor",
      whyItMatters: "The month's card fees, which are a real expense the books do not have, and the deposits to check the batches against.",
      cadence: { kind: "monthly", dayOfMonth: 8 },
      graceDays: 10,
      lastAt: route("card_statement").at,
      everCount: route("card_statement").n,
      expected: true,
      arrivals: route("card_statement").days,
      href: "/money",
    },

    // ── When the event happens. Never "late": there is no date to be late against ──
    /*
     * One row per supplier that sends invoices, judged on deliveries rather than on days elapsed.
     *
     * `waiting` is a delivery PioneerRx booked in, dated after this supplier's invoices started
     * being caught here, with no invoice behind it. Nought waiting is the whole story: however long
     * ago their last invoice was, nothing is owed and nothing is said. That is the ANDA case, and it
     * is silent by construction rather than by a threshold somebody has to keep tuning.
     */
    ...owed
      .sort((a, b) => b.waiting - a.waiting || a.supplier.localeCompare(b.supplier))
      .map((o): Expectation => ({
        key: `invoices:${o.supplier.toLowerCase()}`,
        label: `${o.supplier} invoices`,
        from: o.supplier,
        whyItMatters: "What was bought and what is owed. The archive a board inspection reads, and the cost side of every margin.",
        cadence: { kind: "on_event", says: "one for each delivery PioneerRx books in" },
        graceDays: 0,
        lastAt: o.filingSince,
        everCount: o.received,
        expected: true,
        owing: { outstanding: o.waiting, of: o.received, says: o.says },
        href: "/inventory/invoices",
      })),
    {
      key: "mtf",
      label: "Facilitator payments (MTF)",
      from: "the facilitator",
      whyItMatters: "The 835s for every payer that pays through the facilitator rather than direct — most of the plan money.",
      cadence: { kind: "on_event", says: "pulled by the facilitator's tool" },
      graceDays: 2,
      lastAt: str(mtf.rows[0]?.at),
      everCount: num(mtf.rows[0]?.n),
      expected: true,
      arrivals: mtfDays,
      href: "/remits/mtf",
    },
    {
      key: "remit_835",
      label: "835 remittances",
      from: "each payer, or the facilitator",
      whyItMatters: "What a plan actually paid, line by line. Without one a fill stays owed for ever.",
      cadence: { kind: "on_event", says: "as each payer pays" },
      graceDays: 0,
      lastAt: t.plan835.at ?? route("remittance_835").at,
      everCount: t.plan835.n,
      expected: true,
      arrivals: [...plan835Days, ...route("remittance_835").days],
      href: "/remits",
    },
    {
      key: "payer_payments",
      label: "Third-party payments report",
      from: "the payers' portals",
      whyItMatters: "The deposit side of a remittance: what landed in the account and on what day.",
      cadence: { kind: "on_event", says: "as each payer pays" },
      graceDays: 0,
      lastAt: route("payer_payments").at,
      everCount: route("payer_payments").n,
      expected: true,
      arrivals: route("payer_payments").days,
      href: "/remits",
    },
    {
      key: "accesshealth",
      label: "Health Mart Atlas payment detail",
      from: "Health Mart Atlas",
      whyItMatters: "Itemises an EFT into the claims it paid, which is what lets a deposit be believed.",
      cadence: { kind: "on_event", says: "with each EFT" },
      graceDays: 0,
      lastAt: route("accesshealth_payment").at,
      everCount: route("accesshealth_payment").n,
      expected: true,
      arrivals: route("accesshealth_payment").days,
      href: "/remits",
    },
    {
      key: "copay_remit",
      label: "RedSail voucher remittance",
      from: "RedSail",
      whyItMatters:
        "September carries $7,762.82 of RedSail vouchers across 46 claims. The plan pays the claim net of the voucher; only this remittance pays the voucher.",
      /*
       * Counted where it actually lands, which is not the mailbox.
       *
       * This row read "never arrived" while RedSail's remittance had come in over SFTP the evening
       * before as an 835 — 46 payments, $2,011.64, banked. It was keyed on the copay_remit mail
       * route because that is the door the site was built expecting them to use, and a row keyed on
       * a door rather than on the money is a row that reports a door.
       */
      cadence: { kind: "on_event", says: "cadence not settled — nobody has said how often RedSail remits" },
      graceDays: 0,
      lastAt: str(redsail.rows[0]?.at) ?? route("copay_remit").at,
      everCount: num(redsail.rows[0]?.n) + route("copay_remit").n,
      expected: true,
      note: "Arrives over SFTP as an 835 rather than by email, so it is counted from the payments it posts.",
      arrivals: [...redsailDays, ...route("copay_remit").days],
      href: "/payers/waiting",
    },
    {
      key: "rxrescue",
      label: "RxRescue credit memo",
      from: "RxRescue",
      whyItMatters: "The top-off credit, which is banked as third-party cash on the memo's own day.",
      cadence: { kind: "on_event", says: "cadence not settled" },
      graceDays: 0,
      lastAt: route("rxrescue_credit").at,
      everCount: route("rxrescue_credit").n,
      expected: true,
      arrivals: route("rxrescue_credit").days,
      href: "/remits",
    },
    {
      key: "rebate",
      label: "McKesson rebate breakdown",
      from: "McKesson",
      whyItMatters: "The rebate on the books is an estimate until this arrives, and it is one of the larger numbers in the year.",
      cadence: { kind: "on_event", says: "cadence not settled — the agreement says a rebate, not a date" },
      graceDays: 0,
      lastAt: route("rebate_report").at,
      everCount: route("rebate_report").n,
      expected: true,
      arrivals: route("rebate_report").days,
      href: "/suppliers",
    },
    {
      key: "sales_by_payment",
      label: "Sales by payment type",
      from: "PioneerRx",
      whyItMatters: "How the till was paid — the only thing that checks the card batch and the drawer against the claims.",
      cadence: { kind: "on_event", says: "cadence not settled — nobody has said whether this is scheduled daily" },
      graceDays: 0,
      lastAt: route("sales_by_payment").at,
      everCount: route("sales_by_payment").n,
      expected: true,
      arrivals: route("sales_by_payment").days,
      href: "/money",
    },
    {
      key: "mck_returns",
      label: "McKesson returns and credits",
      from: "McKesson",
      whyItMatters: "A credit that never lands is a bottle paid for twice.",
      cadence: { kind: "on_event", says: "with each return" },
      graceDays: 0,
      lastAt: route("mck_returns").at,
      everCount: route("mck_returns").n,
      expected: true,
      arrivals: route("mck_returns").days,
      href: "/purchasing",
    },
  ];

  /*
   * Everything else that has ever actually arrived, so the page cannot be quietly incomplete.
   *
   * The owner: "needs to include everything we are expecting". The hand-written catalogue above is
   * the only way to list a document nobody has ever sent — a list built from arrivals could never
   * contain one — but it has the opposite blind spot, and it is mine: a feed I did not think to
   * write down is invisible here however faithfully it arrives, and its silence would be invisible
   * too. So every mailbox route that has delivered and is not already covered gets a row of its own,
   * judged by its own measured rhythm like everything else.
   *
   * The two lists together are the whole answer: what we know to expect, and what turns up.
   */
  const covered = new Set([
    "on_hand", "rx_transactions", "card_batch", "purchase_drilldown", "pioneer_catalog", "supplier_catalog", "nadac",
    "accrual_sales", "ipd_statement", "veridikal_report", "card_statement", "invoice", "remittance_835", "payer_payments",
    "accesshealth_payment", "copay_remit", "rxrescue_credit", "rebate_report", "sales_by_payment", "mck_returns", "claims",
    /* Not documents the pharmacy waits on: its own outgoing mail, replies, and reports that ran empty. */
    "training_reply", "not_for_filing", "unrecognised", "empty_report", "return_policy", "postage",
  ]);
  const { kindWords } = await import("./inbox-line");
  for (const [key, v] of byRoute) {
    if (!key || covered.has(key) || v.n === 0) continue;
    list.push({
      key: `route:${key}`,
      label: kindWords(key) ?? key.replace(/_/g, " "),
      from: "the mailbox",
      whyItMatters: "Arriving, and not on the list of things this page was told to expect — so it is listed from what actually comes in.",
      cadence: { kind: "on_event", says: "as it comes" },
      graceDays: 0,
      lastAt: v.at,
      everCount: v.n,
      expected: true,
      arrivals: daysByRoute.get(key) ?? [],
      href: "/inbox",
    });
  }

  const rows = judgeAll(list, today, new Date().getHours());
  return { readAt: new Date().toISOString(), rows, summary: expectedSummary(rows) };
}
