import React from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { importClaims, importRxTransactions, describeTransactionImport, claimFlags, claimsByPayer, claimImports } from "@/lib/claims";
import { looksLikeRxTransactions } from "@/lib/rx-transactions";
import { getSettings } from "@/lib/settings";
import { hasMailPassword } from "@/lib/mailbox";
import { formatCents } from "@/lib/money";
import { requireReimbursement } from "@/lib/features";
import { PageHeader, Notice, Empty } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export const metadata = { title: "Claims" };
export const dynamic = "force-dynamic";

export default async function ClaimsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { laterPaymentSummary } = await import("@/lib/claim-payments");
  const laterMoney = await laterPaymentSummary();
  await requireReimbursement();
  await requireUser();
  const { ok, error } = await searchParams;
  const [flags, byPayer, imports, s, mailReady] = await Promise.all([claimFlags(), claimsByPayer(), claimImports(), getSettings(), hasMailPassword()]);
  const autoImport = (s.mail_auto_import ?? "").toLowerCase() === "yes";
  const mailOn = s.mail_enabled === "yes";
  const lastImport = imports[0] ?? null;
  const lastAgeDays = lastImport ? (Date.now() - Date.parse(lastImport.createdAt)) / 86_400_000 : null;

  async function upload(fd: FormData) {
    "use server";
    const u = await requireManager();
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) redirect("/claims?error=" + encodeURIComponent("Choose a file first."));
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      if (looksLikeRxTransactions(buf.subarray(0, 8192).toString("utf8"))) {
        const t = await importRxTransactions(buf, file.name, u.id);
        // A remittance can beat the daily report. Anything waiting for this prescription attaches now.
        const { matchOrphanPayments } = await import("@/lib/claim-payments");
        const attached = await matchOrphanPayments();
        const text = describeTransactionImport(t) + (attached.matched ? ` ${attached.matched} payment${attached.matched === 1 ? "" : "s"} that arrived before the claim ${attached.matched === 1 ? "was" : "were"} attached.` : "");
        await audit({ action: "claims.import", userId: u.id, userName: u.name, details: `${file.name}: ${text.slice(0, 200)}` });
        revalidatePath("/claims");
        redirect(`/claims?${t.problems.length && !t.claimsAdded ? "error" : "ok"}=` + encodeURIComponent(text));
      }
      const r = await importClaims(buf, file.name, u.id);
      await audit({
        action: "claims.import",
        userId: u.id,
        userName: u.name,
        details: `${file.name}: ${r.claimsAdded} added, ${r.duplicates} already held, ${r.skipped} skipped`,
      });
      revalidatePath("/claims");
      const bits = [`${r.claimsAdded} claim${r.claimsAdded === 1 ? "" : "s"} added`];
      if (r.duplicates) bits.push(`${r.duplicates} already held`);
      if (r.skipped) bits.push(`${r.skipped} skipped (${Object.entries(r.skipReasons).map(([k, v]) => `${v} ${k}`).join(", ")})`);
      if (r.unresolvedBins.length) bits.push(`BINs not on the listing: ${r.unresolvedBins.join(", ")}`);
      if (r.unmappedColumns.length) bits.push(`${r.unmappedColumns.length} column(s) not recognised`);
      redirect("/claims?ok=" + encodeURIComponent(bits.join(". ") + "."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/claims?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not read that file."));
    }
  }

  /**
   * Recovers the patient's residual on claims loaded before it was being kept.
   *
   * The report's "Total" column was read and thrown away, so every claim already held records the
   * patient as having paid nothing — which on a fill applied to a deductible is the whole of the
   * money. The raw row is stored against each claim, so nothing has to be sent again.
   */
  async function repairPatientTotals() {
    "use server";
    const u = await requireManager();
    const { backfillPatientTotals } = await import("@/lib/claim-payments");
    const r = await backfillPatientTotals();
    await audit({ action: "claims.backfill_patient", userId: u.id, userName: u.name, details: `${r.filled} of ${r.read}` });
    revalidatePath("/claims");
    revalidatePath("/purchasing");
    revalidatePath("/payers/performance");
    redirect(
      "/claims?ok=" +
        encodeURIComponent(
          r.filled === 0
            ? "Nothing to recover — every claim already carries what the patient was left owing."
            : `${r.filled} claim${r.filled === 1 ? "" : "s"} now carry what the patient was actually left owing, read back out of the row as it arrived. Every margin on the site follows.`,
        ),
    );
  }

  return (
    <>
      <PageHeader
        title="Claims"
        subtitle="Dispensing and adjudication detail from PioneerRx, matched to the payer that priced it."
        actions={
          <>
            <Link href="/payers/performance" className="btn btn-primary">Who pays best</Link>
            <Link href="/claims/floor" className="btn">Paid under the floor</Link>
            <Link href="/plans" className="btn">Classify plans</Link>
            <form action={repairPatientTotals}>
              <SubmitButton className="btn" pendingLabel="Recovering…">Recover patient payments</SubmitButton>
            </form>
          </>
        }
      />

      {/*
        Money that reached a fill after the day it was transmitted.

        A facilitator payment arrives weeks later and is real revenue. Counted only as what the
        daily report said on the day, a fill sits on the loss list because of a payment that has
        since arrived — and the plan that underpaid is judged on money it never sent.
      */}
      {laterMoney.length > 0 && (
        <Notice kind="ok">
          <b>
            {formatCents(laterMoney.reduce((n, x) => n + x.amountCents, 0))} has reached these claims since they were
            transmitted
          </b>{" "}
          — {laterMoney.map((x) => `${x.payments} from ${x.source.toUpperCase()}`).join(", ")}. It is added to the fill it
          belongs to and kept apart from what the plan itself paid.
          {laterMoney.some((x) => x.unmatched > 0) && (
            <>
              {" "}
              {laterMoney.reduce((n, x) => n + x.unmatched, 0)} of them name a prescription this site has not loaded yet;
              they attach themselves when it arrives.
            </>
          )}
        </Notice>
      )}

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {/*
        The daily feed, and whether the door is open for it.

        PioneerRx emails the "Rx Transaction Details By Submission Type" report at 6:30 every evening
        as "Daily (date)". Everything that has to be true for it to load on its own is listed here
        with its state, and the last file that came is named with what was made of it — so the
        morning after, "did it come in right" is one glance here, and "what went wrong" is the Inbox
        line this points to.
      */}
      <section className="my-4 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Daily claims feed</h2>
        <p className="mt-1 text-xs text-ink-3">
          PioneerRx emails the <b>Rx Transaction Details By Submission Type</b> report at 6:30 each evening, named{" "}
          <span className="font-mono">Daily (date)</span>. The site recognises it by its title line, not its name. A paid
          row becomes a claim and a reversal cancels the claim it names. A paid row with no completed date had not been
          picked up when the report ran; it is kept, because the report is drawn by the day a claim was transmitted and
          that row will not come round again — if the patient never comes, the return to stock arrives as a reversal.
          If it does not load, the <Link href="/inbox" className="text-accent underline">Inbox</Link> line
          says how it came and what to change.
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
        <div className="mt-3 text-xs">
          {lastImport ? (
            <>
              <span className={`badge ${lastAgeDays !== null && lastAgeDays > 2.3 ? "badge-warn" : "badge-ok"}`}>
                {lastAgeDays !== null && lastAgeDays < 1 ? "today" : `${Math.floor(lastAgeDays ?? 0)}d ago`}
              </span>{" "}
              Last file <span className="font-mono">{lastImport.fileName}</span> received {lastImport.createdAt.slice(0, 16).replace("T", " ")}:{" "}
              {lastImport.rowsRead.toLocaleString()} rows read, {lastImport.claimsAdded.toLocaleString()} paid claims added
              {lastImport.duplicates ? `, ${lastImport.duplicates} already held` : ""}
              {lastImport.skipped ? `, ${lastImport.skipped} set aside (${Object.entries(JSON.parse(lastImport.skipReasons || "{}") as Record<string, number>).map(([k, v]) => `${v} ${k}`).join(", ")})` : ""}
              {lastImport.periodFrom ? ` — claims transmitted ${lastImport.periodFrom}` : ""}.
            </>
          ) : (
            <><span className="badge badge-muted">waiting</span> No daily report has arrived yet. The first is due at 6:30 this evening.</>
          )}
        </div>
      </section>

      <section className="my-4 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Load a file by hand</h2>
        <p className="mt-1 text-xs text-ink-3">
          The daily transaction report (.txt) or the Completed Prescriptions export (.xlsx or .csv). Loading the same
          file again is safe — every row is identified, so anything already held is counted rather than added twice.
        </p>
        <form action={upload} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="file" name="file" accept=".xlsx,.csv,.txt" className="text-sm" />
          <button className="rounded-md bg-ink px-3 py-2 text-sm text-white">Load</button>
        </form>
      </section>

      {flags.total === 0 ? (
        <Empty>No claims loaded yet.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Claims held" value={flags.total.toLocaleString()} />
            <Stat
              label="Dispensed at a loss"
              value={String(flags.lossFills.length)}
              tone={flags.lossFills.length ? "warn" : undefined}
              sub={`${formatCents(flags.lossFillsTotalCents)} · per dispensing`}
            />
            <Stat
              label="In-scope under $10.50"
              value={String(flags.underFee.length)}
              tone={flags.underFee.length ? "warn" : undefined}
              sub={`${formatCents(flags.underFeeShortfallCents)} short`}
            />
            <Stat label="Cannot be priced" value={String(flags.unpriceable)} tone={flags.unpriceable ? "warn" : undefined} sub="no quantity" />
          </div>

          {flags.undetermined > 0 && (
            <Notice kind="warn">
              {flags.undetermined} of {flags.total} claims are on plans nobody has classified yet, and{" "}
              {flags.underFeeUndetermined} of those received less than $10.50
              {flags.underFeeUndetermined > 0 && ` — ${formatCents(flags.underFeeUndeterminedShortfallCents)} that may or may not be owed`}.
              A low payment is only a shortfall on a plan the Kansas floor reaches; on a cash discount programme it is
              simply the price. Settle them in <a href="/plans" className="underline">Plans</a>.
            </Notice>
          )}

          {flags.unpriceable > 0 && (
            <Notice kind="warn">
              {flags.unpriceable} of {flags.total} claims carry no dispensed quantity, so they cannot be priced against
              a contract or against NADAC. That column comes through blank on the current PioneerRx export — it is the
              first thing to get fixed.
            </Notice>
          )}

          {flags.ambiguousPayer > 0 && (
            <Notice kind="warn">
              {flags.ambiguousPayer} claim{flags.ambiguousPayer === 1 ? "" : "s"} sit on a BIN that the listing gives to
              more than one PBM, and the payer name did not settle which. Read the PCN or network ID off the claim to
              decide — they are not attached to a guess.
            </Notice>
          )}

          {flags.unlistedBins.length > 0 && (
            <Notice kind="crit">
              {flags.unlistedClaims} claim{flags.unlistedClaims === 1 ? "" : "s"} adjudicated to{" "}
              {flags.unlistedBins.length} BIN{flags.unlistedBins.length === 1 ? "" : "s"} that Health Mart Atlas does
              not publish at all: {flags.unlistedBins.join(", ")}. We hold no contract reference for these payers, so
              nothing they pay can be checked against a rate. Getting these identified is the highest-value thing on
              the contract review.
            </Notice>
          )}

          <h2 className="mt-8 text-sm font-semibold">By payer</h2>
          <p className="mb-2 text-xs text-ink-3">Open a payer to see its contracted rates and appeal route next to its claims.</p>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
                <tr>
                  <th className="px-3 py-2">Payer</th>
                  <th className="px-3 py-2 text-right">Claims</th>
                  <th className="px-3 py-2 text-right">Received</th>
                  <th className="px-3 py-2 text-right">Gross profit</th>
                  <th className="px-3 py-2 text-right">At a loss</th>
                  <th className="px-3 py-2">Networks</th>
                </tr>
              </thead>
              <tbody>
                {byPayer.map((p) => (
                  <tr key={p.pbmName} className="border-t border-line align-top">
                    <td className="px-3 py-2">
                      {p.pbmName.includes("unmatched") || p.pbmName === "Unidentified payer" ? (
                        <span>{p.pbmName}</span>
                      ) : (
                        <Link href={`/payers/${encodeURIComponent(p.pbmName)}`} className="font-medium underline">{p.pbmName}</Link>
                      )}
                      <div className="text-xs text-ink-3">{p.bins.join(", ") || "—"}</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.claims}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCents(p.receivedCents)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${p.profitCents < 0 ? "text-red-700" : ""}`}>{formatCents(p.profitCents)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.belowCost || <span className="text-ink-3">—</span>}</td>
                    <td className="px-3 py-2 text-xs text-ink-3">{p.networks.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="mt-8 text-sm font-semibold">Dispensed at a loss</h2>
          {/*
            Per dispensing, not per transmission.

            A prescription billed to a primary plan and then a secondary is one bottle and two
            rows, and both rows carry the same acquisition cost. Counted as two claims the cost is
            counted twice, and the primary row alone — a plan paying eight dollars towards a
            six-hundred-dollar pen — reads as a catastrophic loss when the secondary paid the rest.
          */}
          <p className="mt-1 text-xs text-ink-2">
            One row per dispensing. Where a fill went to a primary and then a secondary plan, both
            plans&rsquo; payments are added and the bottle is counted once — the two rows are one bottle, and reading
            them as two claims doubles the cost and turns a paid fill into an invented loss.
            {flags.coordination.coordinatedFills > 0 && (
              <>
                {" "}
                <b>
                  {flags.coordination.coordinatedFills} fill{flags.coordination.coordinatedFills === 1 ? "" : "s"} here went to
                  more than one plan
                </b>
                {flags.coordination.falseLosses > 0 && (
                  <>
                    , and {flags.coordination.falseLosses} of them would have shown{" "}
                    {formatCents(flags.coordination.falseLossCents)} of losses that were never real
                  </>
                )}
                .
              </>
            )}{" "}
            A reversal matching no claim held is left out entirely: it reverses a dispensing from before this feed
            began, whose revenue was never counted here.
          </p>
          {flags.lossFills.length === 0 ? (
            <Empty>None — every dispensing brought in at least what the drug cost.</Empty>
          ) : (
            <div className="mt-2 overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-sm">
                <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
                  <tr>
                    <th className="px-3 py-2">Filled</th>
                    <th className="px-3 py-2">Drug</th>
                    <th className="px-3 py-2">Paid by</th>
                    <th className="px-3 py-2 text-right">Came in</th>
                    <th className="px-3 py-2 text-right">Cost</th>
                    <th className="px-3 py-2 text-right">Loss</th>
                  </tr>
                </thead>
                <tbody>
                  {flags.lossFills.slice(0, 50).map((f) => (
                    <React.Fragment key={f.key}>
                    <tr className="border-t border-line">
                      <td className="px-3 py-2 whitespace-nowrap text-xs">{f.dateFilled}</td>
                      <td className="px-3 py-2">
                        {f.itemName ?? f.ndc11 ?? "—"}
                        <span className="block font-mono text-[11px] text-ink-3">Rx {f.rxNumber}{f.fillNumber !== null ? `-${f.fillNumber}` : ""}</span>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {f.payers.map((p) => p.name ?? p.bin ?? "—").join(" then ")}
                        {f.coordinated && <span className="badge badge-muted ml-1">two plans</span>}
                        {f.patientShareUncertain && (
                          <span className="badge badge-warn ml-1" title="The plans disagree about what the patient owed and the report does not say which came last. The smaller figure is used.">
                            patient share unclear
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCents(f.revenueCents)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCents(f.acquisitionCents ?? 0)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-red-700">{formatCents(f.marginCents ?? 0)}</td>
                    </tr>
                    {/*
                      What actually arrived, field by field.

                      Column positions in this report are worked out by counting, and a report whose
                      columns move by one produces figures that are individually plausible and
                      collectively wrong — a dispensing fee read as a patient total, a tax read as a
                      quantity. Arguing about a loss from a screen showing only conclusions is
                      guesswork on both sides. This is the evidence.
                    */}
                    <tr>
                      <td colSpan={6} className="px-3 pb-2">
                        <details>
                          <summary className="cursor-pointer text-[11px] text-ink-3 hover:text-accent">
                            Why is this a loss? Show the row exactly as it arrived
                          </summary>
                          <div className="mt-1 space-y-2">
                            {(flags.rawByFill.get(f.key) ?? []).map((c, i) => (
                              <div key={i} className="rounded-md border border-line bg-ground p-2">
                                <p className="text-[11px] font-semibold">{c.payer ?? "unnamed payer"}</p>
                                <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 sm:grid-cols-4">
                                  {c.fields.map((x) => (
                                    <div key={x.name} className="flex justify-between gap-2 text-[11px]">
                                      <dt className="text-ink-3">{x.name}</dt>
                                      <dd className="font-mono">{x.value || "—"}</dd>
                                    </div>
                                  ))}
                                </dl>
                              </div>
                            ))}
                            {(flags.rawByFill.get(f.key) ?? []).length === 0 && (
                              <p className="text-[11px] text-ink-3">
                                This claim came from an older load that did not keep the original row, so there is
                                nothing to show. Load that day&rsquo;s report again and it will be here.
                              </p>
                            )}
                            <p className="text-[11px] text-ink-2">
                              What this site made of it: {formatCents(f.remitCents)} from the plans, {formatCents(f.patientPaidCents)}{" "}
                              from the patient{f.laterPaymentsCents ? `, ${formatCents(f.laterPaymentsCents)} arrived later` : ""}, against{" "}
                              {formatCents(f.acquisitionCents ?? 0)} of drug. If a figure above is not where this site
                              thinks it is, that is the bug — send me this box.
                            </p>
                          </div>
                        </details>
                      </td>
                    </tr>
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {imports.length > 0 && (
            <>
              <h2 className="mt-8 text-sm font-semibold">Loads</h2>
              <ul className="divide-y divide-line rounded-lg border border-line bg-surface text-sm">
                {imports.map((i) => (
                  <li key={i.id} className="px-3 py-2">
                    <div className="font-medium">{i.fileName}</div>
                    <div className="text-xs text-ink-3">
                      {i.claimsAdded} added
                      {i.duplicates ? `, ${i.duplicates} already held` : ""}
                      {i.skipped ? `, ${i.skipped} skipped` : ""}
                      {i.periodFrom ? ` · ${i.periodFrom} to ${i.periodTo}` : ""}
                      {" · "}{new Date(i.createdAt).toLocaleString()}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" }) {
  return (
    <div className={`rounded-lg border p-3 ${tone === "warn" ? "border-amber-300 bg-amber-50" : "border-line bg-surface"}`}>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-ink-3">{label}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-3">{sub}</div>}
    </div>
  );
}
