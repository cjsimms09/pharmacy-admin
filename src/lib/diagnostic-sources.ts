import "server-only";
import { randomBytes } from "node:crypto";
import { redact, readmeFor, type Bundle } from "./diagnostics";

/**
 * What each page's export actually contains.
 *
 * The one rule that keeps this honest: an export calls the *same function the page calls*. It does
 * not re-query, re-derive or approximate. A page that shows a wrong number must export the same
 * wrong number, because otherwise the export is a second implementation and diagnosing from it
 * means diagnosing the wrong thing — which is exactly the failure this is meant to end.
 *
 * The loaders are imported inside each entry rather than at the top of the file so that opening
 * one page's export does not drag the whole site's server code in behind it.
 */

export type Source = {
  key: string;
  title: string;
  /** Where the button lives, so a listing can link back. */
  href: string;
  /** What the page's own loader returns, plus whatever else that page needs to be understood. */
  load: (params: URLSearchParams) => Promise<{ data: unknown; shownWith?: Record<string, unknown>; notes?: string[] }>;
};

export const SOURCES: Source[] = [
  {
    key: "claims",
    title: "Claims",
    href: "/claims",
    load: async (p) => {
      const { claimFlags, latestClaimDay } = await import("./claims");
      /*
       * The same day the page defaults to, or whatever was searched — otherwise the export answers
       * a different question from the screen it was taken from.
       */
      const day = p.get("day") ?? p.get("from") ?? (await latestClaimDay());
      const to = p.get("to") ?? day;
      const all = p.get("all") === "yes";
      const flags = await claimFlags(all ? { all: true } : { from: day ?? undefined, to: to ?? undefined });
      return {
        data: flags,
        shownWith: { from: day, to, wholeArchive: all },
        notes: [
          `balance: ours ${flags.balance.ourMarginCents}, later ${flags.balance.laterCents}, report ${flags.balance.reportMarginCents}, difference ${flags.balance.differenceCents}`,
          `${flags.balance.fillsOff} fills disagree with the report; ${flags.balance.unchecked} had nothing to check against`,
        ],
      };
    },
  },
  {
    key: "purchasing",
    title: "What to buy",
    href: "/purchasing",
    load: async () => {
      const { buyListNow } = await import("./shelf");
      const { productLedger } = await import("./product-ledger");
      const [buy, ledger] = await Promise.all([buyListNow(), productLedger()]);
      return {
        data: { buyList: buy, ledger: { rate: ledger.rate, materialityCents: ledger.materialityCents, rows: ledger.rows } },
        notes: buy.missing,
      };
    },
  },
  {
    key: "shelf",
    title: "The shelf",
    href: "/purchasing/shelf",
    load: async () => {
      const { leanShelfNow, movement, SHELF_POLICY } = await import("./shelf");
      const [view, move] = await Promise.all([leanShelfNow(), movement()]);
      return {
        data: { policy: SHELF_POLICY, shelf: view, velocity: move },
        shownWith: { window: move ? { from: move.from, to: move.to } : null },
        notes: view.missing,
      };
    },
  },
  {
    key: "supplies",
    title: "Supplies",
    href: "/purchasing/supplies",
    load: async () => {
      const { supplyBoard, recentOrders } = await import("./supplies-store");
      const [board, orders] = await Promise.all([supplyBoard(), recentOrders(50)]);
      /*
       * Every interval, including the ones left out of the rate and why. A supplies question is
       * almost always "why does it think that", and the answer is in the intervals.
       */
      return {
        data: { board, orders },
        notes: board.rows.flatMap((r) => r.rate.problems.map((x) => `${r.name}: ${x}`)),
      };
    },
  },
  {
    key: "monthly",
    title: "Monthly profit and loss",
    href: "/money/monthly",
    load: async (p) => {
      const { monthlyAccount, accountMonths } = await import("./profit-and-loss");
      const months = await accountMonths();
      const month = p.get("month") ?? months[0];
      const basis = p.get("basis") === "cash" ? "cash" : "accrual";
      if (!month) return { data: null, notes: ["No month has anything to report on yet."] };
      const account = await monthlyAccount(month, basis);
      return { data: account, shownWith: { month, basis, monthsAvailable: months }, notes: account.missing };
    },
  },
  {
    key: "report",
    title: "Reports — quarters, years and the trend",
    href: "/money/report",
    load: async (p) => {
      const { periodAccount, monthlyTrend, accountMonths } = await import("./profit-and-loss");
      const { periodsFor, parsePeriod } = await import("./period-account");
      const months = await accountMonths();
      const choices = periodsFor(months);
      const asked = p.get("period");
      const period = asked && parsePeriod(asked) ? asked : (choices.quarters[0] ?? choices.months[0] ?? null);
      const basis = p.get("basis") === "cash" ? "cash" : "accrual";
      if (!period) return { data: null, notes: ["No month has anything to report on yet."] };
      const [totals, trend] = await Promise.all([periodAccount(period, basis), monthlyTrend(24, basis)]);
      return {
        data: { totals, trend },
        shownWith: { period, basis, periodsAvailable: choices },
        notes: [
          ...(totals?.missing ?? []),
          ...(totals && totals.emptyMonths.length > 0 ? [`Nothing recorded in ${totals.emptyMonths.join(", ")}.`] : []),
        ],
      };
    },
  },
  {
    key: "expenses",
    title: "Spending",
    href: "/expenses",
    load: async () => {
      const { categories, vendors, recentExpenses, unpaid, missingThisMonth } = await import("./expenses");
      const [cats, vend, recent, owed, missing] = await Promise.all([
        categories(), vendors(), recentExpenses(500), unpaid(), missingThisMonth(),
      ]);
      return {
        data: { categories: cats, vendors: vend, expenses: recent, unpaid: owed, missingThisMonth: missing },
        notes: missing.map((m) => `${m.vendor.name} bills every month and has not this month`),
      };
    },
  },
  {
    key: "suppliers",
    title: "Suppliers and rebates",
    href: "/suppliers",
    load: async () => {
      const { allSuppliers } = await import("./suppliers-registry");
      const { ratesFor, earningSoFar } = await import("./rebate-rates");
      const { latestRatio } = await import("./purchase-ratio");
      const suppliers = await allSuppliers(true);
      const detail = await Promise.all(
        suppliers.map(async (s) => ({
          supplier: s,
          rates: await ratesFor(s.id).catch(() => null),
          earning: await earningSoFar(s.id).catch(() => null),
        })),
      );
      return { data: { suppliers: detail, ratio: await latestRatio() } };
    },
  },
  {
    key: "returns",
    title: "What to send back",
    href: "/inventory/returns",
    load: async () => {
      const { returnsDueNow } = await import("./returns-due");
      const due = await returnsDueNow();
      return {
        data: due,
        notes: due.suppliersWithoutPolicy.length
          ? [`No return policy on file for ${due.suppliersWithoutPolicy.join(", ")}, so nothing they sold is given a window.`]
          : [],
      };
    },
  },
  {
    key: "payers",
    title: "Who pays best",
    href: "/payers/performance",
    load: async () => {
      const { payerMap, payerTree } = await import("./payer-map");
      const [map, tree] = await Promise.all([payerMap(), payerTree()]);
      return { data: { map, tree } };
    },
  },
  {
    key: "nadac",
    title: "NADAC",
    href: "/nadac",
    load: async () => {
      const { loadedFiles, nadacHealth, nadacCoverage, nadacClaimCoverage } = await import("./nadac");
      const [files, health, coverage, claims] = await Promise.all([
        loadedFiles(), nadacHealth(), nadacCoverage(), nadacClaimCoverage(),
      ]);
      return { data: { files, health, coverage, claimCoverage: claims } };
    },
  },
];

export function sourceFor(key: string): Source | null {
  return SOURCES.find((s) => s.key === key) ?? null;
}

/**
 * What the site itself is, which is half of most diagnoses.
 *
 * A figure that looks wrong is often a figure computed from nothing: no catalogue loaded, no NADAC
 * for those dates, the mailbox off. Counting the rows costs one query each and answers that before
 * anybody has to ask.
 */
async function environment(): Promise<Record<string, unknown>> {
  const { db, schema } = await import("@/db");
  const { getSettings } = await import("./settings");
  const { sql } = await import("drizzle-orm");

  const count = async (table: { _: { name: string } } | unknown, name: string): Promise<number | string> => {
    try {
      const r = await db.get<{ n: number }>(sql.raw(`select count(*) as n from ${name}`));
      return r?.n ?? 0;
    } catch (e) {
      return `unreadable (${e instanceof Error ? e.message : "unknown"})`;
    }
  };
  void schema;

  const s = await getSettings();
  const tables = [
    "claims", "claim_imports", "claim_payments", "invoice_lines", "supplier_invoices", "supplier_items",
    "nadac_prices", "on_hand", "supply_items", "supply_counts", "supply_orders", "expenses", "vendors",
    "suppliers", "sales_months", "plan_groups", "payer_bins",
  ];
  const rows: Record<string, number | string> = {};
  for (const t of tables) rows[t] = await count(null, t);

  return {
    takenAt: new Date().toISOString(),
    version: process.env.npm_package_version ?? null,
    node: process.version,
    rowCounts: rows,
    /*
     * Settings that change what a page computes — never a secret, and never a password. A
     * diagnosis needs to know the mailbox is off; it does not need the mailbox's password.
     */
    settings: {
      pharmacy_name: s.pharmacy_name ?? null,
      mail_enabled: s.mail_enabled ?? null,
      mail_auto_import: s.mail_auto_import ?? null,
      floor_materiality_cents: s.floor_materiality_cents ?? null,
      supplies_rep_email: s.supplies_rep_email ? "(set)" : null,
    },
  };
}

/** Builds the whole file: the page's own data, redacted, with everything needed to read it. */
export async function buildBundle(
  key: string,
  params: URLSearchParams,
): Promise<{ ok: true; bundle: Bundle; filename: string } | { ok: false; why: string }> {
  const source = sourceFor(key);
  if (!source) return { ok: false, why: `No export is defined for “${key}”.` };

  const includeIdentifiers = params.get("identifiers") === "include";
  const salt = randomBytes(16).toString("hex");

  let loaded: Awaited<ReturnType<Source["load"]>>;
  try {
    loaded = await source.load(params);
  } catch (e) {
    /*
     * A page that throws is the most worth exporting of all, so the failure is the export rather
     * than an error page with nothing to send.
     */
    return {
      ok: true,
      filename: `${key}-failed-${new Date().toISOString().slice(0, 10)}.json`,
      bundle: {
        readme: [`The “${source.title}” page failed to compute its data. That failure is what this file carries.`],
        page: key,
        pageTitle: source.title,
        takenAt: new Date().toISOString(),
        shownWith: Object.fromEntries(params),
        environment: await environment().catch(() => ({})),
        privacy: { prescriptionsPseudonymised: 0, distinctPrescriptions: 0, dropped: {}, identifiersIncluded: false },
        notes: ["The page's own loader threw. The message and stack are below."],
        data: { error: e instanceof Error ? { message: e.message, stack: e.stack } : String(e) },
      },
    };
  }

  const { data, report } = redact(loaded.data, { salt, includeIdentifiers });
  const bundle: Bundle = {
    readme: readmeFor({ pageTitle: source.title, identifiersIncluded: includeIdentifiers }),
    page: key,
    pageTitle: source.title,
    takenAt: new Date().toISOString(),
    shownWith: { ...Object.fromEntries(params), ...(loaded.shownWith ?? {}) },
    environment: await environment().catch((e) => ({ unreadable: String(e) })),
    privacy: report,
    notes: loaded.notes ?? [],
    data,
  };
  return { ok: true, bundle, filename: `${key}-${new Date().toISOString().slice(0, 10)}.json` };
}
