import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { routeOf } from "../src/lib/page-visits";

describe("a visit to an old page is counted by its route, not its row", () => {
  test("an id in the path is one page", () => {
    assert.equal(routeOf("/staff/0a0a0a0a-1111-4222-8333-444444444444"), "/staff/[id]");
    assert.equal(routeOf("/cqi/incidents/0f0f0f0f-0000-4000-8000-000000000000/print"), "/cqi/incidents/[id]/print");
    assert.equal(routeOf("/temps/abcd1234-0000-4000-8000-000000000000/2026-09"), "/temps/[id]/2026-09");
  });
  test("a long number is a row too; a query string is not part of the page", () => {
    assert.equal(routeOf("/inventory/invoices?supplier=Mckesson&month=2026-09"), "/inventory/invoices");
    assert.equal(routeOf("/payers/contracts/123456"), "/payers/contracts/[n]");
    assert.equal(routeOf("/"), "/");
    assert.equal(routeOf("/claims/"), "/claims");
  });
});
