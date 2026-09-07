import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NAV, groupFor, itemFor } from "../src/lib/nav";

/**
 * The sidebar's job is to be right about where you are.
 *
 * Getting that wrong is not cosmetic: the group that is open is the only way to see what else is
 * in the section, so a page that highlights the wrong group hides its own siblings. The subtle
 * case is a path that matches two groups — /compliance/training belongs to People, while
 * /compliance belongs to Inspection — and the longest match has to win.
 */
describe("navigation", () => {
  test("every group and item points somewhere absolute", () => {
    for (const g of NAV) {
      assert.ok(g.href.startsWith("/"), g.label);
      assert.ok(g.blurb.length > 20, `${g.label} needs a blurb worth reading`);
      for (const i of g.items) assert.ok(i.href.startsWith("/"), `${g.label} → ${i.label}`);
    }
  });

  test("no page is listed under two groups", () => {
    const seen = new Map<string, string>();
    for (const g of NAV) {
      for (const i of g.items) {
        assert.equal(seen.get(i.href), undefined, `${i.href} is under both ${seen.get(i.href)} and ${g.label}`);
        seen.set(i.href, g.label);
      }
    }
  });

  /*
   * The rules that keep a menu navigable while the site doubles.
   *
   * Everything built so far is compliance; the schedule, the money side and the purchasing work
   * are still to come. Nobody ever decides to add a thirteenth group — it is what happens when the
   * ceiling was never written down. Both numbers are deliberately close to where the site already
   * sits, so the next addition that would break them is a decision somebody has to make on
   * purpose rather than a drift nobody notices.
   */
  test("the sidebar stays something you recognise rather than scan", () => {
    assert.ok(NAV.length <= 12, `${NAV.length} top-level groups — a new area of the business earns one, a page does not`);
  });

  test("no group lists more than eight pages; the rest are hidden behind \"more\"", () => {
    for (const g of NAV) {
      const listed = g.items.filter((i) => !i.hidden);
      assert.ok(listed.length <= 8, `${g.label} lists ${listed.length} pages — the list is what somebody opens on a normal day`);
    }
  });

  test("every item says what it is for, so the menu teaches the site", () => {
    for (const g of NAV) {
      for (const i of g.items) {
        assert.ok(i.blurb && i.blurb.length > 15, `${g.label} → ${i.label} has no blurb`);
      }
    }
  });

  test("the dashboard does not swallow every path", () => {
    assert.equal(groupFor("/")?.label, "Today");
    assert.notEqual(groupFor("/staff")?.label, "Today");
  });

  test("a sub-page opens its own group, not its prefix's", () => {
    assert.equal(groupFor("/compliance/training")?.label, "Compliance");
    assert.equal(groupFor("/compliance/training/records")?.label, "Compliance");
    assert.equal(groupFor("/compliance")?.label, "Compliance");
    assert.equal(groupFor("/compliance/attestations")?.label, "Compliance");
    // Supplier invoices and returns are buying pages even though they live under /inventory.
    assert.equal(groupFor("/inventory/invoices")?.label, "Buying");
    assert.equal(groupFor("/inventory/returns")?.label, "Buying");
    assert.equal(groupFor("/inventory")?.label, "Compliance");
    assert.equal(groupFor("/payers/performance")?.label, "Getting paid");
    assert.equal(groupFor("/remits/mtf")?.label, "Getting paid");
    assert.equal(groupFor("/purchasing/minimums")?.label, "Buying");
    assert.equal(groupFor("/plans")?.label, "Getting paid");
    assert.equal(groupFor("/payers/contracts/abc")?.label, "Getting paid");
  });

  test("a page reached from a list still opens its section", () => {
    assert.equal(groupFor("/staff/abc123")?.label, "Compliance");
    assert.equal(groupFor("/inventory/abc/print")?.label, "Compliance");
    assert.equal(groupFor("/cqi/incidents/xyz")?.label, "Compliance");
    assert.equal(groupFor("/manual/print")?.label, "Compliance");
    assert.equal(groupFor("/settings/backups")?.label, "Settings");
    assert.equal(groupFor("/money/found")?.label, "Money");
    assert.equal(groupFor("/money/monthly")?.label, "Money");
    assert.equal(groupFor("/purchasing/shelf")?.label, "Buying");
    assert.equal(groupFor("/purchasing/over-nadac")?.label, "Buying");
    assert.equal(groupFor("/intake")?.label, "Settings");
    assert.equal(groupFor("/inspection/walk")?.label, "Compliance");
    assert.equal(groupFor("/inbox")?.label, "Settings");
    assert.equal(groupFor("/nadac")?.label, "Settings");
  });

  test("the sections are the three questions, with Today in front and the books and settings beside", () => {
    assert.deepEqual(NAV.map((g) => g.label), ["Today", "Buying", "Getting paid", "Money", "Compliance", "Settings"]);
  });

  test("a hidden page is still placed, so its highlight and breadcrumb are right", () => {
    assert.equal(itemFor("/cqi/incidents/xyz")?.item.label, "Quality (CQI)");
    assert.equal(itemFor("/staff/new-hire")?.item.label, "New employee");
    assert.equal(itemFor("/staff/abc123")?.item.label, "Staff");
    assert.equal(itemFor("/inventory/pharmacist-log")?.item.label, "Daily pharmacist log");
    assert.equal(itemFor("/audit")?.item.label, "Activity log");
  });

  test("a path nobody has claimed does not guess", () => {
    assert.equal(groupFor("/nowhere"), undefined);
  });
});

describe("a page listed only through its family", () => {
  test("still has a sidebar item and a breadcrumb", () => {
    assert.equal(itemFor("/plans")?.item.href, "/claims/floor");
    assert.equal(itemFor("/plans")?.tab?.label, "Which plans it reaches");
    assert.equal(itemFor("/purchasing/minimums")?.item.href, "/purchasing");
    assert.equal(itemFor("/intake")?.item.href, "/inbox");
    assert.equal(itemFor("/payers/sort")?.item.href, "/payers");
    assert.equal(itemFor("/settings/feeds")?.item.href, "/settings/connections");
    assert.equal(itemFor("/claims/floor")?.tab, undefined);
    assert.equal(itemFor("/money/monthly")?.item.href, "/money");
    assert.equal(itemFor("/money/monthly")?.tab?.label, "Statement");
    assert.equal(itemFor("/money/found")?.item.href, "/money/found");
    assert.equal(itemFor("/money"), undefined, "a group landing is the group, not an item under it");
  });
});

describe("the more menu is not inside the thing that scrolls", () => {
  /*
   * The bug this guards against left every group's "more" menu dead, and neither the typechecker
   * nor any test could see it: the markup was valid, the component rendered, the arrow turned.
   * The panel is absolutely positioned below the row, and the row carried overflow-x-auto for
   * narrow screens — which clips on both axes, not only the one named — so the panel opened
   * inside a forty-four pixel box and was cut off entirely.
   *
   * Nothing about that is visible from the outside, so this reads the source: whatever scrolls
   * must be closed before the menu begins.
   */
  const src = readFileSync(new URL("../src/components/nav.tsx", import.meta.url), "utf8");

  test("the menu is not nested inside the scrolling element", () => {
    const scroll = src.lastIndexOf("overflow-x-auto");
    const menu = src.indexOf("nav-more");
    assert.ok(scroll >= 0, "the pills still scroll");
    assert.ok(menu >= 0, "the more menu is still there");

    // Walk from the tag that scrolls to the menu, counting divs in and out. Still open means nested.
    const from = src.lastIndexOf("<div", scroll);
    let depth = 0;
    for (const m of src.slice(from, menu).matchAll(/<div\b|<\/div>/g)) depth += m[0] === "</div>" ? -1 : 1;
    assert.equal(
      depth,
      0,
      "the more menu is inside the element that scrolls, so its panel will be clipped and the menu will look dead",
    );
  });
});
