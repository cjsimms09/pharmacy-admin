import type React from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { importSupplierCatalog, importPioneerCatalog, purchasingOpportunities, supplierSummary, catalogSchedule } from "@/lib/suppliers";
import { getSettings } from "@/lib/settings";
import { hasMailPassword } from "@/lib/mailbox";
import { FILE_NAME_CODES } from "@/lib/pioneer-catalog";
import Link from "next/link";
import { looksLikePioneerCatalog } from "@/lib/pioneer-catalog";
import { formatCents } from "@/lib/money";
import { requireReimbursement } from "@/lib/features";
import { PageHeader, Notice, Empty, Field } from "@/components/ui";

export const metadata = { title: "Purchasing" };
export const dynamic = "force-dynamic";

/** Micros to a displayable per-unit price, at the five decimals these prices are quoted in. */
const perUnit = (micros: number | null) => (micros === null ? "—" : `$${(micros / 1_000_000).toFixed(5)}`);

export default async function PurchasingPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireReimbursement();
  await requireUser();
  const { ok, error } = await searchParams;
  const [opps, summary, schedule, s, mailReady] = await Promise.all([purchasingOpportunities(), supplierSummary(), catalogSchedule(), getSettings(), hasMailPassword()]);
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

  return (
    <>
      <PageHeader
        title="Purchasing"
        subtitle="What we dispense, what we paid for it, and whether a cheaper source exists for the same product."
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <section className="my-4 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Load a supplier price file</h2>
        <p className="mt-1 text-xs text-ink-3">
          An order guide or price list from any wholesaler, as .xlsx or .csv. Column names differ between suppliers
          and are matched loosely — anything not recognised is reported back rather than ignored. Loading a file again
          replaces that supplier&rsquo;s prices for the NDCs it covers and leaves every other supplier alone.
        </p>
        <form action={upload} className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Supplier">
            <input name="supplier" placeholder="McKesson" className="w-48 rounded-md border border-line px-3 py-2 text-sm" />
          </Field>
          <input type="file" name="file" accept=".xlsx,.csv,.txt" className="text-sm" />
          <button className="rounded-md bg-ink px-3 py-2 text-sm text-white">Load</button>
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
      </section>

      {/*
        The Sunday files, and whether the door is open for them.

        Four scheduled PioneerRx exports, one per supplier, named Supplier + run date, emailed to
        the site's mailbox. Everything that has to be true for them to load on their own is listed
        here with its state, and each supplier has a row saying when its file last came — so on the
        Monday after the first Sunday, "did it work" is answered by one glance at this panel, and
        "what went wrong" by the Inbox line it points to.
      */}
      <section className="my-4 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Scheduled catalogues</h2>
        <p className="mt-1 text-xs text-ink-3">
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
      </section>

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

          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
                <tr>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2 text-right">Fills</th>
                  <th className="px-3 py-2 text-right">We paid / unit</th>
                  <th className="px-3 py-2">Cheapest source</th>
                  <th className="px-3 py-2 text-right">Their price</th>
                  <th className="px-3 py-2 text-right">Difference</th>
                </tr>
              </thead>
              <tbody>
                {opps.rows.map((r) => (
                  <tr key={r.productKey} className="border-t border-line align-top">
                    <td className="px-3 py-2">
                      {r.description}
                      <div className="font-mono text-xs text-ink-3">{r.currentNdc ?? "—"}</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.claims}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{perUnit(r.paidUnitMicros)}</td>
                    <td className="px-3 py-2">
                      {r.best ? (
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
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{perUnit(r.best?.unitCostMicros ?? null)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${(r.savingCents ?? 0) > 0 ? "font-medium text-emerald-700" : "text-ink-3"}`}>
                      {r.savingCents ? formatCents(r.savingCents) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <section className="mt-8 rounded-lg border border-line bg-surface p-4 text-sm">
        <h2 className="text-sm font-semibold">How this compares things, and what it will not do</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">
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
      </section>
    </>
  );
}
