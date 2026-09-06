import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { todayIso } from "@/lib/dates";
import { getSettings } from "@/lib/settings";
import { seedSupplies, supplyBoard, recordCount, placeOrder, receiveOrder, recentOrders, orderEmail, plural, RX_SYSTEMS } from "@/lib/supplies-store";
import { PageHeader, Card, Notice, Empty, Figure, Field } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Supplies" };

/**
 * Vials, bags, labels and receipt tape: the things the pharmacy cannot open without.
 *
 * There is no feed for these. A box of 30 dram vials is opened, used and thrown away without a
 * single record, so the only evidence of how fast they go is the difference between two counts —
 * and the only thing standing between the pharmacy and a Tuesday morning with no 16 dram vials is
 * somebody remembering. This replaces the remembering.
 *
 * ── What it needs from a person, and what it works out itself ──
 *
 * A count, now and then. That is all. From two counts it knows the rate; from the rate and the
 * lead time it knows the day the order has to go, which is the number actually worth having —
 * not "eleven days left" but "send this on Tuesday". Deliveries are logged when they arrive
 * because they are half the arithmetic: two counts either side of an unlogged delivery report a
 * week where nothing was used at all.
 *
 * ── The order ──
 *
 * The pharmacy orders bags, labels and vials by emailing a rep at Rx Systems. So the button sends
 * that email — the one that was already being typed by hand — with the quantities worked out and
 * a record kept of what was asked for, so the next count knows what to expect.
 */
export default async function SuppliesPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser();
  const { ok, error } = await searchParams;
  await seedSupplies();
  const [board, orders, settings] = await Promise.all([supplyBoard(), recentOrders(), getSettings()]);
  const today = todayIso();
  const repEmail = settings.supplies_rep_email ?? "";
  const pharmacy = settings.pharmacy_name || "the pharmacy";
  const num = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 10) / 10) : "—");

  async function saveCounts(fd: FormData) {
    "use server";
    const u = await requireManager();
    const countedOn = String(fd.get("countedOn") ?? "").trim() || todayIso();
    let saved = 0;
    for (const [k, v] of fd.entries()) {
      if (!k.startsWith("qty:")) continue;
      const raw = String(v).trim();
      if (raw === "") continue;
      const q = Number(raw);
      if (!Number.isFinite(q) || q < 0) continue;
      await recordCount({ itemId: k.slice(4), countedOn, quantity: q, by: u.name });
      saved++;
    }
    if (saved === 0) redirect("/purchasing/supplies?error=" + encodeURIComponent("Nothing was entered, so nothing was counted."));
    await audit({ action: "supplies.count", userId: u.id, userName: u.name, entity: "supplies", entityId: countedOn, details: `${saved} items counted ${countedOn}` });
    revalidatePath("/purchasing/supplies");
    redirect("/purchasing/supplies?ok=" + encodeURIComponent(`${saved} ${saved === 1 ? "item" : "items"} counted on ${countedOn}.`));
  }

  async function saveRep(fd: FormData) {
    "use server";
    const u = await requireManager();
    const { setSetting } = await import("@/lib/settings");
    const addr = String(fd.get("repEmail") ?? "").trim();
    await setSetting("supplies_rep_email", addr);
    await audit({ action: "supplies.rep", userId: u.id, userName: u.name, entity: "supplies", details: addr || "cleared" });
    revalidatePath("/purchasing/supplies");
    redirect("/purchasing/supplies?ok=" + encodeURIComponent(addr ? `Orders will go to ${addr}.` : "The rep's address was cleared."));
  }

  async function sendOrder(fd: FormData) {
    "use server";
    const u = await requireManager();
    const lines: { itemId: string; quantity: number }[] = [];
    for (const [k, v] of fd.entries()) {
      if (!k.startsWith("order:")) continue;
      const q = Number(String(v).trim());
      if (Number.isFinite(q) && q > 0) lines.push({ itemId: k.slice(6), quantity: q });
    }
    const s = await getSettings();
    const r = await placeOrder({
      vendorEmail: s.supplies_rep_email ?? "",
      lines,
      by: { id: u.id, name: u.name },
      pharmacy: s.pharmacy_name || "the pharmacy",
      note: String(fd.get("note") ?? "").trim() || null,
    });
    if (!r.ok) {
      await audit({ action: "supplies.order.failed", userId: u.id, userName: u.name, entity: "supplies", entityId: r.orderId, details: r.why });
      revalidatePath("/purchasing/supplies");
      redirect("/purchasing/supplies?error=" + encodeURIComponent(`${r.why}${r.orderId ? " The order was kept as a draft below, so nothing was lost." : ""}`));
    }
    await audit({ action: "supplies.order.sent", userId: u.id, userName: u.name, entity: "supplies", entityId: r.orderId, details: `${r.lines} lines to ${r.sentTo}` });
    revalidatePath("/purchasing/supplies");
    redirect("/purchasing/supplies?ok=" + encodeURIComponent(`Order sent to ${r.sentTo} — ${r.lines} ${r.lines === 1 ? "line" : "lines"}. Mark it received when it arrives so the next count reads correctly.`));
  }

  async function markReceived(fd: FormData) {
    "use server";
    const u = await requireManager();
    const orderId = String(fd.get("orderId") ?? "");
    const receivedOn = String(fd.get("receivedOn") ?? "").trim() || todayIso();
    await receiveOrder({ orderId, receivedOn });
    await audit({ action: "supplies.order.received", userId: u.id, userName: u.name, entity: "supplies", entityId: orderId, details: receivedOn });
    revalidatePath("/purchasing/supplies");
    redirect("/purchasing/supplies?ok=" + encodeURIComponent(`Marked as arrived on ${receivedOn}. The usage either side of it now reads correctly.`));
  }

  const urgent = board.toOrder;
  const preview = urgent.length > 0
    ? orderEmail({
        pharmacy,
        placedBy: "—",
        lines: urgent.map((r) => ({ name: r.name, quantity: r.position.suggested, unit: r.unit, supplierCode: r.supplierCode })),
      })
    : null;

  return (
    <>
      <PageHeader
        back={{ href: "/purchasing", label: "What to buy" }}
        title="Supplies"
        subtitle="Count now and then; the site works out how fast each goes and which day the order has to be sent."
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Figure
          value={urgent.length}
          label="to order now"
          sub={urgent.length ? urgent.map((r) => r.name).join(", ") : "Nothing is inside its lead time"}
          tone={urgent.length ? "crit" : "ok"}
        />
        <Figure
          value={board.rows.filter((r) => r.position.state === "order soon").length}
          label="coming up"
          sub="Inside a week of the order-by date"
          tone="muted"
        />
        <Figure
          value={board.needsCount.length}
          label="cannot be predicted yet"
          sub={board.needsCount.length ? "Need a second count before a rate exists" : "Every item has a rate"}
          tone={board.needsCount.length ? "warn" : "ok"}
        />
      </div>

      {!repEmail && (
        <div className="mt-4">
          <Notice kind="warn">
            No address on file for the {RX_SYSTEMS} rep, so an order cannot be sent. Add it below — everything else on
            this page works without it.
          </Notice>
        </div>
      )}

      {/* ── Where everything stands ─────────────────────────────────── */}
      <Card
        className="mt-4"
        title="Where each supply stands"
        subtitle="Ordered worst first. The day to act on is “order by”, not the day it runs out — after that the lead time is being eaten into the cushion."
      >
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="text-right">On hand</th>
                <th className="text-right">Per day</th>
                <th className="text-right">Days left</th>
                <th>Order by</th>
                <th className="text-right">Suggested</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {board.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-ink-3">
                      by the {r.unit}
                      {r.onOrder > 0 && ` · ${r.onOrder} on order`}
                    </div>
                  </td>
                  <td className="text-right">
                    {r.position.countedOn === null ? "—" : num(r.position.onHand)}
                    {r.position.countedOn && (
                      <div className="text-xs text-ink-3">counted {r.position.countedOn}</div>
                    )}
                  </td>
                  <td className="text-right">{r.rate.perDay === null ? "—" : num(r.rate.perDay)}</td>
                  <td className="text-right">{Number.isFinite(r.position.daysRemaining) ? num(r.position.daysRemaining) : "—"}</td>
                  <td className="whitespace-nowrap text-xs">
                    <span
                      className={`badge ${
                        r.position.state === "out" || r.position.state === "order now"
                          ? "badge-crit"
                          : r.position.state === "order soon"
                            ? "badge-warn"
                            : r.position.state === "ok"
                              ? "badge-ok"
                              : "badge-muted"
                      }`}
                    >
                      {r.position.state === "ok" ? (r.position.orderBy ?? "ok") : r.position.state}
                    </span>
                  </td>
                  <td className="text-right">{r.position.suggested || "—"}</td>
                  <td className="text-xs text-ink-3">
                    {r.rate.perDay === null
                      ? r.counts.length === 0
                        ? "never counted"
                        : `${r.counts.length} count${r.counts.length === 1 ? "" : "s"}, no rate yet`
                      : `${r.rate.confidence} — ${r.rate.intervals} interval${r.rate.intervals === 1 ? "" : "s"}, ${r.rate.daysObserved} days`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/*
          Only what the table has not already said.

          Every row carries its own evidence in the last column, so repeating "nothing has been
          counted yet" underneath it once per item is seven lines that say what seven cells already
          say. What is worth the space is the anomaly — a count that rose with no delivery logged —
          because that is the one a person has to do something about.
        */}
        {(() => {
          const anomalies = board.rows.flatMap((r) =>
            r.counts.length > 1 ? r.rate.problems.map((p) => ({ id: r.id, name: r.name, p })) : [],
          );
          return anomalies.length === 0 ? null : (
            <ul className="mt-3 space-y-1 text-xs text-ink-3">
              {anomalies.map((a) => (
                <li key={`${a.id}-${a.p}`}>
                  • <b className="text-ink-2">{a.name}</b> — {a.p}
                </li>
              ))}
            </ul>
          );
        })()}
        <p className="mt-3 text-xs text-ink-3">
          Every figure here comes from the counts below and nothing else. Two counts give a rate; the rest is the lead
          time and the cushion, which are set per item and can be changed as the real delivery times become known.
        </p>
      </Card>

      {/* ── The count ───────────────────────────────────────────────── */}
      <Card
        className="mt-4"
        title="Count the shelf"
        subtitle="Fill in what you can see and leave the rest blank. Counting the same item twice on one day corrects it rather than adding to it."
      >
        <form action={saveCounts}>
          <div className="max-w-xs">
            <Field label="Counted on" hint="The day the shelf was counted, not the day it is typed in.">
              <input type="date" name="countedOn" defaultValue={today} />
            </Field>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {board.rows.map((r) => (
              <Field key={r.id} label={r.name} hint={`in ${plural(r.unit, 2)} — last: ${r.counts.length ? `${r.counts[r.counts.length - 1].quantity} on ${r.counts[r.counts.length - 1].on}` : "never counted"}`}>
                <input name={`qty:${r.id}`} type="number" min={0} step="0.5" placeholder="—" inputMode="decimal" />
              </Field>
            ))}
          </div>
          <div className="mt-3">
            <SubmitButton pendingLabel="Saving…">Save the count</SubmitButton>
          </div>
        </form>
      </Card>

      {/* ── The order ───────────────────────────────────────────────── */}
      <Card
        className="mt-4"
        tone={urgent.length ? "warn" : undefined}
        title={`Order from ${RX_SYSTEMS}`}
        subtitle={repEmail ? `Sends an email to ${repEmail}. Quantities are prefilled where the site can work them out; change anything before sending.` : "Add the rep's address below to send an order from here."}
      >
        <form action={sendOrder}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {board.rows.map((r) => (
              <Field
                key={r.id}
                label={r.name}
                hint={r.position.state === "unknown" ? "no rate yet — your call" : r.position.says}
              >
                <input
                  name={`order:${r.id}`}
                  type="number"
                  min={0}
                  step="1"
                  defaultValue={r.position.state === "out" || r.position.state === "order now" ? r.position.suggested : ""}
                  placeholder="0"
                  inputMode="numeric"
                />
              </Field>
            ))}
          </div>
          <div className="mt-3 max-w-xl">
            <Field label="Anything to add for the rep" hint="Optional. Goes into the email above the sign-off.">
              <input name="note" placeholder="Please bill to the usual account." />
            </Field>
          </div>
          <div className="mt-3">
            <SubmitButton pendingLabel="Sending…" disabled={!repEmail}>Send the order</SubmitButton>
          </div>
        </form>

        {preview && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-ink-3">What the email will look like</summary>
            <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-ground p-3 text-xs">
              {`Subject: ${preview.subject}\n\n${preview.body}`}
            </pre>
          </details>
        )}
      </Card>

      {/* ── History, and the delivery confirmation the arithmetic needs ── */}
      <Card
        className="mt-4"
        title="Orders"
        subtitle="Mark an order as arrived when it does. It is not bookkeeping: a delivery nobody logged makes the counts either side of it read as a week where nothing was used."
      >
        {orders.length === 0 ? (
          <Empty>No orders yet.</Empty>
        ) : (
          <div className="space-y-3">
            {orders.map((o) => (
              <div key={o.id} className="rounded-md border border-line p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-sm">
                    <b>{o.placedOn}</b> · {o.vendorName}
                    {o.sentTo && <span className="text-ink-3"> → {o.sentTo}</span>}
                  </div>
                  <span
                    className={`badge ${o.status === "received" ? "badge-ok" : o.status === "sent" ? "badge-warn" : o.status === "cancelled" ? "badge-muted" : "badge-crit"}`}
                  >
                    {o.status === "received" ? `arrived ${o.receivedOn}` : o.status}
                  </span>
                </div>
                <ul className="mt-1 text-xs text-ink-3">
                  {o.lines.map((l) => (
                    <li key={l.id}>
                      {l.quantity} — {l.name}
                      {l.receivedQuantity !== null && l.receivedQuantity !== l.quantity && (
                        <b className="text-warn"> ({l.receivedQuantity} arrived)</b>
                      )}
                    </li>
                  ))}
                </ul>
                {o.sendError && <p className="mt-1 text-xs text-crit">Not sent: {o.sendError}</p>}
                {o.status === "sent" && (
                  <form action={markReceived} className="mt-2 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="orderId" value={o.id} />
                    <Field label="Arrived on">
                      <input type="date" name="receivedOn" defaultValue={today} />
                    </Field>
                    <SubmitButton pendingLabel="Saving…">Mark arrived</SubmitButton>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="mt-4" title="The rep" subtitle="Where an order from this page is sent.">
        <form action={saveRep} className="flex flex-wrap items-end gap-3">
          <Field label={`${RX_SYSTEMS} rep's email`} className="min-w-64">
            <input name="repEmail" type="email" defaultValue={repEmail} placeholder="rep@rxsystems.com" />
          </Field>
          <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
        </form>
        <p className="mt-3 text-xs text-ink-3">
          Sent through the pharmacy&rsquo;s own mailbox, the same one every other email on this site goes through —{" "}
          <Link href="/settings/email" className="underline">Settings → Email</Link>. An order that fails to send is kept
          as a draft above with the reason, never silently lost.
        </p>
      </Card>
    </>
  );
}
