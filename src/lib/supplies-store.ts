import "server-only";
import { db, schema } from "@/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { usageRate, position, urgencyOrder, DEFAULT_POLICY, type Count, type Receipt, type Position, type Rate } from "./supplies";
import { todayIso } from "./dates";

/**
 * The supplies shelf: what is here, how fast it goes, and what to send the rep.
 *
 * The arithmetic is in supplies.ts and is pure. This is the part that has to join three records
 * that are kept separately and are meaningless apart: the counts somebody types in, the deliveries
 * that arrived between them, and the orders still in transit.
 *
 * ── Deliveries are half the sum ──
 *
 * `used = opening + received − closing`. Everything here exists to get the `received` term right,
 * because it is the one nobody thinks of. An order marked received supplies it; an order sent and
 * never confirmed supplies nothing and quietly poisons the next rate. So a sent order that has not
 * been confirmed is reported as such rather than assumed either way.
 */

/** What the pharmacy keeps, seeded once so the first count has something to attach to. */
export const STARTING_ITEMS: { name: string; unit: string; perUnit: number | null; supplierCode: string | null; sortOrder: number }[] = [
  { name: "13 dram vials", unit: "box", perUnit: null, supplierCode: null, sortOrder: 10 },
  { name: "16 dram vials", unit: "box", perUnit: null, supplierCode: null, sortOrder: 20 },
  { name: "30 dram vials", unit: "box", perUnit: null, supplierCode: null, sortOrder: 30 },
  { name: "40 dram vials", unit: "box", perUnit: null, supplierCode: null, sortOrder: 40 },
  { name: "Prescription bags", unit: "case", perUnit: null, supplierCode: null, sortOrder: 50 },
  { name: "Prescription labels", unit: "case", perUnit: null, supplierCode: null, sortOrder: 60 },
  { name: "Receipt tape", unit: "case", perUnit: null, supplierCode: null, sortOrder: 70 },
];

export const RX_SYSTEMS = "Rx Systems";

/**
 * Puts the known items and the vendor in place, once.
 *
 * Idempotent on the name, so running it again after somebody has renamed or retired an item does
 * not resurrect it. Nothing is seeded with a lead time or a case size, because inventing those
 * would produce a confident reorder date from figures nobody supplied.
 */
export async function seedSupplies(): Promise<{ added: number; vendorId: string }> {
  const existing = await db.query.vendors.findFirst({ where: eq(schema.vendors.name, RX_SYSTEMS) });
  let vendorId = existing?.id ?? "";
  if (!existing) {
    vendorId = randomUUID();
    await db.insert(schema.vendors).values({ id: vendorId, name: RX_SYSTEMS, cadence: "irregular" });
  }

  const have = new Set((await db.query.supplyItems.findMany({ columns: { name: true } })).map((r) => r.name.toLowerCase()));
  const missing = STARTING_ITEMS.filter((i) => !have.has(i.name.toLowerCase()));
  if (missing.length > 0) {
    await db.insert(schema.supplyItems).values(
      missing.map((i) => ({
        id: randomUUID(), name: i.name, unit: i.unit, perUnit: i.perUnit,
        vendorId, supplierCode: i.supplierCode, sortOrder: i.sortOrder,
      })),
    );
  }
  return { added: missing.length, vendorId };
}

export type SupplyRow = {
  id: string;
  name: string;
  unit: string;
  perUnit: number | null;
  supplierCode: string | null;
  vendorId: string | null;
  leadTimeDays: number;
  safetyDays: number;
  targetDays: number;
  orderMultiple: number | null;
  counts: Count[];
  receipts: Receipt[];
  /** Ordered and not yet confirmed as arrived. */
  onOrder: number;
  rate: Rate;
  position: Position;
};

/**
 * Every item with its history and where it stands.
 *
 * One pass over the counts and the received order lines, then the pure arithmetic. Nothing is
 * computed twice and no figure on the page comes from anywhere else.
 */
export async function supplyBoard(today = todayIso()): Promise<{ rows: SupplyRow[]; needsCount: SupplyRow[]; toOrder: SupplyRow[] }> {
  const [items, counts, lines, orders] = await Promise.all([
    db.query.supplyItems.findMany({ where: eq(schema.supplyItems.active, true), orderBy: [asc(schema.supplyItems.sortOrder), asc(schema.supplyItems.name)] }),
    db.query.supplyCounts.findMany({ orderBy: [asc(schema.supplyCounts.countedOn)] }),
    db.query.supplyOrderLines.findMany(),
    db.query.supplyOrders.findMany(),
  ]);
  const orderById = new Map(orders.map((o) => [o.id, o]));

  const countsBy = new Map<string, Count[]>();
  for (const c of counts) {
    const list = countsBy.get(c.itemId) ?? [];
    list.push({ on: c.countedOn, quantity: c.quantity });
    countsBy.set(c.itemId, list);
  }

  /*
   * A delivery counts on the day it was received, and only once it has been confirmed.
   *
   * An order sent last Tuesday may or may not be on the shelf. Treated as received it invents
   * stock that is not there and inflates the usage in that interval; treated as nothing it is
   * correct until it arrives. So it stays out of `receipts` and sits in `onOrder`, which informs
   * the decision without touching the rate.
   */
  const receiptsBy = new Map<string, Receipt[]>();
  const onOrderBy = new Map<string, number>();
  for (const l of lines) {
    const o = orderById.get(l.orderId);
    if (!o || o.status === "cancelled" || o.status === "draft") continue;
    if (o.status === "received" && o.receivedOn) {
      const list = receiptsBy.get(l.itemId) ?? [];
      // What arrived, not what was asked for: a short shipment counted in full invents usage.
      list.push({ on: o.receivedOn, quantity: l.receivedQuantity ?? l.quantity });
      receiptsBy.set(l.itemId, list);
    } else if (o.status === "sent") {
      onOrderBy.set(l.itemId, (onOrderBy.get(l.itemId) ?? 0) + l.quantity);
    }
  }

  const rows: SupplyRow[] = items.map((i) => {
    const itemCounts = countsBy.get(i.id) ?? [];
    const receipts = receiptsBy.get(i.id) ?? [];
    const onOrder = onOrderBy.get(i.id) ?? 0;
    const rate = usageRate(itemCounts, receipts, today);
    const last = itemCounts[itemCounts.length - 1] ?? null;
    return {
      id: i.id, name: i.name, unit: i.unit, perUnit: i.perUnit, supplierCode: i.supplierCode, vendorId: i.vendorId,
      leadTimeDays: i.leadTimeDays, safetyDays: i.safetyDays, targetDays: i.targetDays, orderMultiple: i.orderMultiple,
      counts: itemCounts, receipts, onOrder, rate,
      position: position({
        onHand: last?.quantity ?? 0,
        countedOn: last?.on ?? null,
        rate,
        policy: { leadTimeDays: i.leadTimeDays, safetyDays: i.safetyDays, targetDays: i.targetDays, orderMultiple: i.orderMultiple },
        onOrder,
        today,
      }),
    };
  });

  const sorted = [...rows].sort((a, b) => urgencyOrder(a.position, b.position));
  return {
    rows: sorted,
    /** Nothing counted, or nothing counted recently enough to say anything. */
    needsCount: sorted.filter((r) => r.rate.perDay === null),
    toOrder: sorted.filter((r) => r.position.state === "out" || r.position.state === "order now"),
  };
}

/** Records a count. The same item counted twice on one day is one count, corrected. */
export async function recordCount(a: { itemId: string; countedOn: string; quantity: number; by: string; note?: string }): Promise<void> {
  const existing = await db.query.supplyCounts.findFirst({
    where: and(eq(schema.supplyCounts.itemId, a.itemId), eq(schema.supplyCounts.countedOn, a.countedOn)),
  });
  if (existing) {
    await db.update(schema.supplyCounts)
      .set({ quantity: a.quantity, countedBy: a.by, note: a.note ?? null })
      .where(eq(schema.supplyCounts.id, existing.id));
    return;
  }
  await db.insert(schema.supplyCounts).values({
    id: randomUUID(), itemId: a.itemId, countedOn: a.countedOn, quantity: a.quantity, countedBy: a.by, note: a.note ?? null,
  });
}

/**
 * The order email, written the way a person writes one to a rep they know.
 *
 * Plain text, one line per item, quantities in the unit the rep sells in and the supplier's own
 * code where the pharmacy has recorded it. No pricing and no terms: this is not a purchase order,
 * it is the email that was already being typed by hand, with the quantities worked out.
 */
/**
 * Pluralising a unit properly, because "1 boxes" on an order to a rep reads as carelessness.
 *
 * Done here and nowhere else. It was in two places for a while and the email said "6 boxeses" —
 * a unit pluralised by the caller and then pluralised again by the writer.
 */
export function plural(unit: string, n: number): string {
  if (n === 1) return unit;
  if (/(s|x|z|ch|sh)$/i.test(unit)) return `${unit}es`;
  return `${unit}s`;
}

export function orderEmail(a: {
  pharmacy: string;
  placedBy: string;
  lines: { name: string; quantity: number; unit: string; supplierCode: string | null }[];
  note?: string | null;
}): { subject: string; body: string } {
  const when = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const items = a.lines
    .map((l) => `  • ${l.quantity} ${plural(l.unit, l.quantity)} — ${l.name}${l.supplierCode ? ` (${l.supplierCode})` : ""}`)
    .join("\n");
  return {
    subject: `Supply order — ${a.pharmacy} — ${when}`,
    body:
      `Hello,\n\nPlease place the following order for ${a.pharmacy}:\n\n${items}\n\n` +
      (a.note ? `${a.note}\n\n` : "") +
      `Please confirm receipt and let me know the expected delivery date.\n\nThank you,\n${a.placedBy}\n${a.pharmacy}\n`,
  };
}

export type PlaceResult =
  | { ok: true; orderId: string; sentTo: string; lines: number }
  | { ok: false; why: string; orderId?: string };

/**
 * Sends the order and records it in the same breath.
 *
 * Recorded whatever happens. An order that failed to send and left no trace is the worst outcome
 * available here: the pharmacist believes it went, nothing arrives, and the next count reports a
 * fortnight of furious usage because the delivery it was expecting never came.
 */
export async function placeOrder(a: {
  vendorEmail: string;
  lines: { itemId: string; quantity: number }[];
  by: { id: string; name: string };
  pharmacy: string;
  note?: string | null;
}): Promise<PlaceResult> {
  const wanted = a.lines.filter((l) => l.quantity > 0);
  if (wanted.length === 0) return { ok: false, why: "Nothing was selected to order." };
  if (!a.vendorEmail.trim()) return { ok: false, why: "No address on file for the rep. Add one and try again." };

  const items = await db.query.supplyItems.findMany({ where: inArray(schema.supplyItems.id, wanted.map((l) => l.itemId)) });
  const byId = new Map(items.map((i) => [i.id, i]));
  const lines = wanted
    .map((l) => {
      const i = byId.get(l.itemId);
      return i ? { name: i.name, quantity: l.quantity, unit: i.unit, supplierCode: i.supplierCode } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (lines.length === 0) return { ok: false, why: "None of the selected items could be found." };

  const vendor = await db.query.vendors.findFirst({ where: eq(schema.vendors.name, RX_SYSTEMS) });
  const { subject, body } = orderEmail({ pharmacy: a.pharmacy, placedBy: a.by.name, lines, note: a.note });

  const orderId = randomUUID();
  await db.insert(schema.supplyOrders).values({
    id: orderId, vendorId: vendor?.id ?? null, vendorName: RX_SYSTEMS, sentTo: a.vendorEmail,
    placedOn: todayIso(), status: "draft", body, placedBy: a.by.name, note: a.note ?? null,
  });
  await db.insert(schema.supplyOrderLines).values(
    wanted.map((l) => ({ id: randomUUID(), orderId, itemId: l.itemId, quantity: l.quantity })),
  );

  const { sendMail } = await import("./send-mail");
  const r = await sendMail(a.vendorEmail, subject, body);
  if (!r.ok) {
    await db.update(schema.supplyOrders).set({ status: "draft", sendError: r.error }).where(eq(schema.supplyOrders.id, orderId));
    return { ok: false, why: r.error, orderId };
  }
  await db.update(schema.supplyOrders)
    .set({ status: "sent", sentAt: new Date().toISOString(), sendError: null })
    .where(eq(schema.supplyOrders.id, orderId));
  return { ok: true, orderId, sentTo: a.vendorEmail, lines: lines.length };
}

/**
 * Confirms a delivery, which is the step that makes every future rate correct.
 *
 * Quantities may be corrected here: what arrived is what counts. Where nothing is said, what was
 * ordered is assumed, which is right far more often than not and is visible on the order either way.
 */
export async function receiveOrder(a: { orderId: string; receivedOn: string; quantities?: Record<string, number> }): Promise<void> {
  const lines = await db.query.supplyOrderLines.findMany({ where: eq(schema.supplyOrderLines.orderId, a.orderId) });
  for (const l of lines) {
    const q = a.quantities?.[l.id];
    await db.update(schema.supplyOrderLines)
      .set({ receivedQuantity: typeof q === "number" && q >= 0 ? q : l.quantity })
      .where(eq(schema.supplyOrderLines.id, l.id));
  }
  await db.update(schema.supplyOrders)
    .set({ status: "received", receivedOn: a.receivedOn })
    .where(eq(schema.supplyOrders.id, a.orderId));
}

/** Recent orders, newest first, with their lines, for the history on the page. */
export async function recentOrders(limit = 12) {
  const orders = await db.query.supplyOrders.findMany({ orderBy: [desc(schema.supplyOrders.placedOn), desc(schema.supplyOrders.createdAt)], limit });
  if (orders.length === 0) return [];
  const lines = await db.query.supplyOrderLines.findMany({ where: inArray(schema.supplyOrderLines.orderId, orders.map((o) => o.id)) });
  const items = await db.query.supplyItems.findMany();
  const nameOf = new Map(items.map((i) => [i.id, i.name]));
  return orders.map((o) => ({
    ...o,
    lines: lines.filter((l) => l.orderId === o.id).map((l) => ({ ...l, name: nameOf.get(l.itemId) ?? "—" })),
  }));
}

/** The one alert the dashboard needs: what has to be ordered, and what has never been counted. */
export async function suppliesAlert(): Promise<{ toOrder: number; names: string[]; neverCounted: number } | null> {
  const board = await supplyBoard();
  if (board.rows.length === 0) return null;
  const never = board.rows.filter((r) => r.counts.length === 0).length;
  if (board.toOrder.length === 0 && never === 0) return null;
  return { toOrder: board.toOrder.length, names: board.toOrder.map((r) => r.name), neverCounted: never };
}
