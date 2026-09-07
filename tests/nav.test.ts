import { test, describe } from "node:test";
import assert from "node:assert/strict";
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

  test("no group has grown into two groups", () => {
    for (const g of NAV) {
      assert.ok(
        g.items.length <= 8,
        `${g.label} has ${g.items.length} items — it is either two groups now, or some of these belong one level down`,
      );
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
    assert.equal(groupFor("/compliance/training")?.label, "People");
    assert.equal(groupFor("/compliance/training/records")?.label, "People");
    assert.equal(groupFor("/compliance")?.label, "Compliance");
    assert.equal(groupFor("/compliance/attestations")?.label, "Compliance");
    // Supplier invoices are an ordering page even though they live under /inventory.
    assert.equal(groupFor("/inventory/invoices")?.label, "Ordering");
    assert.equal(groupFor("/inventory/returns")?.label, "Ordering");
    // Who pays best is a money question; the payer register is a claims one.
    assert.equal(groupFor("/payers/performance")?.label, "Claims");
    assert.equal(groupFor("/remits/mtf")?.label, "Claims");
    assert.equal(groupFor("/purchasing/minimums")?.label, "Ordering");
    assert.equal(groupFor("/plans")?.label, "Claims");
    assert.equal(groupFor("/payers/contracts/abc")?.label, "Claims");
  });

  test("a page reached from a list still opens its section", () => {
    assert.equal(groupFor("/staff/abc123")?.label, "People");
    assert.equal(groupFor("/inventory/abc/print")?.label, "Controlled substances");
    assert.equal(groupFor("/cqi/incidents/xyz")?.label, "Compliance");
    assert.equal(groupFor("/manual/print")?.label, "Compliance");
    assert.equal(groupFor("/settings/backups")?.label, "Settings");
    assert.equal(groupFor("/money/found")?.label, "Money");
    assert.equal(groupFor("/money/monthly")?.label, "Money");
    assert.equal(groupFor("/purchasing/shelf")?.label, "Ordering");
    assert.equal(groupFor("/intake")?.label, "Tools");
    assert.equal(groupFor("/inspection/walk")?.label, "Compliance");
    assert.equal(groupFor("/inbox")?.label, "Tools");
  });

  test("the sections are the ones the owner named, in the order the day runs", () => {
    assert.deepEqual(
      NAV.map((g) => g.label),
      ["Today", "Money", "Ordering", "Claims", "Compliance", "People", "Controlled substances", "Tools", "Settings"],
    );
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
    assert.equal(itemFor("/claims/floor")?.tab, undefined);
    assert.equal(itemFor("/money/monthly")?.item.href, "/money");
    assert.equal(itemFor("/money/monthly")?.tab?.label, "Statement");
    assert.equal(itemFor("/money/found")?.item.href, "/money/found");
    assert.equal(itemFor("/money"), undefined, "a group landing is the group, not an item under it");
  });
});
