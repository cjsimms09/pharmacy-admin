import { familyTabs } from "@/lib/families";
import type React from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { importSupplierCatalog, importPioneerCatalog, purchasingOpportunities, supplierSummary, catalogSchedule } from "@/lib/suppliers";
import { getSettings } from "@/lib/settings";
import { hasMailPassword } from "@/lib/mailbox";
import { FILE_NAME_CODES } from "@/lib/pioneer-catalog";
import { productLedger, opportunities, margins, losers, type Flag } from "@/lib/product-ledger";
import Link from "next/link";
import { looksLikePioneerCatalog } from "@/lib/pioneer-catalog";
import { formatCents } from "@/lib/money";
import { countAge } from "@/lib/count-age";
import { fmt, todayIso } from "@/lib/dates";
import { requireReimbursement } from "@/lib/features";
import { PageHeader, Notice, Empty, Field, Card, Figure } from "@/components/ui";
import { Hub } from "@/components/hub";
import { DataTable } from "@/components/data-table";
import { ExportData } from "@/components/export-data";

export const metadata = { title: "Purchasing" };
export const dynamic = "force-dynamic";

/** Micros to a displayable per-unit price, at the five decimals these prices are quoted in. */
const money = (cents: number) => formatCents(cents);
const perUnit = (micros: number | null) =>
  micros === null ? "—" : `${micros < 0 ? "-" : ""}$${(Math.abs(micros) / 1_000_000).toFixed(5)}`;

export default async function PurchasingPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireReimbursement();
  await requireUser();
  const { ok, error } = await searchParams;
  const [opps, summary, schedule, s, mailReady, ledger] = await Promise.all([
    purchasingOpportunities(), supplierSummary(), catalogSchedule(), getSettings(), hasMailPassword(), productLedger(),
  ]);
  const ledgerRows = opportunities(ledger.rows);

  /*
   * The buy list: every NDC offered under what the benchmark says the drug costs, after the rebate.
   *
   * The table below answers "what did we pay against what everyone else charges". This answers the
   * one the owner actually asks — what should we be buying — by ranking the gap under NADAC and
   * then, per product, naming the NDC that beats the one being dispensed today. NDCs are grouped
   * into products on NADAC's own description, so a switch is between genuine equivalents.
   */
  /*
   * Today's order: what the shelf is short of, who sells it cheapest, and whether that supplier
   * will actually ship it. Loaded here rather than on its own page because it is the answer the
   * three tables below only inform — they say where the money is, this says what to do about it.
   */
  const { buyListNow, SHELF_POLICY, nextTierNow } = await import("@/lib/shelf");
  const buyList = await buyListNow();
  /*
   * The band above, at the screen where the order is placed.
   *
   * Every line below is chosen on its own invoice price, which is right for the line and can be
   * wrong for the month: a generic 8% dearer at the primary is a bad line and a good month if it
   * carries the ratio into a band worth more than the premium. That comparison belongs here, above
   * the basket, because it is the one thing on this page that changes where the whole order goes.
   */
  const nextTier = await nextTierNow();

  const { underNadac, switchNdc, notYetBought } = await import("@/lib/under-nadac");
  const { groupKey } = await import("@/lib/product-groups");
  const { db, schema } = await import("@/db");
  /*
   * One row per drug, not every price ever published.
   *
   * This map only needs a description and a classification per NDC, and it kept the first row it
   * saw of each. Reading the whole table to do that is fourteen seconds on a year of weekly files,
   * on the page the owner opens to decide an order — which is what made pressing a button here
   * look like nothing happening.
   */
  const nadacForGroups = await (await import("@/lib/nadac-latest")).nadacNow();
  void schema;
  const groupByNdc = new Map<string, string | null>();
  for (const r of nadacForGroups) {
    if (groupByNdc.has(r.ndc11)) continue;
    groupByNdc.set(r.ndc11, groupKey({ ndc11: r.ndc11, description: r.description, classification: r.classification, pricingUnit: r.pricingUnit }));
  }
  const buys = underNadac(ledger.rows, (ndc) => groupByNdc.get(ndc) ?? null);
  const switches = switchNdc(buys);
  const unstocked = notYetBought(buys);
  /*
   * What each drug earns, which is a different question from what it costs.
   *
   * A drug bought well below the benchmark can still be dispensed at a loss where the plan pays
   * below acquisition, and a drug bought above it can be the best margin on the shelf. The
   * comparison above answers "am I paying too much"; this answers "is this worth dispensing".
   */
  const earned = margins(ledger.rows);
  const losing = losers(earned);
  const bestEarners = earned.filter((m) => m.marginCents > 0).slice(0, 15);
  const totalMarginCents = earned.reduce((n, m) => n + m.marginCents, 0);
  const autoImport = (s.mail_auto_import ?? "").toLowerCase() === "yes";
  const mailOn = s.mail_enabled === "yes";

  async function upload(fd: FormData) {
    "use server";
    const u = await requireManager();
    const supplier = String(fd.get("supplier") ?? "").trim();
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) redirect("/purchasing?error=" + encodeURIComponent("Choose a file."));
    const buf = Buffer.from(await file.arrayBuffer());
    try {
      /*
       * PioneerRx's own export names its suppliers inside the file, so it needs no supplier typed
       * and may carry several at once. Detected from the content, not the name somebody gave it.
       */
      if (looksLikePioneerCatalog(buf.subarray(0, 8192).toString("utf8"))) {
        const r = await importPioneerCatalog(buf, file.name, u.id);
        await audit({ action: "supplier.import", userId: u.id, userName: u.name, details: `${file.name}: ${r.suppliers.map((x) => `${x.supplier} ${x.itemsAdded}+${x.itemsUpdated}`).join(", ")}` });
        revalidatePath("/purchasing");
        if (r.suppliers.length === 0) redirect("/purchasing?error=" + encodeURIComponent(r.problems.join(" ") || "Nothing could be loaded from that file."));
        const bits = r.suppliers.map((x) => `${x.supplier}: ${x.itemsAdded} new, ${x.itemsUpdated} repriced${x.shortDated ? `, ${x.shortDated} short-dated lots noted` : ""}${x.rebated !== null ? `, ${x.rebated} rebated` : ", no rebate column"}`);
        if (r.pricedOn) bits.push(`prices as of ${r.pricedOn}`);
        if (r.skipped) bits.push(`${r.skipped.toLocaleString()} rows skipped (${Object.entries(r.skipReasons).map(([k, v]) => `${v} ${k}`).join(", ")})`);
        redirect("/purchasing?ok=" + encodeURIComponent(bits.join(". ") + "."));
      }
      if (!supplier) redirect("/purchasing?error=" + encodeURIComponent("Name the supplier this file came from."));
      const r = await importSupplierCatalog(buf, file.name, supplier, u.id);
      await audit({ action: "supplier.import", userId: u.id, userName: u.name, details: `${supplier}: ${r.itemsAdded} added, ${r.itemsUpdated} updated, ${r.skipped} skipped` });
      revalidatePath("/purchasing");
      const bits = [`${r.itemsAdded} new and ${r.itemsUpdated} updated for ${supplier}`];
      if (r.skipped) bits.push(`${r.skipped} skipped (${Object.entries(r.skipReasons).map(([k, v]) => `${v} ${k}`).join(", ")})`);
      if (r.unkeyable) bits.push(`${r.unkeyable} could not be matched to a product by description`);
      if (r.unmappedColumns.length) bits.push(`columns not recognised: ${r.unmappedColumns.slice(0, 6).join(", ")}`);
      redirect("/purchasing?ok=" + encodeURIComponent(bits.join(". ") + "."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/purchasing?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not read that file."));
    }
  }

  const totalSaving = opps.rows.reduce((s, r) => s + (r.savingCents ?? 0), 0);
  const countAge_ = buyList.snapshot ? countAge(buyList.snapshot.countedOn, todayIso()) : null;
  const ordering = buyList.plan.baskets.filter((b) => b.verdict === "order" || b.verdict === "top_up_to_order");
  const held = buyList.plan.baskets.filter((b) => b.verdict === "hold").length;

  return (
    <>
      <PageHeader
        tabs={familyTabs("order", "/purchasing")}
        title="Purchasing"
        subtitle="What we dispense, what we paid for it, and whether a cheaper source exists for the same product."
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {/*
        Everything below is computed against the daily count. An order placed off a stale one buys
        a second bottle of what landed on Wednesday, so the age of the count is said before the
        figures rather than buried under them.
      */}
      {countAge_ && countAge_.warns && (
        <Notice kind="warn">
          <b>The shelf was {countAge_.says}</b> — {fmt(buyList.snapshot!.countedOn)}. {countAge_.warns}{" "}
          <Link href="/purchasing/shelf" className="underline">Upload it here</Link>.
        </Notice>
      )}
      {!buyList.snapshot && (
        <Notice kind="warn">
          <b>No inventory count has been uploaded.</b> Without one the site cannot tell a shelf that is short from one
          that is full, so nothing below knows what is already held.{" "}
          <Link href="/purchasing/shelf" className="underline">Upload today&rsquo;s count</Link>.
        </Notice>
      )}

      {/*
        The section at a glance, before any list. Each figure is a link to the part of the page
        (or the page under Ordering) that explains it, so a number is never a dead end.
      */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Figure
          size="sm"
          value={money(ordering.reduce((n, b) => n + b.subtotalCents + b.freightCents, 0))}
          label="Today's order"
          sub={ordering.length === 0 ? (buyList.plan.baskets.length ? "every basket on hold" : "nothing to order") : `${ordering.length} supplier${ordering.length === 1 ? "" : "s"} · ${ordering.reduce((n, b) => n + b.lines.length, 0)} lines${held ? ` · ${held} on hold` : ""}`}
          tone={held ? "warn" : "muted"}
          href="#order"
        />
        <Figure
          size="sm"
          value={money(ordering.reduce((n, b) => n + b.savingCents, 0))}
          label="Saved by buying it there"
          sub="against the primary, after rebates"
          tone="ok"
          href="/purchasing/minimums"
        />
        <Figure
          size="sm"
          value={nextTier && nextTier.worthCents > 0 ? money(nextTier.worthCents) : "—"}
          label="Next rebate band"
          sub={nextTier && nextTier.worthCents > 0 ? `${nextTier.nextRatePercent}% at ${nextTier.supplier}${nextTier.daysLeft > 0 ? `, ${nextTier.daysLeft} day${nextTier.daysLeft === 1 ? "" : "s"} left` : ""}` : "no band within reach this month"}
          tone={nextTier && nextTier.worthCents > 0 && nextTier.daysLeft <= 7 ? "warn" : "muted"}
          href="/suppliers"
        />
        <Figure
          size="sm"
          value={switches.length}
          label="Buy these instead"
          sub={`${unstocked.length} more offered under the benchmark and not stocked`}
          tone={switches.length ? "ok" : "muted"}
          href="#instead"
        />
        <Figure
          size="sm"
          value={losing.length}
          label="Dispensed at a loss"
          sub={losing.length ? `${money(Math.abs(losing.reduce((n, m) => n + m.marginCents, 0)))} so far` : "every product held earns"}
          tone={losing.length ? "crit" : "ok"}
          href={earned.length ? "#earns" : undefined}
        />
      </div>

      {/*
        Today's order.

        Three things had to be joined for this to exist and none of them was: what is on the shelf
        (a count, uploaded daily), how fast it leaves (the claims, one row per dispensing), and
        what each supplier charges after their rebate. The interesting part is not the arithmetic —
        it is the minimum. A secondary is cheaper on eleven items and will not ship under $500, and
        the three ways out of that are lose the saving, pad the order with stock nobody wanted, or
        find the items this supplier is *also* cheapest on that move fast enough to buy deep. Only
        the third is a decision, and it needs numbers nobody has in their head at the order screen.
      */}
      {nextTier && nextTier.worthCents > 0 && nextTier.breakEvenPremiumPercent !== null && (
        <Notice kind={nextTier.daysLeft <= 7 ? "warn" : undefined}>
          <b>
            The {nextTier.nextRatePercent}% band at {nextTier.supplier} is worth {money(nextTier.worthCents)} more this
            month{nextTier.daysLeft > 0 ? `, with ${nextTier.daysLeft} day${nextTier.daysLeft === 1 ? "" : "s"} to earn it` : ""}.
          </b>{" "}
          {nextTier.says} Where a line below sends generics elsewhere to save less than{" "}
          {nextTier.breakEvenPremiumPercent.toFixed(2)}%, buying it at {nextTier.supplier} is the cheaper month.
        </Notice>
      )}

      <Card
        id="order"
        className="my-4"
        title="Today&rsquo;s order"
        tone={buyList.plan.baskets.some((b) => b.verdict === "hold") ? "warn" : undefined}
        actions={
          <>
            <Link href="/purchasing/shelf" className="btn btn-sm">The shelf</Link>
            <Link href="/purchasing/catalog" className="btn btn-sm">The catalogue</Link>
            <Link href="/purchasing/supplies" className="btn btn-sm">Supplies</Link>
          </>
        }
      >

        {buyList.missing.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-ink-3">
            {buyList.missing.map((m) => (
              <li key={m}>• {m}</li>
            ))}
          </ul>
        )}

        {buyList.plan.baskets.length === 0 ? (
          <p className="mt-2 text-xs text-ink-3">
            Nothing to order: either the shelf holds {SHELF_POLICY.targetDays} days of everything that moves, or the
            figures above have not been loaded yet.
          </p>
        ) : (
          <>
            <p className="mt-1 text-xs text-ink-3">
              {buyList.needs.length.toLocaleString()} {buyList.needs.length === 1 ? "item is" : "items are"} under a{" "}
              {SHELF_POLICY.targetDays}-day hold. Prices are after each supplier&rsquo;s rebate, so a contract line is
              compared at what it actually costs. A bulk buy to reach a minimum is capped at{" "}
              {SHELF_POLICY.maxTopUpDays} days of real movement and never offered on something that has not been
              dispensing.
            </p>
            <div className="mt-3 space-y-4">
              {buyList.plan.baskets.map((b) => (
                <div key={b.supplier} className="rounded-md border border-line p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <b className="text-sm">{b.supplier}</b>{" "}
                      <span className="text-xs text-ink-3">
                        {b.lines.length} {b.lines.length === 1 ? "line" : "lines"} · {money(b.subtotalCents)}
                        {b.freightCents > 0 && ` + ${money(b.freightCents)} freight`}
                        {b.minimumCents !== null && ` · minimum ${money(b.minimumCents)}`}
                      </span>
                    </div>
                    <span
                      className={`badge ${
                        b.verdict === "order" || b.verdict === "top_up_to_order"
                          ? "badge-ok"
                          : b.verdict === "hold"
                            ? "badge-warn"
                            : "badge-muted"
                      }`}
                    >
                      {b.verdict === "order"
                        ? "Order it"
                        : b.verdict === "top_up_to_order"
                          ? "Order with the top-ups"
                          : b.verdict === "hold"
                            ? "Hold"
                            : "Buy at the primary instead"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-ink-3">{b.why}</p>
                  {b.bandDeltaCents !== null && b.bandDeltaCents !== 0 && (
                    <p className="mt-1 text-xs">
                      <b className={b.bandDeltaCents < 0 ? "text-crit" : "text-accent"}>
                        {b.bandDeltaCents < 0 ? "−" : "+"}
                        {money(Math.abs(b.bandDeltaCents))}
                      </b>{" "}
                      through the rebate band, against {money(b.savingCents)} on the invoice.
                    </p>
                  )}
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="text-ink-3">
                        <tr>
                          <th className="py-1 text-left font-medium">Drug</th>
                          <th className="py-1 text-right font-medium">Packs</th>
                          <th className="py-1 text-right font-medium">Cost</th>
                          <th className="py-1 text-right font-medium">Saves</th>
                          <th className="py-1 text-right font-medium">Days of stock after</th>
                          <th className="py-1 text-left font-medium">Why</th>
                        </tr>
                      </thead>
                      <tbody>
                        {b.lines.map((l) => (
                          <tr key={l.ndc11}>
                            <td className="py-1">
                              {l.name ?? l.ndc11}
                              <div className="text-ink-3">{l.ndc11}</div>
                            </td>
                            <td className="py-1 text-right">
                              {l.packs} × {l.packQty}
                              {l.packOverageThousandths > 0 && (
                                <div className="text-ink-3">{Math.round(l.packOverageThousandths / 1000)} over the need</div>
                              )}
                            </td>
                            <td className="py-1 text-right">{money(l.costCents)}</td>
                            <td className="py-1 text-right">{l.savingCents > 0 ? money(l.savingCents) : "—"}</td>
                            <td className="py-1 text-right">
                              {Number.isFinite(l.daysOfStockAfter) ? Math.round(l.daysOfStockAfter) : "—"}
                            </td>
                            <td className="py-1">
                              {l.reason === "need" ? "Short of the target" : "Added to reach the minimum"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {b.refusals.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-ink-3">
                        {b.refusals.length} {b.refusals.length === 1 ? "item was" : "items were"} considered for the
                        top-up and refused
                      </summary>
                      <ul className="mt-1 space-y-0.5 text-xs text-ink-3">
                        {b.refusals.slice(0, 25).map((r) => (
                          <li key={r.ndc11}>
                            <b className="text-ink-2">{r.name ?? r.ndc11}</b> — {r.why}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              ))}
            </div>
            {buyList.plan.unfilled.length > 0 && (
              <p className="mt-3 text-xs text-ink-3">
                {buyList.plan.unfilled.length} needed {buyList.plan.unfilled.length === 1 ? "item has" : "items have"} no
                supplier price with a known pack size, so nothing can be ordered for {buyList.plan.unfilled.length === 1 ? "it" : "them"} here.
              </p>
            )}
          </>
        )}
      </Card>

      <Card title="Load a supplier price file" className="my-4">        <p className="mt-1 text-xs text-ink-3">
          An order guide or price list from any wholesaler, as .xlsx or .csv. Column names differ between suppliers
          and are matched loosely — anything not recognised is reported back rather than ignored. Loading a file again
          replaces that supplier&rsquo;s prices for the NDCs it covers and leaves every other supplier alone.
        </p>
        <form action={upload} className="flex flex-wrap items-end gap-3">
          <Field label="Supplier" hint="Leave blank for a PioneerRx export, which names its own.">
            <input name="supplier" placeholder="McKesson" className="w-48" />
          </Field>
          <Field label="The file">
            <input type="file" name="file" accept=".xlsx,.csv,.txt" className="text-sm" />
          </Field>
          <button className="btn btn-primary">Load</button>
        </form>

        {summary.counts.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-3">
            {summary.counts.map((c) => (
              <li key={c.supplier}>
                <b className="text-ink-2">{c.supplier}</b> — {Number(c.items).toLocaleString()} items,{" "}
                {Number(c.keyed).toLocaleString()} matchable by description
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/*
        The Sunday files, and whether the door is open for them.

        Four scheduled PioneerRx exports, one per supplier, named Supplier + run date, emailed to
        the site's mailbox. Everything that has to be true for them to load on their own is listed
        here with its state, and each supplier has a row saying when its file last came — so on the
        Monday after the first Sunday, "did it work" is answered by one glance at this panel, and
        "what went wrong" by the Inbox line it points to.
      */}
      <Card title="Scheduled catalogues" className="my-4">        <p className="mt-1 text-xs text-ink-3">
          PioneerRx emails one file per supplier, named <span className="font-mono">Supplier</span> + run date
          &mdash; {FILE_NAME_CODES.map((c) => <span key={c} className="font-mono">{c}9_6_2026</span>).reduce<React.ReactNode[]>((acc, x, i) => (i ? [...acc, ", ", x] : [x]), [])}.
          The site reads the supplier from inside the file and checks it against the name; a file named for one supplier
          that carries another is refused, and the <Link href="/inbox" className="text-accent underline">Inbox</Link> line
          says so.
        </p>
        <ul className="mt-3 grid gap-1 text-xs sm:grid-cols-3">
          <li className="flex items-center gap-2">
            <span className={`badge ${mailReady ? "badge-ok" : "badge-crit"}`}>{mailReady ? "ready" : "not set up"}</span>
            Mailbox connected {!mailReady && <Link href="/settings/email" className="text-accent underline">(set up)</Link>}
          </li>
          <li className="flex items-center gap-2">
            <span className={`badge ${mailOn ? "badge-ok" : "badge-crit"}`}>{mailOn ? "on" : "off"}</span>
            Checked automatically {!mailOn && <Link href="/settings/email" className="text-accent underline">(turn on)</Link>}
          </li>
          <li className="flex items-center gap-2">
            <span className={`badge ${autoImport ? "badge-ok" : "badge-crit"}`}>{autoImport ? "on" : "off"}</span>
            Loaded on arrival {!autoImport && <Link href="/settings/email" className="text-accent underline">(turn on)</Link>}
          </li>
        </ul>
        {s.mail_allowed_senders?.trim() && (
          <p className="mt-2 text-xs text-ink-3">
            Only listed senders are read. The address PioneerRx sends from must be on the list under Settings → Email, or
            the message is left unread and the Inbox says &ldquo;sender is not on the allowed list&rdquo;.
          </p>
        )}
        <div className="mt-3 overflow-x-auto">
          <table className="table">
            <thead>
              <tr><th>Supplier</th><th>Last file</th><th>Received</th><th className="text-right">Items read</th><th>Prices as of</th></tr>
            </thead>
            <tbody>
              {schedule.map((row) => {
                const age = row.lastAt ? (Date.now() - Date.parse(row.lastAt)) / 86_400_000 : null;
                const tone = age === null ? "badge-muted" : age > 9 ? "badge-warn" : "badge-ok";
                return (
                  <tr key={row.supplier}>
                    <td className="font-medium">{row.supplier}</td>
                    <td className="font-mono text-xs">{row.fileName ?? <span className="text-ink-3">never arrived</span>}</td>
                    <td className="whitespace-nowrap text-xs">
                      {row.lastAt ? <><span className={`badge ${tone}`}>{age! < 1 ? "today" : `${Math.floor(age!)}d ago`}</span> {row.lastAt.slice(0, 10)}</> : <span className="badge badge-muted">waiting</span>}
                    </td>
                    <td className="text-right tabular-nums">{row.rowsRead === null ? "—" : row.rowsRead.toLocaleString()}</td>
                    <td className="text-xs">{row.pricedOn ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/*
        Everything known about a drug, in one row.

        The four records that answer this question were held apart: the invoices say what was
        actually paid and whether the line earned the rebate, the catalogues say what everyone else
        charges, NADAC says what the government reckons it costs, and the claims say what went out
        of the door. Each on its own is a page somebody has to reconcile in their head. Together
        they say which drugs to move, where to, and what it is worth.
      */}
      {/*
        The switches worth making, above the table that explains them.
        
        A table of every drug is a reference; this is the list of things to actually do this week,
        ranked by what each is worth on the quantities this pharmacy dispenses — because a large
        percentage off something bought twice a year is not worth an afternoon.
      */}
      {(switches.length > 0 || unstocked.length > 0) && (
        <Card id="instead" title="Buy these instead" className="my-4">          <p className="mt-1 text-xs text-ink-2">
            Every NDC offered under what the federal benchmark says the drug costs, after the rebate this pharmacy
            actually earns. Grouped into products on NADAC&rsquo;s own description, so a switch is between genuine
            equivalents rather than between things that merely sound alike.
          </p>

          {switches.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Buying now</th>
                    <th>Better</th>
                    <th className="text-right">Worth</th>
                  </tr>
                </thead>
                <tbody>
                  {switches.slice(0, 25).map((p) => (
                    <tr key={p.groupKey} className="border-t border-line align-top">
                      <td>
                        {p.name ?? p.pick.ndc11}
                        <span className="block text-[11px] text-ink-3">{p.units.toLocaleString()} units dispensed</span>
                      </td>
                      <td className="font-mono text-[11px]">{p.current?.ndc11 ?? "—"}</td>
                      <td>
                        <span className="font-mono text-[11px]">{p.pick.ndc11}</span>
                        <span className="block text-[11px] text-ink-3">{p.pick.buy.supplier}</span>
                      </td>
                      <td className="text-right font-medium tabular-nums text-accent">{formatCents(p.gainCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {switches.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-ink-2">
              {switches.slice(0, 5).map((p) => (
                <li key={`says-${p.groupKey}`}>{p.says}</li>
              ))}
            </ul>
          )}

          {unstocked.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-ink-3">
                {unstocked.length} NDCs offered well under the benchmark that this pharmacy neither buys nor dispenses
              </summary>
              <p className="mt-1 text-xs text-ink-3">
                Not a recommendation on its own — a drug nobody here dispenses is not worth stocking however cheap it
                is. It is the shelf the pharmacy does not have, for the day somebody asks why a script went elsewhere.
              </p>
              <ul className="mt-2 grid gap-0.5 text-xs sm:grid-cols-2">
                {unstocked.slice(0, 30).map((r) => (
                  <li key={r.ndc11} className="flex justify-between gap-2">
                    <span className="truncate">{r.name ?? r.ndc11}</span>
                    <span className="shrink-0 tabular-nums text-ink-3">{r.underNadacPercent.toFixed(0)}% under</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {buys.excluded.length > 0 && (
            <p className="mt-2 text-[11px] text-ink-3">
              {buys.excluded.length} rows could not be measured and are named rather than dropped — a shorter list reads
              as good news.
            </p>
          )}
        </Card>
      )}

      <Card title="What to do about it" className="my-4">        <p className="mt-1 text-sm text-ink-2">
          Every drug this pharmacy has bought or dispensed, with what was paid, what it earns back, what else it costs
          elsewhere and what the benchmark says. Sorted by what the move is actually worth on the quantities dispensed,
          because a large percentage off something bought twice a year is not worth an afternoon.
        </p>
        {ledger.rate === null ? (
          <p className="mt-2 rounded-md border border-warn bg-warn-soft px-3 py-2 text-xs text-warn">
            <b>No generic rebate rate is on file, so every McKesson contract line is being compared at its gross invoice
            price.</b> That understates this pharmacy&rsquo;s position rather than overstating it — a rebated line looks
            dearer than it is, so a competitor may look better than it really is. Put the tier rate from the rebate
            report in Settings and every figure below sharpens. It is deliberately not estimated.
          </p>
        ) : (
          <p className="mt-2 text-xs text-ink-3">
            Contract lines are compared after taking off the {(ledger.rate * 100).toFixed(2)}% generic tier rate from
            the rebate report. A line the invoice did not mark as rebated is never given that discount.
          </p>
        )}
        {ledgerRows.length === 0 ? (
          <Empty>
            Nothing to compare yet. This fills in as invoices arrive and are read, the Monday catalogues land, and NADAC
            is fetched — it needs at least the invoices, which is where what you actually paid comes from.
          </Empty>
        ) : (
          <div className="mt-3">
            <DataTable
              initialSort={{ key: "worth", dir: "desc" }}
              caption={`${ledgerRows.length.toLocaleString()} drugs · sort by any column, filter by name, NDC or supplier`}
              columns={[
                { key: "drug", label: "Drug" },
                { key: "pay", label: "We pay", align: "right" },
                { key: "nadac", label: "NADAC", align: "right" },
                { key: "vs", label: "Against it", align: "right", firstSort: "desc" },
                { key: "best", label: "Cheapest known" },
                { key: "worth", label: "Worth", align: "right" },
                { key: "means", label: "What it means", sortable: false },
              ]}
              rows={ledgerRows.map((r) => ({
                key: r.ndc11,
                sort: {
                  drug: `${r.name ?? ""} ${r.ndc11}`,
                  pay: r.paid ? r.paid.effectiveUnitMicros : null,
                  nadac: r.nadacMicros,
                  vs: r.vsNadacMicros,
                  best: r.best ? `${r.best.supplier} ${r.best.effectiveUnitMicros}` : null,
                  worth: r.switchSavingCents ?? 0,
                  means: r.flags.map((f) => MEANS[f]).join(" "),
                },
                cells: {
                  drug: (
                    <>
                      <span className="block text-sm font-medium">{r.name ?? "—"}</span>
                      <span className="font-mono text-xs text-ink-3">{r.ndc11}</span>
                    </>
                  ),
                  pay: (
                    <span className="whitespace-nowrap text-sm">
                      {r.paid ? perUnit(r.paid.effectiveUnitMicros) : "—"}
                      {r.paid?.rebated === true && <span className="badge badge-ok ml-1">rebated</span>}
                      {r.paid && <span className="block text-xs text-ink-3">{r.paid.supplier}</span>}
                    </span>
                  ),
                  nadac: <span className="whitespace-nowrap text-sm">{r.nadacMicros === null ? <span className="text-ink-3">none</span> : perUnit(r.nadacMicros)}</span>,
                  vs: (
                    <span className={`whitespace-nowrap text-sm ${r.vsNadacMicros === null ? "" : r.vsNadacMicros > 0 ? "text-crit" : "text-accent"}`}>
                      {r.vsNadacMicros === null ? "—" : `${r.vsNadacMicros > 0 ? "+" : ""}${perUnit(r.vsNadacMicros)}`}
                    </span>
                  ),
                  best: r.best ? (
                    <span className="text-sm">
                      {r.best.supplier}
                      <span className="block text-xs text-ink-3">{perUnit(r.best.effectiveUnitMicros)} · {r.best.source === "invoice" ? "what we paid" : "listed"}</span>
                    </span>
                  ) : (
                    <span className="text-sm text-ink-3">—</span>
                  ),
                  worth: <span className="whitespace-nowrap text-sm font-medium">{r.switchSavingCents ? `$${(r.switchSavingCents / 100).toFixed(2)}` : "—"}</span>,
                  means: (
                    <span className="text-xs">
                      {r.flags.map((f) => (
                        <span key={f} className={`badge mr-1 ${f === "buying_above_nadac" || f === "not_dispensed" ? "badge-warn" : f === "cheaper_elsewhere" ? "badge-ok" : "badge-muted"}`}>
                          {MEANS[f]}
                        </span>
                      ))}
                    </span>
                  ),
                },
              }))}
            />
          </div>
        )}
      </Card>

      {/*
        Margin, which is the question the comparison does not answer.

        Everything above says what the pharmacy pays against what it could pay and against the
        benchmark. None of that says whether dispensing the drug makes money, and the two do not
        follow from each other. This is revenue received against the cost actually paid — after the
        rebate the supplier really pays on that line, because a margin worked out on gross invoice
        prices understates every contract generic by the tier rate, which here is enough to turn a
        profitable drug into an apparent loss and get it dropped.
      */}
      {earned.length > 0 && (
        <Card id="earns" title="What each drug earns" className="my-4">          <p className="mt-1 text-sm text-ink-2">
            What the plans and patients paid, against what the drug actually cost this pharmacy — the invoice price less
            the rebate that supplier really pays on the line. Across everything held, {money(totalMarginCents)} on{" "}
            {earned.length.toLocaleString()} product{earned.length === 1 ? "" : "s"}.
          </p>

          {losing.length > 0 && (
            <div className="mt-3 rounded-md border border-crit bg-crit-soft p-3">
              <p className="text-sm font-semibold text-crit">
                {losing.length} dispensed at a loss, costing {money(Math.abs(losing.reduce((n, m) => n + m.marginCents, 0)))} so far
              </p>
              <div className="mt-2 overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr><th>Drug</th><th>From</th><th className="text-right">Came in</th><th className="text-right">Cost</th><th className="text-right">Loss</th><th className="text-right">Per unit</th></tr>
                  </thead>
                  <tbody>
                    {losing.slice(0, 10).map((m) => (
                      <tr key={m.ndc11}>
                        <td>
                          <span className="block text-sm">{m.name ?? "—"}</span>
                          <span className="font-mono text-[11px] text-ink-3">{m.ndc11} · {m.claims} claim{m.claims === 1 ? "" : "s"}</span>
                        </td>
                        <td className="text-xs">{m.supplier ?? "—"}{m.rebated === true && <span className="badge badge-ok ml-1">rebated</span>}</td>
                        <td className="num text-sm">{money(m.receivedCents)}</td>
                        <td className="num text-sm">{money(m.costCents)}</td>
                        <td className="num text-sm font-medium text-crit">{money(m.marginCents)}</td>
                        <td className="num text-xs">{perUnit(m.marginPerUnitMicros)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-ink-2">
                A loss here is the plan paying below what the drug cost. It is not always a reason to stop dispensing —
                but it is always a reason to know, and the ones bought above the benchmark are also the ones worth
                appealing or sourcing elsewhere.
              </p>
            </div>
          )}

          <div className="mt-3 overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Best earners</th><th>From</th>
                  <th className="text-right">Came in</th><th className="text-right">True cost</th>
                  <th className="text-right">Margin</th><th className="text-right">%</th><th className="text-right">vs NADAC</th>
                </tr>
              </thead>
              <tbody>
                {bestEarners.map((m) => (
                  <tr key={m.ndc11}>
                    <td>
                      <span className="block text-sm">{m.name ?? "—"}</span>
                      <span className="font-mono text-[11px] text-ink-3">{m.ndc11} · {m.unitsDispensed.toLocaleString()} units</span>
                    </td>
                    <td className="text-xs">{m.supplier ?? "—"}{m.rebated === true && <span className="badge badge-ok ml-1">rebated</span>}</td>
                    <td className="num text-sm">{money(m.receivedCents)}</td>
                    <td className="num text-sm">{money(m.costCents)}</td>
                    <td className="num text-sm font-medium text-accent">{money(m.marginCents)}</td>
                    <td className="num text-sm">{m.marginPercent === null ? "—" : `${m.marginPercent}%`}</td>
                    <td className={`num text-xs ${m.vsNadacMicros === null ? "" : m.vsNadacMicros > 0 ? "text-crit" : "text-accent"}`}>
                      {m.vsNadacMicros === null ? "—" : `${m.vsNadacMicros > 0 ? "+" : ""}${perUnit(m.vsNadacMicros)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-ink-3">
            Nothing appears here without a price this pharmacy actually paid and a pack size to convert it by. NADAC is
            what pharmacies on average paid, not what this one paid, so it is never used as the cost side — a margin
            worked out from it would be a statement about somebody else&rsquo;s business.
          </p>
        </Card>
      )}

      {!opps.ready ? (
        <Notice kind="warn">{opps.reason}</Notice>
      ) : (
        <>
          {totalSaving > 0 && (
            <Notice kind="ok">
              {formatCents(totalSaving)} of buying difference across the loaded claims, on products where a cheaper
              source carries the same strength, salt, release profile and dosage form.
            </Notice>
          )}

          <DataTable
            initialSort={{ key: "diff", dir: "desc" }}
            pageSize={25}
            caption={`${opps.rows.length.toLocaleString()} products · sort by any column, filter by name, NDC or supplier`}
            columns={[
              { key: "product", label: "Product" },
              { key: "fills", label: "Fills", align: "right" },
              { key: "paid", label: "We paid / unit", align: "right" },
              { key: "source", label: "Cheapest source" },
              { key: "their", label: "Their price", align: "right" },
              { key: "diff", label: "Difference", align: "right" },
            ]}
            rows={opps.rows.map((r) => ({
              key: r.productKey,
              className: "align-top",
              sort: {
                product: `${r.description} ${r.currentNdc ?? ""}`,
                fills: r.claims,
                paid: r.paidUnitMicros,
                source: r.best ? `${r.best.supplier} ${r.best.ndc11} ${r.best.manufacturer ?? ""}` : null,
                their: r.best?.unitCostMicros ?? null,
                diff: r.savingCents ?? 0,
              },
              cells: {
                product: (
                  <>
                    {r.description}
                    <div className="font-mono text-xs text-ink-3">{r.currentNdc ?? "—"}</div>
                  </>
                ),
                fills: r.claims,
                paid: perUnit(r.paidUnitMicros),
                source: r.best ? (
                  <>
                    <b>{r.best.supplier}</b>
                    <div className="font-mono text-xs text-ink-3">{r.best.ndc11}</div>
                    <div className="text-xs text-ink-3">
                      {r.best.manufacturer ?? "—"}
                      {r.best.contractFlag && ` · ${r.best.contractFlag}`}
                    </div>
                  </>
                ) : (
                  <span className="text-ink-3">no catalogue match</span>
                ),
                their: perUnit(r.best?.unitCostMicros ?? null),
                diff: <span className={(r.savingCents ?? 0) > 0 ? "font-medium text-accent" : "text-ink-3"}>{r.savingCents ? formatCents(r.savingCents) : "—"}</span>,
              },
            }))}
          />
        </>
      )}

      <h2 className="mb-3 mt-8">Elsewhere in Ordering</h2>
      <Hub href="/purchasing" />

      <Card title="How this compares things, and what it will not do" className="mt-8  text-sm">        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">
          <li>
            Only NDCs that match on <b>ingredient, salt, strength, release profile and dosage form</b> are compared.
            Metoprolol succinate is never offered in place of metoprolol tartrate, and an ER tablet is never offered
            in place of an immediate-release one.
          </li>
          <li>
            A product whose description carries no strength — a sensor, a device, a kit — is not matched at all rather
            than matched loosely.
          </li>
          <li>
            The difference is scaled by the quantity actually dispensed, so it is a figure about this pharmacy rather
            than a list-price comparison.
          </li>
          <li>
            <b>The cheapest line is not always the cheapest buy.</b> Purchasing agreements pay rebates on the share of
            volume bought through the primary wholesaler, so moving spend to a secondary can cost more in a lost tier
            than it saves on the invoice. The contract flag is shown where a file carries one; the tier maths is not
            something this can do for you.
          </li>
        </ul>
      </Card>

      <ExportData page="purchasing" className="mt-6" />
    </>
  );
}

/** What each flag means, in the words somebody acting on it would use. */
const MEANS: Record<Flag, string> = {
  buying_above_nadac: "paying over NADAC",
  cheaper_elsewhere: "cheaper elsewhere",
  no_nadac: "no NADAC",
  not_dispensed: "bought, never dispensed",
  short_dated_only: "only short-dated",
  rebate_unknown: "rebate rate not on file",
  pack_size_unknown: "pack size unknown — not compared",
};

