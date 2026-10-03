import "server-only";
import { setupItems, ranked, stopsCount, type SetupInput, type SetupItem } from "./setup-checklist";

/**
 * What the setup list reads.
 *
 * Every source is one the site already computes for its own screens, so the list can never
 * disagree with the page it points at. Each is wrapped on its own: a source that fails leaves its
 * item out rather than emptying the list, because a checklist that goes blank when one query
 * breaks is worse than one that is short by a line.
 */
async function safe<T>(f: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await f();
  } catch {
    return fallback;
  }
}

export async function setupNow(): Promise<{
  items: SetupItem[];
  left: SetupItem[];
  done: SetupItem[];
  notApplicable: SetupItem[];
  minutesLeft: number;
  progress: number;
  stops: number;
}> {
  const { held } = await import("./held");
  const { dismissals } = await import("./setup-dismissals");
  /*
   * The items are cached; what he has said about them is not.
   *
   * Reading the dismissals inside `held` would mean pressing "does not apply" and watching the item
   * sit there until the cache expired — the exact experience of a control that does nothing, which
   * this list has form for. The table is one small row per answer, so it is read every time and
   * applied to the cached items afterwards.
   */
  const [items, said] = await Promise.all([held("setup", loadSetup), dismissals()]);
  const marked = items.map((i) => {
    const d = said.get(i.key);
    return d ? { ...i, notApplicable: { reason: d.reason, at: d.at, by: d.by } } : i;
  });
  return { items: marked, ...ranked(marked), stops: stopsCount(marked) };
}

async function loadSetup(): Promise<SetupItem[]> {
  const { getSettings } = await import("./settings");
  const { daysBetween, todayIso } = await import("./dates");
  const s = await safe(() => getSettings(), {} as Awaited<ReturnType<typeof getSettings>>);

  const aiReady = await safe(async () => (await import("./ai")).hasApiKey(), false);
  const mailConfigured = await safe(async () => (await import("./mailbox")).hasMailPassword(), false);

  const feeds = await safe(async () => {
    const { feedsNow } = await import("./feeds");
    const { feeds } = await feedsNow();
    return feeds
      /* A row that reports a state of affairs is not a thing to go and do: see `informational` on Feed. */
      .filter((f) => f.group === "arriving" && !f.informational)
      .map((f) => ({
        key: f.key,
        label: f.label.toLowerCase(),
        // "unproven" is arriving but not yet cross-checked, which is not a thing for the owner to do.
        state: (f.state === "on_time" || f.state === "unproven" ? "ok" : f.state === "off" ? "off" : f.state === "never" ? "never" : "late") as "ok" | "late" | "never" | "off",
        says: f.detail,
        href: f.href ?? "/settings/feeds",
      }));
  }, [] as SetupInput["feeds"]);

  const jobs = await safe(async () => {
    const { automationStatus } = await import("./automation-status");
    return (await automationStatus()).map((j) => ({ key: j.key, label: j.label.toLowerCase(), state: j.state as "ok" | "stale" | "never" | "off", href: j.href }));
  }, [] as SetupInput["jobs"]);

  const plans = await safe(async () => {
    const { registerProgress } = await import("./plans");
    const p = await registerProgress();
    return { total: p.plans, decided: p.decided, claimsUndecided: p.claimsUnknown };
  }, { total: 0, decided: 0, claimsUndecided: 0 });

  const shelf = await safe(async () => {
    const { latestShelf } = await import("./shelf");
    const snap = await latestShelf();
    if (!snap?.countedOn) return { countedOn: null, ageDays: null };
    return { countedOn: snap.countedOn, ageDays: daysBetween(snap.countedOn, todayIso()) };
  }, { countedOn: null as string | null, ageDays: null as number | null });

  const suppliers = await safe(async () => {
    const { allSuppliers } = await import("./suppliers-registry");
    const { contractRatesBySupplier } = await import("./rebate-rates");
    /*
     * The buy list is no longer read here. It was loaded solely to find each supplier's order
     * minimum, and no order minimum is asked for any more — see the note in setup-checklist.ts.
     * Loading the whole buy list to compute a figure nothing reads is the shape worth removing
     * rather than leaving to puzzle somebody later.
     */
    const [rows, rates] = await Promise.all([allSuppliers(true), contractRatesBySupplier()]);

    /*
     * Whether anything of this supplier's is on the site at all.
     *
     * The rebate-ladder row says their prices are compared gross and an order could go to the wrong
     * wholesaler because of it. That needs prices of theirs to be in the comparison. Counted from
     * the three places anything of a supplier's lands — the catalogue, the invoices, and the
     * deliveries PioneerRx booked in — and asked of both names a supplier goes by, which is the
     * lesson from McKesson's catalogue being reported missing while 44,306 of its items sat on file.
     */
    const { db } = await import("@/db");
    const client = (db as unknown as { $client: { execute: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
    const seen = new Set<string>();
    for (const table of ["supplier_items", "supplier_invoices", "pioneer_purchases"]) {
      const r = await client.execute(`select distinct lower(trim(supplier)) as s from ${table} where supplier is not null`);
      for (const row of r.rows) if (row.s) seen.add(String(row.s));
    }

    return rows
      .filter((r) => r.active)
      .map((r) => ({
        name: r.name,
        primary: r.primarySupplier === true,
        hasLadder: rates[r.name.trim().toLowerCase()] !== undefined,
        hasTermsPage: `/suppliers/${r.id}/terms`,
        trades: [r.name, r.catalogName ?? ""].some((n) => n.trim() !== "" && seen.has(n.trim().toLowerCase())),
      }));
  }, [] as SetupInput["suppliers"]);

  const standingCosts = await safe(async () => (await (await import("./standing-costs")).allStandingCosts()).length, 0);

  const billsRecent = await safe(async () => {
    const { db, schema } = await import("@/db");
    const { gte } = await import("drizzle-orm");
    const { addDays } = await import("./dates");
    const rows = await db.query.expenses.findMany({ where: gte(schema.expenses.invoiceDate, addDays(todayIso(), -90)), columns: { id: true } });
    return rows.length;
  }, 0);

  const nadac = await safe(async () => {
    const { nadacHealth } = await import("./nadac");
    const h = await nadacHealth();
    return { state: h.state, says: h.headline };
  }, { state: "none" as const, says: "Not loaded." });

  const claims = await safe(async () => {
    const { drugProfitNow } = await import("./drug-profit-store");
    const p = await drugProfitNow();
    return { fills: p.fills, withBasis: p.withBasis };
  }, { fills: 0, withBasis: 0 });

  const directoryRows = await safe(async () => (await (await import("./drug-directory-store")).directoryStatus()).rows, 0);

  const contracts = await safe(
    async () => {
      const { db } = await import("@/db");
      const docs = await db.query.contractDocs.findMany({
        columns: { id: true, extractionState: true, triage: true, pages: true },
      });
      /*
       * A document the triage has judged not to be a contract is not work outstanding.
       *
       * It is in the folder, it will stay in the folder, and reading it would tell nobody anything
       * — the site has already decided there is nothing in it. Counting it in the denominator of a
       * row that asks him to read them makes the position look worse than it is, in a row that
       * already makes it look better than it is by counting documents instead of pages.
       */
      const worth = docs.filter((d) => d.triage !== "not_relevant");
      const read = worth.filter((d) => d.extractionState === "done");
      const left = worth.filter((d) => d.extractionState !== "done");
      const pages = (rows: typeof docs) => rows.reduce((n, d) => n + (d.pages ?? 0), 0);

      /* Reading costs money at the model, and the model stops at the ceiling. */
      const { monthlyCap } = await import("./ai-spend");
      const cap = await monthlyCap().catch(() => ({ over: false }));

      return {
        total: docs.length,
        read: read.length,
        worthReading: worth.length,
        pagesLeft: pages(left),
        pagesRead: pages(read),
        modelStopped: cap.over === true,
      };
    },
    { total: 0, read: 0, worthReading: 0, pagesLeft: 0, pagesRead: 0, modelStopped: false },
  );

  /* The details every printed Board form carries. A blank on a form is a finding. */
  const identityMissing: string[] = [];
  if (!(s.pharmacy_name ?? "").trim()) identityMissing.push("the pharmacy's name");
  if (!(s.pharmacy_registration_number ?? "").trim()) identityMissing.push("the Kansas registration number");
  if (!(s.pharmacy_address ?? "").trim()) identityMissing.push("the address");

  return setupItems({
    aiReady,
    mail: { configured: mailConfigured, enabled: s.mail_enabled === "yes", autoImport: s.mail_auto_import === "yes" },
    feeds,
    jobs,
    plans,
    shelf,
    suppliers,
    standingCosts,
    billsRecent,
    nadac,
    identity: { missing: identityMissing },
    claims,
    directoryRows,
    ksFeeEntered: Boolean((s.ks_medicaid_dispensing_fee_cents ?? "").trim()),
    contracts,
  });
}
