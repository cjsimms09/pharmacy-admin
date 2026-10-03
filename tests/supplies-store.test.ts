import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * The whole loop, against the real store: count, count again, order, receive, count again.
 *
 * The arithmetic is tested in supplies.test.ts and is pure. What this pins is the joining, which
 * is where the damage actually happens: a delivery that is not fed back into the counts either
 * side of it turns a week of ordinary use into a week where nothing was used, and every reorder
 * date after that is late.
 */
let cleanup: () => void;
let store: typeof import("../src/lib/supplies-store");
let db: typeof import("../src/db").db;
let schema: typeof import("../src/db").schema;

before(async () => {
  const { useScratchDb } = await import("./support/scratch-db");
  cleanup = await useScratchDb();
  ({ db, schema } = await import("../src/db"));
  store = await import("../src/lib/supplies-store");
});

after(() => cleanup?.());

const itemNamed = async (name: string) => {
  const rows = await db.query.supplyItems.findMany();
  const hit = rows.find((r) => r.name === name);
  assert.ok(hit, `no item called ${name}`);
  return hit;
};

describe("seeding", () => {
  test("puts the pharmacy's own items and the rep's vendor in place", async () => {
    const first = await store.seedSupplies();
    assert.equal(first.added, store.STARTING_ITEMS.length);
    const vials = await itemNamed("30 dram vials");
    assert.equal(vials.unit, "box", "vials are kept and ordered by the box, never counted as vials");

    // Idempotent: running it again must not double the shelf.
    const second = await store.seedSupplies();
    assert.equal(second.added, 0);
    assert.equal(second.vendorId, first.vendorId);
  });
});

describe("counting", () => {
  test("two counts give a rate and an order-by date", async () => {
    const item = await itemNamed("13 dram vials");
    await store.recordCount({ itemId: item.id, countedOn: "2026-09-01", quantity: 40, by: "Cory" });
    await store.recordCount({ itemId: item.id, countedOn: "2026-09-11", quantity: 20, by: "Cory" });

    const board = await store.supplyBoard("2026-09-11");
    const row = board.rows.find((r) => r.id === item.id)!;
    assert.equal(row.rate.perDay, 2, "twenty boxes over ten days");
    assert.equal(row.position.onHand, 20);
    // Ten days of stock, against a five-day lead time and a seven-day cushion: already late.
    assert.equal(row.position.state, "order now");
  });

  test("the same item counted twice on one day corrects rather than doubles", async () => {
    const item = await itemNamed("16 dram vials");
    await store.recordCount({ itemId: item.id, countedOn: "2026-09-11", quantity: 5, by: "Cory" });
    await store.recordCount({ itemId: item.id, countedOn: "2026-09-11", quantity: 8, by: "Cory" });
    const counts = await db.query.supplyCounts.findMany();
    const mine = counts.filter((c) => c.itemId === item.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].quantity, 8);
  });

  test("an item nobody has counted is never given a rate", async () => {
    const board = await store.supplyBoard("2026-09-11");
    const tape = board.rows.find((r) => r.name === "Receipt tape")!;
    assert.equal(tape.rate.perDay, null);
    assert.equal(tape.position.state, "unknown");
    assert.equal(tape.position.suggested, 0);
    assert.ok(board.needsCount.some((r) => r.id === tape.id));
  });
});

describe("ordering, and the delivery that makes the next rate correct", () => {
  test("an order with no address on file is refused rather than half-placed", async () => {
    const item = await itemNamed("Prescription bags");
    const r = await store.placeOrder({
      vendorEmail: "", lines: [{ itemId: item.id, quantity: 4 }],
      by: { id: "u1", name: "Cory" }, pharmacy: "West Wichita Family Pharmacy",
    });
    assert.equal(r.ok, false);
    assert.equal((await db.query.supplyOrders.findMany()).length, 0, "nothing recorded for an order that was never attempted");
  });

  test("an order that fails to send is kept as a draft with the reason, never lost", async () => {
    const item = await itemNamed("Prescription bags");
    // No mailbox is configured in a scratch database, so sending fails — which is the case worth
    // pinning: the pharmacist must not believe an order went when it did not.
    const r = await store.placeOrder({
      vendorEmail: "rep@example.com", lines: [{ itemId: item.id, quantity: 4 }],
      by: { id: "u1", name: "Cory" }, pharmacy: "West Wichita Family Pharmacy",
    });
    assert.equal(r.ok, false);
    const orders = await db.query.supplyOrders.findMany();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].status, "draft");
    assert.ok(orders[0].sendError, "the reason it failed is on the record");
    assert.ok(orders[0].body?.includes("Prescription bags"), "and so is what was going to be asked for");
  });

  test("a delivery is added to usage, so the counts either side read correctly", async () => {
    const item = await itemNamed("40 dram vials");
    await store.recordCount({ itemId: item.id, countedOn: "2026-09-01", quantity: 20, by: "Cory" });

    const orderId = crypto.randomUUID();
    await db.insert(schema.supplyOrders).values({
      id: orderId, vendorName: store.RX_SYSTEMS, placedOn: "2026-09-04", status: "sent", placedBy: "Cory",
    });
    await db.insert(schema.supplyOrderLines).values({ id: crypto.randomUUID(), orderId, itemId: item.id, quantity: 12 });

    /*
     * While it is only sent it is not stock. Counted as received it would invent boxes that are
     * not on the shelf and inflate the usage in this interval.
     */
    let board = await store.supplyBoard("2026-09-11");
    let row = board.rows.find((r) => r.id === item.id)!;
    assert.equal(row.onOrder, 12);
    assert.equal(row.receipts.length, 0);

    await store.receiveOrder({ orderId, receivedOn: "2026-09-05" });
    await store.recordCount({ itemId: item.id, countedOn: "2026-09-11", quantity: 20, by: "Cory" });

    board = await store.supplyBoard("2026-09-11");
    row = board.rows.find((r) => r.id === item.id)!;
    // 20 in, 12 delivered, 20 left: twelve used. Subtracting the counts alone would say none.
    assert.equal(row.rate.all[0].received, 12);
    assert.equal(row.rate.all[0].used, 12);
    assert.equal(row.rate.perDay, 1.2);
    assert.equal(row.onOrder, 0, "it has arrived; it is stock now, not an order");
  });

  test("what arrived is what counts, not what was asked for", async () => {
    const item = await itemNamed("Prescription labels");
    await store.recordCount({ itemId: item.id, countedOn: "2026-09-01", quantity: 10, by: "Cory" });

    const orderId = crypto.randomUUID();
    const lineId = crypto.randomUUID();
    await db.insert(schema.supplyOrders).values({
      id: orderId, vendorName: store.RX_SYSTEMS, placedOn: "2026-09-04", status: "sent", placedBy: "Cory",
    });
    await db.insert(schema.supplyOrderLines).values({ id: lineId, orderId, itemId: item.id, quantity: 10 });

    // Ten ordered, four shipped. Counting ten invents six cases of usage that never happened.
    await store.receiveOrder({ orderId, receivedOn: "2026-09-05", quantities: { [lineId]: 4 } });
    await store.recordCount({ itemId: item.id, countedOn: "2026-09-11", quantity: 8, by: "Cory" });

    const board = await store.supplyBoard("2026-09-11");
    const row = board.rows.find((r) => r.id === item.id)!;
    assert.equal(row.rate.all[0].received, 4);
    assert.equal(row.rate.all[0].used, 6, "10 + 4 − 8");
  });
});

describe("the email to the rep", () => {
  test("units are pluralised once, and only where they need to be", () => {
    assert.equal(store.plural("box", 1), "box");
    assert.equal(store.plural("box", 6), "boxes");
    assert.equal(store.plural("case", 2), "cases");
    assert.equal(store.plural("roll", 1), "roll");
  });

  test("reads like the email somebody was already typing", () => {
    const { subject, body } = store.orderEmail({
      pharmacy: "West Wichita Family Pharmacy",
      placedBy: "Cory Simms",
      lines: [
        { name: "30 dram vials", quantity: 6, unit: "box", supplierCode: "V30" },
        { name: "Receipt tape", quantity: 1, unit: "case", supplierCode: null },
      ],
      note: "Please bill to the usual account.",
    });
    assert.match(subject, /Supply order — West Wichita Family Pharmacy/);
    assert.match(body, /6 boxes — 30 dram vials \(V30\)/);
    assert.match(body, /1 case — Receipt tape/);
    assert.match(body, /Please bill to the usual account\./);
    assert.match(body, /Cory Simms/);
    assert.doesNotMatch(body, /undefined|null|NaN/);
  });

  test("no note leaves no gap where a note would have been", () => {
    const { body } = store.orderEmail({
      pharmacy: "P", placedBy: "C",
      lines: [{ name: "Receipt tape", quantity: 2, unit: "case", supplierCode: null }],
    });
    assert.doesNotMatch(body, /\n\n\n/);
  });
});

describe("the dashboard alert", () => {
  test("says what has to be ordered, by name", async () => {
    const alert = await store.suppliesAlert();
    assert.ok(alert, "something is due by now in this database");
    assert.ok(alert.toOrder > 0 || alert.neverCounted > 0);
  });
});
