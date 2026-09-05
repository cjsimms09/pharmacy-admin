import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NAV, groupFor } from "../src/lib/nav";

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
    assert.equal(groupFor("/compliance")?.label, "Inspection");
    assert.equal(groupFor("/compliance/attestations")?.label, "Records");
  });

  test("a page reached from a list still opens its section", () => {
    assert.equal(groupFor("/staff/abc123")?.label, "People");
    assert.equal(groupFor("/inventory/abc/print")?.label, "Controlled substances");
    assert.equal(groupFor("/cqi/incidents/xyz")?.label, "Quality (CQI)");
    assert.equal(groupFor("/manual/print")?.label, "P&P manual");
    assert.equal(groupFor("/settings/backups")?.label, "Settings");
  });

  test("a path nobody has claimed does not guess", () => {
    assert.equal(groupFor("/nowhere"), undefined);
  });
});
