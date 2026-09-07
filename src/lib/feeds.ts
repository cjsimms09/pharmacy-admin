import "server-only";
import { db } from "@/db";
import { getSettings, type Settings } from "./settings";
import { judgeFeed, missingDays, type FeedState } from "./feed-rules";

/**
 * Is everything arriving?
 *
 * The site runs on feeds: a claims export every evening, a catalogue per supplier every Monday,
 * a NADAC file every Wednesday, an 835 from each payer as it pays, the facilitator's payments,
 * invoices, an on-hand count, a sales month, a bank statement, a rebate statement. Every figure
 * on every page is only as current as the feed behind it — and a feed that stops looks, on the
 * page, exactly like a feed with nothing to report. The floor review reads perfectly well against
 * a month-old claims file. That is the failure this exists to catch.
 *
 * So each feed says what it is, how often it should arrive, when it last did, and whether that
 * is recently enough — judged from the data itself (the newest row in the table it fills), never
 * from a job saying it ran. Where a feed can be checked against the outside — CMS's newest NADAC
 * date, the mailbox, the Claude API, the facilitator's tool — that check is offered as a probe,
 * run only when asked, because probes cost time and the Today page must not wait on them.
 *
 * "Off" is a legitimate state: a pharmacy that has not switched a feed on is not late with it.
 *
 * Three layers, from cheapest to most convincing:
 *   1. cadence — did it arrive when it should (this module, every row);
 *   2. probe — is the outside service reachable and does it agree (the `probe` field);
 *   3. proof — does what arrived cover what it should: claims on every open day, an 835 line
 *      behind fills old enough to have been paid, an item count that did not halve (the `proof`
 *      field, where one exists).
 */

export type Feed = {
  key: string;
  label: string;
  group: "arriving" | "services";
  /** In words: "every evening", "Mondays", "as each payer pays". */
  cadence: string;
  lastAt: string | null;
  state: FeedState;
  /** What the newest arrival was. */
  detail: string;
  /** The cross-check that shows the feed is complete, not merely present. Null where none exists yet. */
  proof: string | null;
  /** The live check against the outside, when one was run. */
  probe: { ok: boolean; says: string } | null;
  href: string;
};

type Client = { execute: (sql: string, args?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
const sql = () => (db as unknown as { $client: Client }).$client;

const isoDate = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" ? Number(v) || 0 : 0);
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((100 * n) / d)}%` : "—");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => { t = setTimeout(() => resolve(fallback), ms); });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
}

export async function feedsNow(opts: { probe?: boolean; now?: Date } = {}): Promise<{ feeds: Feed[]; late: Feed[] }> {
  // The plain reading is held (held.ts): Today asks for it on every open. A probe is never held.
  if (!opts.probe && !opts.now) {
    const { held } = await import("./held");
    return held("feeds", () => loadFeeds(opts));
  }
  return loadFeeds(opts);
}

async function loadFeeds(opts: { probe?: boolean; now?: Date }): Promise<{ feeds: Feed[]; late: Feed[] }> {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const s = await getSettings();
  const c = sql();
  const feeds: Feed[] = [];
  const reimbursement = s.feature_reimbursement === "yes";

  // ── The daily claims export ──
  {
    const [latest, days] = await Promise.all([
      c.execute("select max(date_filled) as d, count(*) as n from claims"),
      c.execute("select date_filled as d, count(*) as n from claims where date_filled >= ? group by date_filled", [addDays(today, -14)]),
    ]);
    const lastAt = isoDate(latest.rows[0]?.d);
    const gaps = missingDays(days.rows.map((r) => String(r.d)), addDays(today, -14), addDays(today, -1));
    feeds.push({
      key: "claims",
      label: "Claims export",
      group: "arriving",
      cadence: "every evening, from PioneerRx",
      lastAt,
      state: judgeFeed({ maxQuietHours: 2 * 24 + 8, lastAt, now, enabled: reimbursement || lastAt !== null }),
      detail: lastAt ? `Fills through ${lastAt}.` : "No claims export has been loaded. Schedule the PioneerRx report to email the pharmacy address and it files itself.",
      proof: lastAt
        ? gaps.length === 0
          ? "Every one of the last 14 days has fills on it."
          : `${plural(gaps.length, "day")} in the last 14 with no fills at all: ${gaps.map(short).join(", ")}. A closed day is fine; an open day with none is a report that did not land.`
        : null,
      probe: null,
      href: "/claims",
    });
  }

  // ── Supplier catalogues, one row per supplier on the register ──
  {
    const [sups, imports, counts] = await Promise.all([
      db.query.suppliers.findMany({ columns: { name: true, catalogName: true, primarySupplier: true } }),
      c.execute("select supplier, max(created_at) as at, max(priced_on) as priced from supplier_imports group by supplier"),
      c.execute("select supplier, count(*) as n, sum(case when item_number is null or item_number = '' then 0 else 1 end) as numbered, sum(case when awp_cents is null then 0 else 1 end) as with_awp from supplier_items group by supplier"),
    ]);
    const lastBy = new Map(imports.rows.map((r) => [String(r.supplier).trim().toLowerCase(), { at: String(r.at), priced: isoDate(r.priced) }]));
    const nBy = new Map(counts.rows.map((r) => [String(r.supplier).trim().toLowerCase(), num(r.n)]));
    const numberedBy = new Map(counts.rows.map((r) => [String(r.supplier).trim().toLowerCase(), num(r.numbered)]));
    const awpBy = new Map(counts.rows.map((r) => [String(r.supplier).trim().toLowerCase(), num(r.with_awp)]));
    const names = sups.length ? sups.map((x) => ({ name: x.name, key: (x.catalogName ?? x.name).trim().toLowerCase(), primary: x.primarySupplier })) : [...lastBy.keys()].map((k) => ({ name: k, key: k, primary: false }));
    for (const sup of names) {
      const last = lastBy.get(sup.key) ?? null;
      const items = nBy.get(sup.key) ?? 0;
      feeds.push({
        key: `catalogue:${sup.key}`,
        label: `${sup.name} price file`,
        group: "arriving",
        cadence: "Mondays, from PioneerRx",
        lastAt: last?.at ?? null,
        state: judgeFeed({ maxQuietHours: 9 * 24, lastAt: last?.at ?? null, now, enabled: reimbursement || last !== null }),
        detail: last ? `Loaded ${last.at.slice(0, 10)}${last.priced ? `, priced ${last.priced}` : ""}; ${items.toLocaleString()} items on file.` : "No price file has arrived for this supplier.",
        proof: last
          ? items < 100
            ? `Only ${items} items on file — a file this small is a partial export, not a catalogue.`
            : `${pct(numberedBy.get(sup.key) ?? 0, items)} of items carry the supplier's item number, which is what an order line is keyed by; ${pct(awpBy.get(sup.key) ?? 0, items)} carry an AWP, which is what an AWP-paid claim is priced on.`
          : null,
        probe: null,
        href: "/purchasing",
      });
    }
  }

  // ── NADAC ──
  {
    const r = await c.execute("select max(file_as_of) as f, count(distinct ndc11) as n from nadac_prices");
    const held = isoDate(r.rows[0]?.f);
    const n = num(r.rows[0]?.n);
    const auto = s.nadac_auto === "yes";
    let probe: Feed["probe"] = null;
    if (opts.probe) probe = await withTimeout(nadacProbe(held), 10_000, { ok: false, says: "CMS did not answer within ten seconds." });
    feeds.push({
      key: "nadac",
      label: "NADAC prices",
      group: "arriving",
      cadence: "Wednesdays, from CMS",
      lastAt: held,
      state: probe && !probe.ok && held !== null ? "broken" : judgeFeed({ maxQuietHours: 9 * 24, lastAt: held, now, enabled: auto || held !== null }),
      detail: held ? `Newest file held is dated ${held}, ${n.toLocaleString()} NDCs.` : "No NADAC file is loaded.",
      proof: s.nadac_last_result ? `Last pull: ${s.nadac_last_result}` : null,
      probe,
      href: "/nadac",
    });
  }

  // ── 835 remittances, judged on the payments they carry ──
  {
    const [latest, byPayer, cover] = await Promise.all([
      c.execute("select max(received_on) as d, count(*) as n from claim_payments where source = 'plan'"),
      c.execute("select payer, max(received_on) as d, count(*) as n from claim_payments where source = 'plan' group by payer order by n desc"),
      // Fills two to ten weeks old: old enough to have been paid, young enough to still be the point.
      c.execute(
        "select count(*) as fills, sum(case when exists (select 1 from claim_payments p where p.source = 'plan' and p.claim_id = c.id) then 1 else 0 end) as paid from claims c where c.date_filled between ? and ?",
        [addDays(today, -70), addDays(today, -14)],
      ),
    ]);
    const lastAt = isoDate(latest.rows[0]?.d);
    const fills = num(cover.rows[0]?.fills);
    const paid = num(cover.rows[0]?.paid);
    const stalePayers = byPayer.rows.filter((r) => isoDate(r.d) !== null && daysSince(isoDate(r.d)!, today) > 30).map((r) => `${r.payer ?? "unnamed"} (${isoDate(r.d)})`);
    feeds.push({
      key: "remits",
      label: "835 remittances",
      group: "arriving",
      cadence: "as each payer pays, by email or the facilitator",
      lastAt,
      state: judgeFeed({ maxQuietHours: 14 * 24, lastAt, now, enabled: reimbursement || lastAt !== null }),
      detail: lastAt ? `${num(latest.rows[0]?.n).toLocaleString()} paid lines held; the newest received ${lastAt}.` : "No 835 has been read in. Drop one on the Inbox or set up the facilitator below.",
      proof:
        fills > 0
          ? `${pct(paid, fills)} of fills two to ten weeks old have an 835 line behind them (${paid.toLocaleString()} of ${fills.toLocaleString()}).${stalePayers.length ? ` Nothing in 30 days from ${stalePayers.slice(0, 4).join(", ")}.` : ""}`
          : null,
      probe: null,
      href: "/claims",
    });
  }

  // ── The facilitator (MTF) ──
  {
    const r = await c.execute("select max(received_on) as d, count(*) as n, sum(amount_cents) as cents from claim_payments where source = 'mtf'");
    const lastAt = isoDate(r.rows[0]?.d);
    const hasKey = Boolean(s.mtf_api_key_enc);
    let probe: Feed["probe"] = null;
    if (opts.probe && hasKey) {
      const { testMtf } = await import("./mtf");
      probe = await withTimeout(testMtf().then((x) => ({ ok: x.ok, says: x.message })), 60_000, { ok: false, says: "The facilitator's tool did not answer within a minute." });
    }
    const keyLeft = s.mtf_key_set_on ? keyDays(s.mtf_key_set_on, today) : null;
    feeds.push({
      key: "mtf",
      label: "Facilitator payments (MTF)",
      group: "arriving",
      cadence: "weekly, pulled by the facilitator's tool",
      lastAt,
      state: !hasKey && lastAt === null ? "off" : probe && !probe.ok ? "broken" : judgeFeed({ maxQuietHours: 14 * 24, lastAt: s.mtf_last_pull ?? lastAt, now, enabled: true }),
      detail: hasKey
        ? `${num(r.rows[0]?.n).toLocaleString()} payments held, ${money(num(r.rows[0]?.cents))} in all${lastAt ? `; newest received ${lastAt}` : ""}. Last pull: ${s.mtf_last_result ?? "never"}.${keyLeft !== null && keyLeft <= 14 ? ` The API key expires in ${plural(keyLeft, "day")}.` : ""}`
        : "No facilitator key is stored, so nothing is pulled.",
      proof: null,
      probe,
      href: "/remits/mtf",
    });
  }

  // ── Supplier invoices ──
  {
    const rows = await c.execute("select supplier, max(invoice_date) as d, count(*) as n from supplier_invoices where invoice_date is not null group by supplier");
    const newest = rows.rows.map((r) => isoDate(r.d)).filter((x): x is string => x !== null).sort().pop() ?? null;
    const quiet = rows.rows.filter((r) => isoDate(r.d) !== null && daysSince(isoDate(r.d)!, today) > 21).map((r) => `${r.supplier ?? "unnamed"} (${isoDate(r.d)})`);
    feeds.push({
      key: "invoices",
      label: "Supplier invoices",
      group: "arriving",
      cadence: "with each delivery, by email or the Inbox",
      lastAt: newest,
      state: judgeFeed({ maxQuietHours: 4 * 24, lastAt: newest, now, enabled: reimbursement || newest !== null }),
      detail: newest ? `Newest invoice dated ${newest}, from ${plural(rows.rows.length, "supplier")}.` : "No supplier invoice has been read in.",
      proof: quiet.length ? `Nothing in three weeks from ${quiet.join(", ")}.` : null,
      probe: null,
      href: "/invoices",
    });
  }

  // ── The on-hand count ──
  {
    const r = await c.execute("select max(counted_on) as d from on_hand_imports");
    const lastAt = isoDate(r.rows[0]?.d);
    feeds.push({
      key: "onhand",
      label: "On-hand count",
      group: "arriving",
      cadence: "every day, from PioneerRx",
      lastAt,
      state: judgeFeed({ maxQuietHours: 2 * 24 + 8, lastAt, now, enabled: reimbursement || lastAt !== null }),
      detail: lastAt ? `Counted ${lastAt}.` : "No count has been uploaded, so nothing can be told short.",
      proof: null,
      probe: null,
      href: "/purchasing/shelf",
    });
  }

  // ── Sales months, the bank statement, the rebate statement: monthly ──
  {
    const [sales, bank] = await Promise.all([
      c.execute("select max(month) as m, max(period_to) as d from sales_months"),
      c.execute("select max(\"on\") as d, count(*) as n from bank_lines"),
    ]);
    const salesTo = isoDate(sales.rows[0]?.d);
    feeds.push({
      key: "sales",
      label: "Sales month",
      group: "arriving",
      cadence: "monthly, the System Sales report",
      lastAt: salesTo,
      state: judgeFeed({ maxQuietHours: 40 * 24, lastAt: salesTo, now, enabled: salesTo !== null }),
      detail: salesTo ? `Filed through ${String(sales.rows[0]?.m)}.` : "No sales month has been filed; retail and patient-paid sales are missing from the books.",
      proof: null,
      probe: null,
      href: "/money",
    });
    const bankTo = isoDate(bank.rows[0]?.d);
    feeds.push({
      key: "bank",
      label: "Bank statement",
      group: "arriving",
      cadence: "monthly, the CSV export",
      lastAt: bankTo,
      state: judgeFeed({ maxQuietHours: 40 * 24, lastAt: bankTo, now, enabled: bankTo !== null }),
      detail: bankTo ? `${num(bank.rows[0]?.n).toLocaleString()} lines held, the newest dated ${bankTo}.` : "No statement has been read in, so nothing is known to have reached the bank.",
      proof: null,
      probe: null,
      href: "/money",
    });
    const rebate = rebateFiled(s);
    feeds.push({
      key: "rebate",
      label: "Rebate statement",
      group: "arriving",
      cadence: "monthly, from the primary wholesaler",
      lastAt: rebate,
      state: judgeFeed({ maxQuietHours: 45 * 24, lastAt: rebate, now, enabled: rebate !== null }),
      detail: rebate ? `Last statement filed ${rebate.slice(0, 10)}.` : "No rebate statement has been filed; the rebate on the books is an estimate.",
      proof: null,
      probe: null,
      href: "/suppliers",
    });
  }

  // ── Services: the mailbox, Claude, the sensors, the backup ──
  {
    const mailOn = Boolean(s.mail_user && s.mail_password_enc);
    let probe: Feed["probe"] = null;
    if (opts.probe && mailOn) {
      const { testMailbox } = await import("./mailbox");
      probe = await withTimeout(testMailbox().then((x) => (x.ok ? { ok: true, says: x.detail } : { ok: false, says: x.error })), 20_000, { ok: false, says: "The mailbox did not answer within twenty seconds." });
    }
    feeds.push({
      key: "mailbox",
      label: "Mailbox",
      group: "services",
      cadence: "swept every few minutes",
      lastAt: s.mail_last_sweep ?? null,
      state: !mailOn ? "off" : probe && !probe.ok ? "broken" : judgeFeed({ maxQuietHours: 26, lastAt: s.mail_last_sweep ?? null, now, enabled: s.mail_enabled === "yes" }),
      detail: mailOn ? (s.mail_last_result ?? "Connected, not yet swept.") : "Not connected. Nothing emailed to the pharmacy is being filed.",
      proof: null,
      probe,
      href: "/settings/email",
    });

    const aiOn = Boolean(s.anthropic_api_key_enc);
    let ai: Feed["probe"] = null;
    if (opts.probe && aiOn) {
      const { testConnection } = await import("./ai");
      ai = await withTimeout(testConnection().then((x) => (x.ok ? { ok: true, says: `Answered as ${x.model}.` } : { ok: false, says: x.error })), 20_000, { ok: false, says: "Claude did not answer within twenty seconds." });
    }
    feeds.push({
      key: "claude",
      label: "Claude",
      group: "services",
      cadence: "on demand: reads invoices, contracts and photographs",
      lastAt: null,
      state: !aiOn ? "off" : ai ? (ai.ok ? "on_time" : "broken") : "unproven",
      detail: aiOn ? "A key is stored." : "No key is stored, so nothing can be read from a document.",
      proof: null,
      probe: ai,
      href: "/settings/connections",
    });

    const { automationStatus } = await import("./automation-status");
    const jobs = await automationStatus();
    for (const key of ["temps", "backup"] as const) {
      const j = jobs.find((x) => x.key === key);
      if (!j) continue;
      feeds.push({
        key,
        label: j.label,
        group: "services",
        cadence: key === "temps" ? "every hour, from the sensors" : "nightly",
        lastAt: j.lastAt,
        state: j.state === "ok" ? "on_time" : j.state === "stale" ? "late" : j.state,
        detail: j.detail,
        proof: null,
        probe: null,
        href: j.href,
      });
    }
  }

  const rank: Record<FeedState, number> = { broken: 0, late: 1, never: 2, unproven: 3, on_time: 4, off: 5 };
  feeds.sort((a, b) => Number(a.group === "services") - Number(b.group === "services") || rank[a.state] - rank[b.state]);
  return { feeds, late: feeds.filter((f) => f.state === "late" || f.state === "broken") };
}

/** CMS's newest as-of date against the one held, read from the weekly dataset the site already knows. */
async function nadacProbe(held: string | null): Promise<{ ok: boolean; says: string }> {
  try {
    const { nadacDatasets } = await import("./nadac-fetch");
    const { latestAsOfUrl, parseLatestAsOf } = await import("./nadac-sources");
    const d = await nadacDatasets();
    if (!d?.weekly) return { ok: false, says: "The site does not know CMS's weekly dataset id; open the NADAC page and refresh the sources." };
    const res = await fetch(latestAsOfUrl(d.weekly.id), { signal: AbortSignal.timeout(9_000) });
    if (!res.ok) return { ok: false, says: `CMS answered ${res.status}.` };
    const newest = parseLatestAsOf(await res.json());
    if (!newest) return { ok: false, says: "CMS answered, but without a date." };
    if (!held) return { ok: false, says: `CMS's newest file is dated ${newest}; nothing is held.` };
    if (newest > held) return { ok: false, says: `CMS's newest file is dated ${newest}; the site holds ${held}. Pull it from the NADAC page.` };
    return { ok: true, says: `CMS's newest file is dated ${newest}, and that is the one held.` };
  } catch (e) {
    return { ok: false, says: e instanceof Error ? e.message : "CMS could not be reached." };
  }
}

function rebateFiled(s: Settings): string | null {
  const raw = s.mck_rebate_last_statement;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { filedAt?: string };
    return typeof parsed.filedAt === "string" ? parsed.filedAt : null;
  } catch {
    return null;
  }
}

function keyDays(setOn: string, today: string): number | null {
  const m = /^\d{4}-\d{2}-\d{2}/.exec(setOn);
  return m ? 90 - daysSince(m[0], today) : null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysSince(iso: string, today: string): number {
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000);
}
const short = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
