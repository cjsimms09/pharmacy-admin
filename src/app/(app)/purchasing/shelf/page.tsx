import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fileOnHand, leanShelfNow, latestShelf, movement, SHELF_POLICY } from "@/lib/shelf";
import { units } from "@/lib/usage";
import { PageHeader, Card, Notice, Empty, Figure, Field } from "@/components/ui";
import { ExportData } from "@/components/export-data";
import { requireReimbursement } from "@/lib/features";

export const dynamic = "force-dynamic";
export const metadata = { title: "The shelf" };

/**
 * How lean the shelf is, and what should go back today.
 *
 * The pharmacy's stated intention is to hold one to two days of stock and return the rest at the
 * best moment. Nothing in the site could say whether it was doing that, because the one figure
 * needed was the one figure not held: what is physically here. Claims say what left and invoices
 * say what arrived, and the gap between them contains every short fill, partial bottle, return and
 * count ever done — so the shelf has to be read, not computed.
 *
 * With a count uploaded, three separate records become one sentence per drug: you hold this many
 * days of it, this much of that is surplus, and the supplier credits this much of the surplus
 * until this date.
 *
 * ── Why it is ordered by money ──
 *
 * A thousand days of stock of a four-dollar bottle is a rounding error, and three days of a GLP-1
 * is four thousand dollars. Ordered by days of stock the cheap junk sits at the top every morning
 * and the line that matters is buried. Ordered by the credit that falls at the next step, the
 * pharmacist's attention lands where the money is.
 */
export default async function ShelfPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireReimbursement();
  await requireUser();
  const { ok, error } = await searchParams;
  const [view, snapshot, move] = await Promise.all([leanShelfNow(), latestShelf(), movement()]);
  /*
   * The front shop, told apart rather than mixed in.
   *
   * Every rate on this page divides by claims, and a barcode has none. Adding vitamins to the
   * shelf value would flatter the surplus share; leaving them out of the page entirely would lose
   * eleven thousand dollars of stock the pharmacy owns. So it is one sentence, on its own.
   */
  const frontShopCents =
    snapshot && snapshot.valueCents !== null && snapshot.rxValueCents !== null
      ? snapshot.valueCents - snapshot.rxValueCents
      : null;
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const days = (n: number) => (Number.isFinite(n) ? `${Math.round(n)} days` : "never");

  async function upload(fd: FormData) {
    "use server";
    const u = await requireManager();
    const file = fd.get("file");
    const countedOn = String(fd.get("countedOn") ?? "").trim() || undefined;
    if (!(file instanceof File) || file.size === 0) redirect("/purchasing/shelf?error=" + encodeURIComponent("Choose a file."));
    const buf = Buffer.from(await file.arrayBuffer());
    const r = await fileOnHand(buf, file.name, { userId: u.id }, { countedOn });
    if (!r.ok) redirect("/purchasing/shelf?error=" + encodeURIComponent(r.why));
    await audit({
      action: "on_hand.import", userId: u.id, userName: u.name, entity: "on_hand", entityId: r.countedOn,
      details: `${r.items} items counted ${r.countedOn}${r.replaced ? ", replacing the previous upload for that day" : ""}`,
    });
    revalidatePath("/purchasing/shelf");
    revalidatePath("/purchasing");
    redirect(
      "/purchasing/shelf?ok=" +
        encodeURIComponent(
          `${r.items.toLocaleString()} items counted on ${r.countedOn}${r.replaced ? ", replacing the earlier upload for that day" : ""}.` +
            (r.unmappedColumns.length ? ` Columns not used: ${r.unmappedColumns.join(", ")}.` : ""),
        ),
    );
  }

  const t = view.totals;
  const urgent = view.rows.filter((r) => r.urgency === "today" || r.urgency === "this week");

  return (
    <>
      <PageHeader
        back={{ href: "/purchasing", label: "What to buy" }}
        title="The shelf"
        subtitle={`Days of stock against a ${SHELF_POLICY.targetDays}-day target, what is surplus, and what the supplier still credits for it.`}
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {view.missing.map((m) => (
        <div key={m} className="mt-3">
          <Notice kind="warn">{m}</Notice>
        </div>
      ))}

      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <Figure
          value={snapshot ? snapshot.items.toLocaleString() : "—"}
          label="items counted"
          sub={snapshot ? `Counted ${snapshot.countedOn}` : "No count uploaded yet"}
          tone={snapshot ? "ok" : "warn"}
        />
        <Figure
          value={snapshot?.rxValueCents !== null && snapshot?.rxValueCents !== undefined ? money(snapshot.rxValueCents) : "—"}
          label="on the dispensing shelf"
          sub={t.surplusShare !== null ? `${Math.round(t.surplusShare * 100)}% of it surplus` : "The file carried no values"}
          tone="muted"
        />
        <Figure value={money(t.surplusValueCents)} label="surplus" sub={`Beyond a ${SHELF_POLICY.targetDays}-day hold, across ${t.lines} lines`} tone={t.surplusValueCents > 0 ? "warn" : "ok"} />
        <Figure
          value={money(t.atRiskCents)}
          label="credit falling away"
          sub={`${urgent.length} ${urgent.length === 1 ? "line needs" : "lines need"} an authorisation this week`}
          tone={t.atRiskCents > 0 ? "crit" : "ok"}
        />
      </div>

      {frontShopCents !== null && frontShopCents > 0 && (
        <p className="mt-3 text-sm text-slate-500">
          A further {money(frontShopCents)} of front-shop stock was counted. Nothing in the claims dispenses it, so it is
          left out of every rate above and counted only in the stock the accounts close on.
        </p>
      )}

      {t.deadLines > 0 && (
        <div className="mt-4">
          <Notice kind="warn">
            <b>{t.deadLines} {t.deadLines === 1 ? "line has" : "lines have"} not been dispensed at all</b> in the{" "}
            {move ? `${move.from} to ${move.to}` : "window"} claims, worth {money(t.deadValueCents)}. That is a stocking decision to undo,
            not a quantity to trim — and the only question left on it is whether it can still go back.
          </Notice>
        </div>
      )}

      <Card
        title="Upload today's count"
        subtitle="PioneerRx's Inventory Search Results, or any on-hand export in text or CSV. One snapshot per day — uploading the same day twice replaces it rather than doubling the shelf."
      >
        <form action={upload} className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <Field label="The file" hint="The Inventory Search Results report as it comes, or any export with an NDC column beside a quantity-on-hand column.">
            <input type="file" name="file" accept=".txt,.csv,.tsv" required />
          </Field>
          <Field label="Count date" hint="Only needed where the file prints none.">
            <input type="date" name="countedOn" />
          </Field>
          <button type="submit" className="btn">Upload</button>
        </form>
        {snapshot && snapshot.unmappedColumns.length > 0 && (
          <p className="mt-3 text-sm text-ink-3">
            Columns in the last file this site had no meaning for: {snapshot.unmappedColumns.join(", ")}. Nothing was
            dropped silently — if one of those matters, say so and it can be read.
          </p>
        )}
        {snapshot && Object.keys(snapshot.skipReasons).length > 0 && (
          <p className="mt-2 text-sm text-ink-3">
            Rows not counted:{" "}
            {Object.entries(snapshot.skipReasons)
              .map(([why, n]) => `${n} ${why}`)
              .join("; ")}
            .
          </p>
        )}
      </Card>

      <Card
        title="Surplus, and what it is worth going back"
        subtitle={`Ordered by the credit that falls at the next step. A line at or under ${SHELF_POLICY.targetDays * 2} days of stock is not here — it is a lean position, not a return.`}
      >
        {view.rows.length === 0 ? (
          <Empty>
            {view.missing.length > 0
              ? "Nothing can be worked out until a count is uploaded and claims are held."
              : "Nothing on the shelf is beyond the target. That is the position this page exists to get to."}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Drug</th>
                  <th className="text-right">On hand</th>
                  <th className="text-right">Per day</th>
                  <th className="text-right">Days of stock</th>
                  <th className="text-right">Surplus</th>
                  <th className="text-right">Credit today</th>
                  <th>What to do</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.slice(0, 200).map((r) => (
                  <tr key={r.ndc11} >
                    <td>
                      <div className="font-medium">{r.name ?? r.ndc11}</div>
                      <div className="text-xs text-ink-3">{r.ndc11}</div>
                    </td>
                    <td className="text-right">{units(r.onHandThousandths)}</td>
                    <td className="text-right">{r.perDayThousandths > 0 ? units(r.perDayThousandths) : "—"}</td>
                    <td className="text-right">{days(r.daysOfStock)}</td>
                    <td className="text-right">
                      {units(r.surplusThousandths)}
                      {r.surplusValueCents !== null && <div className="text-xs text-ink-3">{money(r.surplusValueCents)}</div>}
                    </td>
                    <td className="text-right">
                      {r.ret?.creditNowCents !== null && r.ret?.creditNowCents !== undefined ? money(r.ret.creditNowCents) : "—"}
                      {r.ret?.atRiskCents ? <div className="text-xs text-warn">−{money(r.ret.atRiskCents)} at the next step</div> : null}
                    </td>
                    <td className="text-sm">{r.says}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {view.rows.length > 200 && <p className="mt-2 text-sm text-ink-3">Showing the 200 with most at stake, of {view.rows.length}.</p>}
          </div>
        )}
      </Card>

      <p className="mt-4 text-sm text-ink-3">
        The return deadlines here come from the same invoice clock as{" "}
        <Link href="/inventory/returns" className="underline">What to send back</Link>, which lists every returnable invoice
        line whether or not it is surplus. This page is the other half of the question: of what is returnable, what does
        the pharmacy not need.
      </p>

      <ExportData page="shelf" className="mt-6" />
    </>
  );
}
