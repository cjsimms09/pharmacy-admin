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
    key: "payers",
    title: "A payer, its contracts and how its claims price against them",
    href: "/payers",
    load: async () => {
      const { parseTerms } = await import("./contract-extract");
      const { checkClaim } = await import("./claim-contract");
      const { db } = await import("@/db");

      const contracts: import("./claim-contract").ContractForMatch[] = [];
      // The terms as read, plus how far the claims can actually be checked against them. A question
      // about a payer is nearly always "why is this not being priced", and the answer is one of
      // three: no contract names this plan, the contract names no rate for the fill, or the rate is
      // a MAC that cannot be computed from the contract at all.
      const docs = await db.query.contractDocs.findMany();
      for (const d of docs) {
        if (d.extractionState !== "done") continue;
        const terms = parseTerms(d.extractionJson);
        if (!terms) continue;
        contracts.push({
          documentId: d.id,
          documentName: d.documentName,
          counterparty: terms.counterparty ?? d.pbmName,
          bins: terms.bins ?? [],
          pcns: terms.pcns ?? [],
          groupIds: terms.groupIds ?? [],
          effectiveDate: terms.effectiveDate,
          endDate: terms.endDate,
          rates: (terms.rates ?? []).map((r) => ({
            network: r.network,
            bins: r.bins ?? [],
            pcns: r.pcns ?? [],
            groupIds: r.groupIds ?? [],
            daysSupplyMin: r.daysSupplyMin,
            daysSupplyMax: r.daysSupplyMax,
            brandFormula: r.brandFormula,
            brandDispensingFee: r.brandDispensingFee,
            genericBasis: r.genericBasis,
            genericDispensingFee: r.genericDispensingFee,
            citationQuote: r.citation?.quote ?? null,
          })),
        });
      }

      const claims = await db.query.claims.findMany({ limit: 400 });
      /*
       * What each BIN actually carries, from the claims themselves.
       *
       * A contract naming only a BIN governs every line of business on it, and 67% of this
       * pharmacy's claims sit on a BIN with more than one. Without this the match reads as settled
       * when it is a candidate.
       */
      const shape = new Map<string, { pcns: Set<string>; groups: Set<string> }>();
      for (const c of await db.query.claims.findMany({ columns: { bin: true, pcn: true, groupNumber: true } })) {
        if (!c.bin) continue;
        const e = shape.get(c.bin) ?? { pcns: new Set<string>(), groups: new Set<string>() };
        e.pcns.add(c.pcn ?? "");
        e.groups.add(c.groupNumber ?? "");
        shape.set(c.bin, e);
      }
      const counts = { matched: 0, priced: 0, unmatched: 0, unpriceable: 0, needsConfirming: 0, shortCents: 0, overCents: 0 };
      const examples: unknown[] = [];
      for (const c of claims) {
        const r = checkClaim(
          {
            bin: c.bin, pcn: c.pcn, groupNumber: c.groupNumber, dateFilled: c.dateFilled,
            daysSupply: c.daysSupply, remitCents: c.remitCents, awpCents: c.awpCents,
            acquisitionCents: c.acquisitionCents, isBrand: null,
          },
          contracts,
          c.bin ? { pcns: shape.get(c.bin)?.pcns.size ?? 1, groups: shape.get(c.bin)?.groups.size ?? 1 } : null,
        );
        if (!r.matched) counts.unmatched++;
        else {
          counts.matched++;
          if (!r.matched.why.confident) counts.needsConfirming++;
          if (r.priced?.ok) counts.priced++;
          else counts.unpriceable++;
        }
        if (r.differenceCents !== null) {
          if (r.differenceCents < 0) counts.shortCents += -r.differenceCents;
          else counts.overCents += r.differenceCents;
        }
        if (examples.length < 20 && (r.matched || counts.unmatched <= 5))
          examples.push({ bin: c.bin, pcn: c.pcn, group: c.groupNumber, filled: c.dateFilled, days: c.daysSupply, remitCents: c.remitCents, awpCents: c.awpCents, check: r });
      }

      return {
        data: { contracts, counts, examples },
        shownWith: { contractsOnFile: contracts.length, claimsChecked: claims.length },
        notes: [
          "Every contract read, as the site holds it, and every claim run against them.",
          "A claim that matches no contract, or matches one with no computable rate, is the usual reason a payer shows nothing.",
        ],
      };
    },
  },
  {
    key: "catalog",
    title: "The supplier catalogue",
    href: "/purchasing/catalog",
    load: async (p) => {
      const { searchCatalogue, catalogueHealth } = await import("./catalogue");
      const [health, found] = await Promise.all([
        catalogueHealth(),
        // The rows that do not add up, whatever the screen was filtered to: a question about the
        // catalogue is always about one of those.
        searchCatalogue({ text: p.get("q") ?? undefined, supplier: p.get("supplier") ?? undefined, problemsOnly: true, limit: 400 }),
      ]);
      return {
        data: { health, problems: found.rows },
        shownWith: { matched: found.matched, showing: found.rows.length },
        notes: [
          `${health.total.toLocaleString()} items held; ${health.wrong.toLocaleString()} do not add up and ${health.worthChecking.toLocaleString()} are worth a look.`,
          "The first four hundred problem rows only, worst first — the whole catalogue would be a file nobody can send.",
        ],
      };
    },
  },
  {
    /*
     * The invoice file, which is where most of what has gone wrong here has gone wrong: a statement
     * that would not leave, a drill down offered as an invoice, a delete that took the wrong row.
     * All three were invisible from outside, and all three are answerable from this.
     */
    key: "invoices",
    title: "Supplier invoices",
    href: "/inventory/invoices",
    load: async () => {
      const { invoices, awaitingReview, invoiceCounts, invoiceIssues, adoptableDocuments, misfiledInVault, missingTotals, invoicesWithoutLines, awaitingReceipt } =
        await import("./invoices");
      const { invoiceCompliance } = await import("./invoice-compliance");
      const [filed, review, counts, issues, adoptable, misfiled, compliance, noAmount, noLines, unreceipted] = await Promise.all([
        invoices({}),
        awaitingReview(),
        invoiceCounts(),
        invoiceIssues(),
        adoptableDocuments(),
        misfiledInVault(),
        invoiceCompliance(),
        missingTotals(),
        invoicesWithoutLines(),
        awaitingReceipt(),
      ]);
      return {
        data: { filed, awaitingReview: review, counts, issues, adoptable, misfiled, compliance, unreceipted },
        shownWith: { noAmount, noLines },
        notes: [
          `${filed.length} filed, ${adoptable.length} offered for filing, ${misfiled.length} in the invoice folder that do not read as invoices.`,
          "Every filed row carries its document id, so a row that will not go away can be traced to what it points at.",
        ],
      };
    },
  },
  {
    key: "cqi",
    title: "CQI programme",
    href: "/cqi",
    load: async () => {
      const { currentCqiObligation, incidentsWithStage, carriedForward } = await import("./cqi");
      const { db } = await import("@/db");
      const obligation = await currentCqiObligation();
      const [rows, summaries, carried] = await Promise.all([
        incidentsWithStage(),
        db.query.cqiSummaries.findMany({ orderBy: (x, { desc }) => [desc(x.periodStart)] }),
        carriedForward(obligation.period.periodStart),
      ]);
      return {
        data: { obligation, summaries, incidents: rows, carried },
        notes: [`The period actually outstanding is ${obligation.period.label}, due ${obligation.period.dueOn}.`],
      };
    },
  },
  {
    key: "deliveries",
    title: "The delivery round",
    href: "/deliveries",
    load: async (p) => {
      const { monthState, invoiceParties, allInvoices, monthsWithDays } = await import("./deliveries");
      const { todayIso } = await import("./dates");
      const month = p.get("month") ?? todayIso().slice(0, 7);
      const [state, parties, invoices, months] = await Promise.all([monthState(month), invoiceParties(), allInvoices(), monthsWithDays()]);
      return { data: { state, parties, invoices }, shownWith: { month, monthsWithDays: months } };
    },
  },
  {
    key: "temps",
    title: "Temperatures",
    href: "/temps",
    load: async () => {
      const { db } = await import("@/db");
      const [sensors, notes] = await Promise.all([db.query.tempSensors.findMany(), db.query.tempNotes.findMany()]);
      const readings = await db.query.tempReadings.findMany({ orderBy: (r, { desc }) => [desc(r.takenAt)], limit: 2000 });
      return {
        data: { sensors, notes, readings },
        notes: ["The two thousand most recent readings only — the whole history would be a file nobody can send."],
      };
    },
  },
  {
    key: "staff",
    title: "People and credentials",
    href: "/staff",
    load: async () => {
      const { db } = await import("@/db");
      const [people, credentials, assignments] = await Promise.all([
        db.query.people.findMany(),
        db.query.credentials.findMany(),
        db.query.trainingAssignments.findMany(),
      ]);
      return {
        data: { people, credentials, assignments },
        notes: ["Staff are the pharmacy's own employees, so names are kept: they are not patient information."],
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

/**
 * Which export belongs to the page somebody is looking at.
 *
 * The button used to be added to pages one at a time, and reached eleven of a hundred and one. The
 * ninety it never reached were the ones where a figure looked wrong and there was no way to send
 * the figure — which is precisely backwards, because a page nobody thought to instrument is a page
 * nobody has checked.
 *
 * So the button lives in the frame now and asks this which source to use. Longest match wins, so
 * /purchasing/shelf gets the shelf's export rather than purchasing's, and anything with no source
 * of its own still exports — see `genericBundle` — rather than offering a button that does nothing.
 */
export function sourceForPath(pathname: string): Source | null {
  const path = (pathname || "/").split("?")[0].replace(/\/+$/, "") || "/";
  let best: Source | null = null;
  for (const s of SOURCES) {
    const href = s.href.replace(/\/+$/, "") || "/";
    if (path === href || path.startsWith(`${href}/`)) {
      if (!best || href.length > best.href.replace(/\/+$/, "").length) best = s;
    }
  }
  return best;
}

/**
 * An export for a page that has no loader of its own.
 *
 * It cannot carry what the page computed, and it says so plainly rather than pretending. What it
 * can carry is everything needed to ask a sensible first question about that page: which page it
 * was, what it was showing, and the state of the site behind it — how much of each thing is held,
 * whether the mailbox is running, which reports have arrived. On this site that has been enough to
 * find most faults, because most of them are a feed that did not arrive rather than a sum that
 * came out wrong.
 */
export async function genericBundle(
  pathname: string,
  params: URLSearchParams,
): Promise<{ bundle: Bundle; filename: string }> {
  const slug = pathname.replace(/^\/+|\/+$/g, "").replace(/\//g, "-") || "today";
  return {
    filename: `${slug}-${new Date().toISOString().slice(0, 10)}.json`,
    bundle: {
      readme: [
        `This is the “${pathname}” page. It has no export of its own yet, so this file does not carry what the page`,
        "computed — it carries what the site holds behind it, which is usually where the fault is.",
        "Say what looked wrong on the screen and this is enough to start from.",
      ],
      page: slug,
      pageTitle: pathname,
      takenAt: new Date().toISOString(),
      shownWith: Object.fromEntries(params),
      environment: await environment().catch((e) => ({ unreadable: String(e) })),
      privacy: { prescriptionsPseudonymised: 0, distinctPrescriptions: 0, dropped: {}, identifiersIncluded: false },
      notes: [
        "No page-specific loader is registered for this path, so no computed figures are included.",
        "Everything below is the state of the site at the moment the file was made.",
      ],
      data: null,
    },
  };
}
