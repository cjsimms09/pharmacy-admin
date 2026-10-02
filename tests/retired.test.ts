import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isRetired, RETIRED } from "../src/lib/retired";
import { NAV } from "../src/lib/nav";
import { familyTabs } from "../src/lib/families";
import { WARM_STEPS } from "../src/lib/warm-policy";

/*
 * The owner's scope, 2 October 2026: compliance, invoices, temperature logs, delivery invoices, accounting, remits.
 * "Everything else can go." These pin that a retired page is out of the menus, out of the family tabs, out of the
 * idle warmer, and redirected — and that the kept pages are still reachable.
 */
describe("the pages retired on 2 October 2026", () => {
  test("retired and kept, by address", () => {
    for (const p of ["/purchasing", "/purchasing/shelf", "/nadac", "/money/found", "/claims/floor", "/payers/performance", "/payers/contracts/abc", "/reports", "/v2/today", "/plans"]) assert.equal(isRetired(p), true, p);
    for (const p of ["/", "/money", "/money/bank-review", "/inventory/invoices", "/suppliers", "/suppliers/x", "/temps", "/deliveries", "/remits", "/remits/mtf", "/claims", "/payers", "/payers/owed", "/compliance", "/inbox", "/expenses", "/settings", "/inventory/pack-sizes", "/tools/pioneer-sql", "/suppliers/x/terms"]) assert.equal(isRetired(p), false, p);
  });

  test("no retired page is in the menu, and the kept doors are", () => {
    const hrefs = NAV.flatMap((g) => [g.href, ...g.items.map((i) => i.href)]);
    for (const h of hrefs) assert.equal(isRetired(h), false, `${h} is retired but still in the menu`);
    for (const h of ["/money/bank-review", "/inventory/invoices", "/temps", "/deliveries", "/remits", "/compliance", "/suppliers"]) assert.ok(hrefs.includes(h), `${h} should be in the menu`);
    assert.equal(NAV.some((g) => g.label === "Buying"), false, "the Buying group is gone");
    assert.ok(NAV.some((g) => g.label === "Invoices"), "an Invoices group stands where Buying was");
  });

  test("family tabs never offer a retired page", () => {
    for (const name of ["money", "payers", "order", "floor"] as const) {
      for (const t of familyTabs(name, "/").items) assert.equal(isRetired(t.href), false, `${name}: ${t.href}`);
    }
  });

  test("the idle warmer no longer computes for retired pages", () => {
    for (const s of WARM_STEPS) assert.equal(isRetired(s.opens.split(",")[0].trim().replace(/^the dashboard.*/, "/")), false, `${s.key} warms ${s.opens}`);
    for (const key of ["buyListNow", "minimumsNow", "drugProfitNow", "overNadac28", "overNadac7", "floorReview", "leanShelfNow", "productsExtrasNow", "planRegister", "nadacCoverage", "productLedger"]) assert.equal(WARM_STEPS.some((s) => s.key === key), false, key);
  });

  test("the redirect's matcher catches one address under every retired rule, and nothing kept", () => {
    const src = readFileSync("src/middleware.ts", "utf8");
    const matchers = [...src.matchAll(/"(\/[^"]+)"/g)].map((m) => new RegExp("^" + m[1].replace(/\/:path\*$/, "(/.*)?").replace(/:id/g, "[^/]+") + "$"));
    const samples = ["/purchasing/shelf", "/nadac", "/inventory/returns", "/money/found", "/claims/appeals", "/claims/floor", "/plans", "/payers/plans", "/payers/performance", "/payers/networks", "/payers/contracts/abc", "/payers/sort", "/tools/check", "/tools/data-health", "/reports", "/settings/features", "/v2/today"];
    assert.equal(samples.length, RETIRED.length + 7, "one sample per rule, and one per branch of the rules that fork");
    for (const s of samples) {
      assert.ok(isRetired(s), `${s} should be retired`);
      assert.ok(matchers.some((m) => m.test(s)), `middleware does not redirect ${s}`);
    }
    for (const s of ["/money", "/money/bank-review", "/suppliers/x", "/tools/pioneer-sql", "/claims", "/payers", "/inventory/invoices"]) assert.ok(!matchers.some((m) => m.test(s)), `middleware wrongly redirects ${s}`);
  });
});
