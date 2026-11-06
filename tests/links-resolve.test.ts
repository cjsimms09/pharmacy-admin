import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isRetired } from "../src/lib/retired";
import { FAMILIES, familyTabs, type FamilyName } from "../src/lib/families";
import { effectOf, leftBehind } from "../src/lib/inbox-undo";
import { stopsCount, withoutRetired, type SetupItem } from "../src/lib/setup-checklist";

/*
 * A link that sends a person to a page that is gone.
 *
 * The owner, 5 October 2026, on a proof's line: it "links to a retired page". It was one of 85 places that did. Retiring a page on 2 October
 * took it out of the menu and put a redirect on its address; nothing looked at the other places that sent a person there (Today's strip of
 * feeds, the feeds page, the page of what is expected, the setup list, buttons on Claims and Payers, the weekly email), and each one led to a
 * sentence saying the page was gone.
 *
 * This reads every address the code writes as a literal where a person is sent to it, and holds each to a page that exists and is not retired.
 * It reads only what is written straight after href, redirect( or link(: an address built in pieces, or kept in a variable, it does not see.
 * The pages under src/app/(app)/remits belong to the other session and are not read here. Every value in the scan's own tests is invented.
 */

const ROOT = process.cwd();
const APP = path.join(ROOT, "src", "app");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const sourceFiles = (dir: string) => walk(path.join(ROOT, dir)).filter((f) => /\.tsx?$/.test(f));

const LINK = /\b(?:href\s*[:=]|redirect\(|permanentRedirect\(|link\()\s*\{?\s*["'`](\/[^"'`]*)["'`]/g;

type Found = { line: number; raw: string; path: string };

function linksIn(text: string): Found[] {
  const out: Found[] = [];
  text.split(/\r?\n/).forEach((ln, i) => {
    for (const m of ln.matchAll(LINK)) {
      const flat = m[1].replace(/\$\{[^}]*\}/g, "x");
      out.push({ line: i + 1, raw: m[1], path: flat.split("?")[0].split("#")[0] || "/" });
    }
  });
  return out;
}

/** A page or route handler as its address segments: route groups dropped, dynamic segments left in brackets. */
const ROUTES: string[][] = walk(APP)
  .map((f) => path.relative(APP, f).split(path.sep).join("/"))
  .filter((r) => /(^|\/)(page|route)\.tsx?$/.test(r))
  .map((r) => r.replace(/\/?(page|route)\.tsx?$/, "").split("/").filter((s) => s && !/^\(.*\)$/.test(s)));

function routeMatches(route: string[], segs: string[]): boolean {
  for (let i = 0; i < route.length; i++) {
    const r = route[i];
    if (r.startsWith("[[...")) return true;
    if (r.startsWith("[...")) return segs.length > i;
    if (i >= segs.length) return false;
    if (!r.startsWith("[") && r !== segs[i]) return false;
  }
  return route.length === segs.length;
}

function whatIsWrong(p: string, routes: string[][] = ROUTES): "RETIRED" | "NO ROUTE" | null {
  if (isRetired(p)) return "RETIRED";
  const segs = p.split("/").filter(Boolean);
  return routes.some((r) => routeMatches(r, segs)) ? null : "NO ROUTE";
}

/** The address a file under src/app answers at. */
const routeOfFile = (f: string) => "/" + path.relative(APP, f).split(path.sep).slice(0, -1).filter((s) => !/^\(.*\)$/.test(s)).join("/");

describe("the scan can fail", () => {
  test("it finds a retired address however a person is sent to it", () => {
    const found = linksIn(
      [
        'const a = { href: "/purchasing/shelf", label: "x" };',
        '<Link href="/nadac">x</Link>',
        '<Link href={"/money/found"}>x</Link>',
        'redirect("/claims/floor?x=1");',
        "permanentRedirect(`/reports`);",
        'parts.push(`  What to send back ${link("/inventory/returns")}`);',
      ].join("\n"),
    );
    assert.deepEqual(found.map((f) => f.line), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(found.map((f) => whatIsWrong(f.path)), ["RETIRED", "RETIRED", "RETIRED", "RETIRED", "RETIRED", "RETIRED"]);
  });

  test("it finds an address that leads to no page", () => {
    assert.equal(whatIsWrong(linksIn('<Link href="/claims/nowhere-at-all">x</Link>')[0].path), "NO ROUTE");
    assert.equal(whatIsWrong("/suppliers/abc/terms/extra"), "NO ROUTE");
  });

  test("it passes a kept page, a dynamic page and the front page, and ignores the query and the fragment", () => {
    for (const lit of ['"/claims?payer=x"', "`/suppliers/${id}/terms`", "`/staff/${s.id}#training`", '"/"', '"/payers/owed#mtf"']) {
      const f = linksIn(`<Link href=${lit}>x</Link>`);
      assert.equal(f.length, 1, lit);
      assert.equal(whatIsWrong(f[0].path), null, lit);
    }
  });

  test("it reads only an address written straight after href, redirect( or link(", () => {
    assert.deepEqual(linksIn("<Link href={`${base}/purchasing`}>x</Link>"), []);
    assert.deepEqual(linksIn("<Link href={target}>x</Link>"), []);
    assert.deepEqual(linksIn('const where = "/purchasing";'), []);
  });

  test("a dynamic segment takes one address segment and a catch-all takes the rest", () => {
    const routes = [["staff", "[id]"], ["files", "[...path]"], ["docs", "[[...slug]]"]];
    assert.equal(whatIsWrong("/staff/7", routes), null);
    assert.equal(whatIsWrong("/staff", routes), "NO ROUTE");
    assert.equal(whatIsWrong("/staff/7/x", routes), "NO ROUTE");
    assert.equal(whatIsWrong("/files/a/b/c", routes), null);
    assert.equal(whatIsWrong("/files", routes), "NO ROUTE");
    assert.equal(whatIsWrong("/docs", routes), null);
    assert.equal(whatIsWrong("/docs/a/b", routes), null);
  });
});

/*
 * The shared code that still names a retired page, and the reason that is not a link on a screen. Each file's number is exact: a rise means a
 * new link to a retired page, and a fall means the reason below may no longer be the whole story, so both fail until somebody reads it again.
 * These reasons were read from the imports on 5 October 2026. This test counts the links; it does not find out again who imports the file.
 */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "src/lib/nav.ts": { count: 14, why: "NAV_RAW keeps the whole menu and is private; NAV, the only thing drawn from, is NAV_RAW with the retired items taken out (retired.test.ts)." },
  "src/lib/families.ts": { count: 12, why: "FAMILIES keeps every tab; familyTabs() takes the retired ones out, and nav.ts reads the whole list only to find which family a page is in." },
  "src/lib/setup-checklist.ts": { count: 6, why: "the items for work on retired pages are still written; setup-store.ts, their one caller, passes the list through withoutRetired()." },
  "src/lib/alerts.ts": { count: 2, why: "the two supplies alerts still name their old page; alerts() drops them by key at its end." },
  "src/lib/money-found.ts": { count: 11, why: "the money-found list is read only by the retired /money/found page; the engine stores it and no kept screen reads it." },
  "src/lib/recommendations.ts": { count: 5, why: "imported only by money-found.ts." },
  "src/lib/floor-review.ts": { count: 5, why: "read by the retired claims pages and by money-found.ts, and named in a warmer map that no warming step uses." },
  "src/lib/price-moves.ts": { count: 2, why: "imported by nothing but its own test." },
  "src/lib/diagnostic-sources.ts": { count: 7, why: "names the page a downloaded export was taken from, as a line in the file and not as a link on a screen." },
};

type Where = { file: string; line: number; raw: string; wrong: "RETIRED" | "NO ROUTE" };

function scan(files: string[], skip: (f: string) => boolean): { total: number; wrong: Where[] } {
  let total = 0;
  const wrong: Where[] = [];
  for (const f of files) {
    if (skip(f)) continue;
    for (const l of linksIn(fs.readFileSync(f, "utf8"))) {
      total++;
      const w = whatIsWrong(l.path);
      if (w) wrong.push({ file: rel(f), line: l.line, raw: l.raw, wrong: w });
    }
  }
  return { total, wrong };
}

const shared = scan([...sourceFiles("src/lib"), ...sourceFiles("src/components")], () => false);
/* A page at a retired address is never shown (it is redirected), so what it links to is not what a person is sent to. */
const screens = scan(sourceFiles("src/app"), (f) => /(^|\/)remits\//.test(rel(f).replace("src/app/", "")) || isRetired(routeOfFile(f)));

const said = (w: Where[]) => w.map((x) => `${x.file}:${x.line} ${x.wrong} ${x.raw}`).join("\n");

describe("every address the code writes where a person is sent to it", () => {
  test("the scan sees the code, so a pass is not a scan of nothing", () => {
    assert.ok(ROUTES.length > 100, `${ROUTES.length} pages and routes found`);
    assert.ok(shared.total > 300, `${shared.total} addresses found in the shared code`);
    assert.ok(screens.total > 500, `${screens.total} addresses found in the screens`);
  });

  test("none leads to a page that does not exist, anywhere", () => {
    const none = [...shared.wrong, ...screens.wrong].filter((w) => w.wrong === "NO ROUTE");
    assert.equal(none.length, 0, said(none));
  });

  test("none on a screen leads to a retired page", () => {
    assert.equal(screens.wrong.length, 0, said(screens.wrong));
  });

  test("none in the shared code does, except in the files listed above", () => {
    const loose = shared.wrong.filter((w) => !ALLOWED[w.file]);
    assert.equal(loose.length, 0, `${loose.length} link(s) to a retired page outside the listed files:\n${said(loose)}`);
  });

  test("each listed file holds exactly the number said, so the list cannot go stale", () => {
    for (const [file, a] of Object.entries(ALLOWED)) {
      const here = shared.wrong.filter((w) => w.file === file);
      assert.equal(here.length, a.count, `${file} has ${here.length} link(s) to a retired page and the list says ${a.count} (${a.why})\n${said(here)}`);
    }
  });
});

const asItem = (o: Partial<SetupItem> & { key: string }): SetupItem => ({
  title: o.key,
  rank: "stops",
  done: false,
  why: "",
  detail: "",
  href: "/",
  action: "Do it",
  minutes: 10,
  area: "buying",
  ...o,
});

describe("the tabs, the setup list and the note on a wrong file never send him to a retired page", () => {
  test("no family offers one, whichever page is open", () => {
    const names = Object.keys(FAMILIES) as FamilyName[];
    assert.ok(names.length >= 4, "the families are found");
    for (const name of names) {
      for (const here of ["/", "/claims", "/payers/owed"]) {
        for (const t of familyTabs(name, here).items) assert.equal(isRetired(t.href.split(/[?#]/)[0]), false, `${name} on ${here}: ${t.href}`);
      }
    }
  });

  test("an item of work on a retired page is not on the setup list, with or without a query", () => {
    const items = [
      asItem({ key: "a", href: "/payers/plans" }),
      asItem({ key: "b", href: "/payers/plans?x=1#top" }),
      asItem({ key: "c", href: "/settings/feeds" }),
      asItem({ key: "d", href: "/suppliers/abc/terms?tab=1" }),
      asItem({ key: "e", href: "/purchasing/shelf", done: true }),
    ];
    assert.deepEqual(withoutRetired(items).map((i) => i.key), ["c", "d"]);
  });

  test("one that stops something stops being counted among the things that stop something", () => {
    const items = [asItem({ key: "a", href: "/payers/plans" }), asItem({ key: "c", href: "/settings/feeds" })];
    assert.equal(stopsCount(items), 2);
    assert.equal(stopsCount(withoutRetired(items)), 1);
  });

  const kinds = [...fs.readFileSync(path.join(ROOT, "src/lib/inbox-undo.ts"), "utf8").matchAll(/^  ([a-z_0-9]+): \{$/gm)].map((m) => m[1]);

  test("no kind of file tells him where to look under a retired page, by address or by name", () => {
    assert.ok(kinds.length >= 20, `${kinds.length} kinds found`);
    for (const k of kinds) {
      const e = effectOf(k);
      assert.ok(e, `${k} is a kind`);
      if (e.at) assert.equal(isRetired(e.at.href), false, `${k}: ${e.at.href}`);
      assert.doesNotMatch(leftBehind(k), /Look under (Purchasing|Buying|Ordering|NADAC|Reports|Money found)/, k);
    }
  });

  test("a shelf count is not said to be anywhere he can look, since the page that showed it is retired", () => {
    assert.equal(effectOf("on_hand")?.at, undefined);
    assert.doesNotMatch(leftBehind("on_hand"), /Look under/);
  });
});

const keptOrNone = (href: string | null) => href === null || whatIsWrong(href.split(/[?#]/)[0]) === null;

describe("the lists of what feeds, what is expected and what is left to do, on a database of their own", () => {
  let cleanup: () => void;
  let feedsNow: typeof import("../src/lib/feeds").feedsNow;
  let expectedNow: typeof import("../src/lib/expected-store").expectedNow;
  let automationStatus: typeof import("../src/lib/automation-status").automationStatus;
  let setupNow: typeof import("../src/lib/setup-store").setupNow;
  let alerts: typeof import("../src/lib/alerts").alerts;
  let supplies: typeof import("../src/lib/supplies-store");
  let setSetting: typeof import("../src/lib/settings").setSetting;

  before(async () => {
    const { useScratchDb } = await import("./support/scratch-db");
    cleanup = await useScratchDb();
    ({ feedsNow } = await import("../src/lib/feeds"));
    ({ expectedNow } = await import("../src/lib/expected-store"));
    ({ automationStatus } = await import("../src/lib/automation-status"));
    ({ setupNow } = await import("../src/lib/setup-store"));
    ({ alerts } = await import("../src/lib/alerts"));
    supplies = await import("../src/lib/supplies-store");
    ({ setSetting } = await import("../src/lib/settings"));
  });
  after(() => cleanup?.());

  test("a feed's name is a link only where a kept page shows it; the NADAC download and the shelf count show on none", async () => {
    const { feeds } = await feedsNow({ now: new Date("2026-10-05T12:00:00Z") });
    assert.ok(feeds.length > 8, `${feeds.length} feeds`);
    for (const f of feeds) assert.ok(keptOrNone(f.href), `${f.key} points at ${f.href}`);
    for (const key of ["nadac", "onhand"]) {
      const f = feeds.find((x) => x.key === key);
      assert.ok(f, `${key} is a row`);
      assert.equal(f.href, null, key);
    }
  });

  test("a job's page is a kept one", async () => {
    /* The supplier price files job is on the strip once any catalogue has arrived or the reimbursement side is on. */
    await setSetting("feature_reimbursement", "yes");
    const jobs = await automationStatus();
    for (const key of ["nadac", "catalogs"]) assert.ok(jobs.some((j) => j.key === key), `${key} is a job`);
    for (const j of jobs) assert.ok(keptOrNone(j.href), `${j.key} points at ${j.href}`);
  });

  test("a report that is expected is a link only where a kept page shows it", async () => {
    const { rows } = await expectedNow({ today: "2026-10-05" });
    assert.ok(rows.length > 15, `${rows.length} rows`);
    for (const r of rows) assert.ok(keptOrNone(r.href), `${r.key} points at ${r.href}`);
    for (const key of ["on_hand", "nadac", "mck_returns"]) {
      const r = rows.find((x) => x.key === key);
      assert.ok(r, `${key} is a row`);
      assert.equal(r.href, null, key);
    }
  });

  test("the setup list asks for no work on a retired page", async () => {
    const { items } = await setupNow();
    assert.ok(items.length > 10, `${items.length} items`);
    for (const i of items) assert.equal(isRetired(i.href.split(/[?#]/)[0]), false, `${i.key} sends him to ${i.href}`);
  });

  test("the morning alerts name no retired page, and the supplies alert is not among them though it is due", async () => {
    await supplies.seedSupplies();
    assert.ok(await supplies.suppliesAlert(), "something is due, so the alert would exist before it is dropped");
    const list = await alerts();
    assert.ok(list.length > 0, "there are alerts on this database");
    assert.equal(list.some((a) => a.key.startsWith("supplies-")), false);
    for (const a of list) assert.equal(isRetired(a.href.split(/[?#]/)[0]), false, `${a.key} sends him to ${a.href}`);
  });
});
