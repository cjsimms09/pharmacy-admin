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
 * Where nobody has said how often something should come, the row says so rather than inventing a
 * cadence. An invented cadence produces a red mark on a day nothing was owed, and the cost of that
 * is not the wrong pixel — it is that the next red mark gets ignored too.
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
  const [routes, claims, onHand, bank, sales, nadac, catalogue, invoices, plan835, cardBatches] = await Promise.all([
    c.execute("select routed_as as k, count(*) as n, max(received_at) as at from inbox_items group by routed_as"),
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
  const route = (k: string) => byRoute.get(k) ?? { n: 0, at: null };
  const table = (r: { rows: Record<string, unknown>[] }) => ({ n: num(r.rows[0]?.n), at: str(r.rows[0]?.at) });

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
      lastAt: t.claims.at,
      everCount: t.claims.n,
      expected: true,
      href: "/claims",
    },
    {
      key: "on_hand",
      label: "Balance on hand",
      from: "PioneerRx",
      whyItMatters: "Without a count nothing can be told short, and the shelf value in the books is last week's.",
      cadence: { kind: "daily", skipSundays: true },
      graceDays: 1,
      lastAt: t.onHand.at ?? route("on_hand").at,
      everCount: t.onHand.n + route("on_hand").n,
      expected: true,
      href: "/purchasing/shelf",
    },
    {
      key: "rx_transactions",
      label: "Rx transaction detail",
      from: "PioneerRx",
      whyItMatters: "What each fill was charged and reversed — the detail behind a claim that a remittance is checked against.",
      cadence: { kind: "daily", skipSundays: true },
      graceDays: 2,
      lastAt: route("rx_transactions").at,
      everCount: route("rx_transactions").n,
      expected: true,
      href: "/claims",
    },
    {
      key: "card_batch",
      label: "Credit card batch",
      from: "the card terminal",
      whyItMatters: "It banks the day's card takings and carries the card mix.",
      cadence: { kind: "daily", skipSundays: true },
      graceDays: 2,
      lastAt: t.cardBatches.at ?? route("card_batch").at,
      everCount: Math.max(t.cardBatches.n, route("card_batch").n),
      expected: true,
      note:
        "A day with no batch is no longer money lost: the register banks that day's card takings itself, and a batch " +
        "arriving later takes the receipt over. Only the card mix is lost with the email.",
      href: "/money",
    },
    {
      key: "purchase_drilldown",
      label: "McKesson Purchase Drill Down",
      from: "McKesson",
      whyItMatters: "What was bought at what price — the other half of every margin on the site.",
      cadence: { kind: "daily", skipSundays: true },
      graceDays: 2,
      lastAt: route("purchase_drilldown").at,
      everCount: route("purchase_drilldown").n,
      expected: true,
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
      href: "/purchasing",
    },

    // ── Monthly, and not expected a day before their date ──
    {
      key: "bank",
      label: "Bank statement",
      from: "Emprise",
      whyItMatters: "The only outside proof that the money the site says arrived actually arrived. Nothing reconciles without it.",
      /* The statement closes at month end and is available in the first days of the next month. It is a scan: there is no CSV export (measured, and the reason the reader reads a PDF). */
      cadence: { kind: "monthly", dayOfMonth: 5 },
      graceDays: 7,
      lastAt: t.bank.at,
      everCount: t.bank.n,
      expected: true,
      note: "Not expected before the month closes. September's is due in the first week of October.",
      href: "/money/bank",
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
      note: "July's was rehearsed by hand to prove the reader. Nothing has come through the mailbox.",
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
      href: "/money",
    },

    // ── When the event happens. Never "late": there is no date to be late against ──
    {
      key: "invoices",
      label: "Supplier invoices",
      from: "every wholesaler",
      whyItMatters: "What was bought and what is owed. The archive that a board inspection reads.",
      cadence: { kind: "on_event", says: "with each delivery" },
      graceDays: 0,
      lastAt: t.invoices.at ?? route("invoice").at,
      everCount: t.invoices.n,
      expected: true,
      href: "/inventory/invoices",
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
      href: "/remits",
    },
    {
      key: "copay_remit",
      label: "RedSail voucher remittance",
      from: "RedSail",
      whyItMatters:
        "September carries $7,762.82 of RedSail vouchers across 46 claims. The plan pays the claim net of the voucher; only this remittance pays the voucher.",
      cadence: { kind: "on_event", says: "cadence not settled — nobody has said how often RedSail remits" },
      graceDays: 0,
      lastAt: route("copay_remit").at,
      everCount: route("copay_remit").n,
      expected: true,
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
      href: "/purchasing",
    },
  ];

  const rows = judgeAll(list, today);
  return { readAt: new Date().toISOString(), rows, summary: expectedSummary(rows) };
}
