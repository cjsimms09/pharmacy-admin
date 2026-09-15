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

export async function setupNow(): Promise<{ items: SetupItem[]; left: SetupItem[]; done: SetupItem[]; minutesLeft: number; progress: number; stops: number }> {
  const { held } = await import("./held");
  const items = await held("setup", loadSetup);
  return { items, ...ranked(items), stops: stopsCount(items) };
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
      .filter((f) => f.group === "arriving")
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
    const { buyListNow } = await import("./shelf");
    const [rows, rates, buy] = await Promise.all([allSuppliers(true), contractRatesBySupplier(), buyListNow().catch(() => null)]);
    const minimumOf = new Map((buy?.suppliers ?? []).map((x) => [x.supplier, x.minimumCents]));
    return rows
      .filter((r) => r.active)
      .map((r) => ({
        name: r.name,
        primary: r.primarySupplier === true,
        hasMinimum: (minimumOf.get(r.name) ?? null) !== null,
        hasLadder: rates[r.name.trim().toLowerCase()] !== undefined,
        hasTermsPage: `/suppliers/${r.id}/terms`,
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

  const contracts = await safe(async () => {
    const { db } = await import("@/db");
    const docs = await db.query.contractDocs.findMany({ columns: { id: true, extractionState: true } });
    return { total: docs.length, read: docs.filter((d) => d.extractionState === "done").length };
  }, { total: 0, read: 0 });

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
