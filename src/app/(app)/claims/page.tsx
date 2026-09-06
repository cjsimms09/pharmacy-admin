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

  /*
   * Every dispensing against NADAC plus the dispensing fee.
   *
   * The floor review answers the narrow question — which claims can be filed on — and stays silent
   * about every plan the statute cannot reach, which is most of the money. A Part D plan paying
   * below what the government reckons the drug costs is not a filing, but it is the thing a
   * contract conversation is made of.
   */
  const { againstNadac, STANDING_MEANS } = await import("@/lib/against-nadac");
  const nadacStanding = await againstNadac(flags.fills);
  /*
   * Three lists, because they need three different things done to them.
   *
   * Measuring every dispensing against the benchmark is right; printing every dispensing is not.
   * A row that came in above NADAC needs nothing, and a row on an unclassified plan cannot be
   * judged at all until somebody says what kind of plan it is — so neither belongs in the list of
   * work. What is left is the money: a shortfall the Kansas floor lets us file, and a rate that is
   * bad but lawful and has to be argued commercially.
   */
  const short = nadacStanding.rows.filter((r) => r.againstBenchmarkCents < 0);
  const actionable = short.filter((r) => r.standing === "owed" || r.standing === "argue");
  const unsettled = short.filter((r) => r.standing === "unclassified");
  const settled = nadacStanding.rows.filter((r) => r.againstBenchmarkCents >= 0 || r.standing === "the price");

  /* One table, rendered against whichever of those lists is being shown. */
  function NadacTable({ rows }: { rows: typeof nadacStanding.rows }) {
    return (
      <div className="mt-2 overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
            <tr>
              <th className="px-3 py-2">Filled</th>
              <th className="px-3 py-2">Drug</th>
              <th className="px-3 py-2">Payer</th>
              <th className="px-3 py-2 text-right">Came in</th>
              <th className="px-3 py-2 text-right">NADAC + fee</th>
              <th className="px-3 py-2 text-right">Against it</th>
              <th className="px-3 py-2">What it means</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 60).map((r) => (
              <tr key={r.key} className="border-t border-line">
                <td className="px-3 py-2 whitespace-nowrap text-xs">{r.dateFilled}</td>
                <td className="px-3 py-2">
                  {r.itemName ?? r.ndc11}
                  <span className="block font-mono text-[11px] text-ink-3">
                    Rx {r.rxNumber}{r.fillNumber !== null ? `-${r.fillNumber}` : ""} · NADAC of {r.nadacOn}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs">{r.payer}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatCents(r.receivedCents)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-2">
                  {formatCents(r.benchmarkCents)}
                  <span className="block text-[11px] text-ink-3">
                    {formatCents(r.nadacCents)} + {formatCents(r.dispensingFeeCents)}
                  </span>
                </td>
                <td className={`px-3 py-2 text-right tabular-nums font-medium ${r.againstBenchmarkCents < 0 ? "text-red-700" : "text-accent"}`}>
                  {r.againstBenchmarkCents > 0 ? "+" : ""}{formatCents(r.againstBenchmarkCents)}
                </td>
                <td className="px-3 py-2 text-xs">
                  {r.againstBenchmarkCents >= 0 ? (
                    <span className="text-ink-3">at or above it</span>
                  ) : (
                    <span
                      className={`badge ${r.standing === "owed" ? "badge-crit" : r.standing === "argue" ? "badge-warn" : "badge-muted"}`}
                      title={STANDING_MEANS[r.standing]}
                    >
                      {r.standing === "owed"
                        ? "owed — file it"
                        : r.standing === "argue"
                          ? "argue it, cannot file"
                          : r.standing === "the price"
                            ? "the price, not a shortfall"
                            : "classify the plan first"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 60 && (
          <p className="border-t border-line px-3 py-2 text-xs text-ink-3">
            The worst 60 of {rows.length} are shown.
          </p>
        )}
      </div>
    );
  }

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

      {/*
        Money a plan has already promised and not yet sent.

        This is not inferred from a gap — the report now carries the figure in its own column,
        because the plan's adjudication response says what the manufacturer share will be. Until the
        facilitator pays it the fill reads as a loss for the whole amount, and the loss list gives
        no way to tell a rate worth arguing about from a bill nobody has paid yet.
      */}
      {flags.awaitingFacilitator.length > 0 && (
        <Notice kind="warn">
          <b>{formatCents(flags.awaitingFacilitatorCents)} is promised on these claims and has not been paid.</b>{" "}
          {flags.awaitingFacilitator.length} fill{flags.awaitingFacilitator.length === 1 ? "" : "s"} where the plan named
          a facilitator payment at adjudication — biggest is Rx {flags.awaitingFacilitator[0].rxNumber}
          {flags.awaitingFacilitator[0].fillNumber !== null ? `-${flags.awaitingFacilitator[0].fillNumber}` : ""}
          {flags.awaitingFacilitator[0].itemName ? ` (${flags.awaitingFacilitator[0].itemName})` : ""} at{" "}
          {formatCents(flags.awaitingFacilitator[0].facilitatorOutstandingCents ?? 0)}. Every one of them shows as a loss
          below until the money lands, and none of them is a rate to argue about. They post themselves against the fill
          when <Link href="/remits/mtf" className="underline">the facilitator feed</Link> brings the payment in.
        </Notice>
      )}

      {/*
        Revenue the report booked that this site did not find in the row.

        PioneerRx computes its gross profit from the same row we read, so a gap means it counted
        money we did not — and the amount is the only part of that this site actually knows. On one
        Jardiance fill the gap was $146.18 of facilitator money the plan promised at adjudication.
        On a Losartan fill it was $5.56, which no facilitator was ever going to pay and is far more
        likely to be a patient total sitting in a column this reader is not picking up.

        So the gap is stated and the cause is not. Calling every one of them a facilitator payment
        built a queue of receivables that were never coming, which is the same mistake as the red
        "the arithmetic is broken" banner it replaced, made in the opposite direction.
      */}
      {/*
        The standing tripwire, said in one line whether it is good news or bad.

        Every arithmetic error this site has had was found by the pharmacist reading a printout and
        knowing the real answer. That is the wrong way round. This states the identity the report
        itself guarantees and reports whether it holds — so a mistake announces itself here on the
        day it happens, instead of being discovered in a PDF a fortnight later.
      */}
      <Notice kind={flags.balance.balances ? "ok" : "crit"}>
        {flags.balance.balances ? (
          <>
            <b>The books balance.</b> This site makes these dispensings{" "}
            {formatCents(flags.balance.ourMarginCents)}, and PioneerRx&rsquo;s own gross profit over the same rows comes
            to {formatCents(flags.balance.reportMarginCents)}
            {flags.balance.laterCents !== 0 ? ` once the ${formatCents(flags.balance.laterCents)} that arrived after the day is taken out` : ""}
            . Two answers worked out independently, agreeing to the cent.
            {flags.balance.unchecked > 0 && ` ${flags.balance.unchecked} fills carried nothing to check against.`}
          </>
        ) : (
          <>
            <b>
              The books do not balance: {formatCents(Math.abs(flags.balance.differenceCents))}{" "}
              {flags.balance.differenceCents > 0 ? "more" : "less"} than the report, across{" "}
              {flags.balance.fillsOff} fill{flags.balance.fillsOff === 1 ? "" : "s"}.
            </b>{" "}
            This site makes them {formatCents(flags.balance.ourMarginCents)} and PioneerRx makes them{" "}
            {formatCents(flags.balance.reportMarginCents)}. Both are computed from the same rows, so a column is not
            where this reader thinks it is — and every figure on this page drawn from those rows is wrong the same way.
            {flags.unreconciled.length > 0 && (
              <>
                {" "}
                Worst is Rx {flags.unreconciled[0].rxNumber}
                {flags.unreconciled[0].fillNumber !== null ? `-${flags.unreconciled[0].fillNumber}` : ""}
                {flags.unreconciled[0].itemName ? ` (${flags.unreconciled[0].itemName})` : ""}, out by{" "}
                {formatCents(Math.abs(flags.unreconciled[0].unreconciledCents ?? 0))}. Open <b>Why is this a loss?</b> on
                it below and send me the box.
              </>
            )}
          </>
        )}
      </Notice>

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {flags.total === 0 ? (
        <Empty>No claims loaded yet.</Empty>
      ) : (
        <>
          {/*
            What the pharmacy made, first, and then what it is still owed.

            The four figures here used to be "claims held" and three kinds of problem, which is a
            screen that can only ever deliver bad news. The reason any of this is counted is to find
            money, so the money leads: what these dispensings made, what has been counted but not
            received, what can be filed, and what actually lost.
          */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="What these fills made"
              value={formatCents(flags.marginCents)}
              tone={flags.marginCents < 0 ? "warn" : undefined}
              sub={`${formatCents(flags.revenueCents)} taken in on ${flags.pricedFills.toLocaleString()} of ${flags.fills.length.toLocaleString()} dispensings`}
            />
            <Stat
              label="Counted, not found in the row"
              value={formatCents(flags.unreconciledCents)}
              tone={flags.unreconciledCents ? "warn" : undefined}
              sub={flags.unreconciled.length ? `${flags.unreconciled.length} fills the report values higher than we can` : "the report and this site agree"}
            />
            <Stat
              label="Promised, not yet paid"
              value={formatCents(flags.awaitingFacilitatorCents)}
              tone={flags.awaitingFacilitatorCents ? "warn" : undefined}
              sub={
                flags.awaitingFacilitator.length
                  ? `${flags.awaitingFacilitator.length} fills awaiting the facilitator`
                  : flags.underFee.length
                    ? `${formatCents(flags.underFeeShortfallCents)} under $10.50 on ${flags.underFee.length} in-scope claims`
                    : "nothing outstanding"
              }
            />
            <Stat
              label="Dispensed at a loss"
              value={formatCents(flags.lossFillsTotalCents)}
              tone={flags.lossFills.length ? "warn" : undefined}
              sub={`${flags.lossFills.length} dispensings, after every payer is counted`}
            />
          </div>
          <p className="mt-1 text-xs text-ink-3">
            {flags.total.toLocaleString()} claim rows became {flags.fills.length.toLocaleString()} dispensings — a
            prescription billed to a plan and then to a card is one bottle, and counting it twice doubles its cost and
            invents a loss.
            {flags.unpriceable > 0 && ` ${flags.unpriceable} carry no dispensed quantity and cannot be priced at all.`}
          </p>

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
          <p className="mb-2 text-xs text-ink-3">
            Per dispensing, on the same arithmetic as everything else on this page — one bottle counted once, the
            patient counted once. A fill two plans coordinated on cannot be split between them honestly, so it is held
            out of the profit column and shown on its own, with each plan credited only with the money it sent.{" "}
            Open a payer to see its contracted rates and appeal route next to its claims.
          </p>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
                <tr>
                  <th className="px-3 py-2">Payer</th>
                  <th className="px-3 py-2 text-right">Fills</th>
                  <th className="px-3 py-2 text-right">Received</th>
                  <th className="px-3 py-2 text-right">Gross profit</th>
                  <th className="px-3 py-2 text-right">At a loss</th>
                  <th className="px-3 py-2 text-right">Shared</th>
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
                    <td className="px-3 py-2 text-right tabular-nums">{p.fills || <span className="text-ink-3">—</span>}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.fills ? formatCents(p.receivedCents) : <span className="text-ink-3">—</span>}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${p.profitCents < 0 ? "text-red-700" : ""}`}>
                      {p.fills ? formatCents(p.profitCents) : <span className="text-ink-3">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.belowCost || <span className="text-ink-3">—</span>}</td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums text-ink-3">
                      {p.coordinatedFills ? (
                        <span title="Fills this plan priced alongside another. One bottle cannot be split between two plans honestly, so only the money this plan sent is shown.">
                          {p.coordinatedFills} · {formatCents(p.coordinatedRemitCents)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-ink-3">{p.networks.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── Against the benchmark ─────────────────────────────────── */}
          <h2 className="mt-8 text-sm font-semibold">Against NADAC + the dispensing fee</h2>
          <p className="mt-1 text-xs text-ink-2">
            Every dispensing measured against what the federal benchmark says the drug cost, plus the greater of $10.50
            and the Kansas Medicaid dispensing fee. What is <b>true</b> of a claim and what can be <b>done</b> about it
            are different things, so they are said separately: a plan the Kansas floor reaches that paid under this is
            money owed; a plan it cannot reach is a rate to argue commercially; a discount card is simply the price.
            NADAC is taken at the price in force on the fill date, never today&rsquo;s — pricing a July claim against
            this week&rsquo;s file gives a plausible figure that is not what applied.
          </p>

          {nadacStanding.rows.length === 0 ? (
            <Empty>
              Nothing can be compared yet.
              {nadacStanding.notCompared.length > 0 && (
                <> {nadacStanding.notCompared.map((x) => `${x.fills} ${x.reason}`).join("; ")}.</>
              )}{" "}
              This needs NADAC loaded for the dates these claims were filled.
            </Empty>
          ) : (
            <>
              <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Compared" value={String(nadacStanding.rows.length)} sub="dispensings with a NADAC for that date" />
                <Stat
                  label="Owed — the floor reaches them"
                  value={formatCents(nadacStanding.owedCents)}
                  tone={nadacStanding.owedCents ? "warn" : undefined}
                  sub="A shortfall to claim"
                />
                <Stat
                  label="Under, but out of reach"
                  value={formatCents(nadacStanding.argueCents)}
                  sub="Not a claim — a rate to argue"
                />
                <Stat label="At or above the benchmark" value={String(nadacStanding.atOrAbove)} sub="Paid what the drug cost, and the fee" />
              </div>

              {/*
                Only the rows somebody can do something about.

                Every dispensing is measured, but printing all of them put fifty-nine rows and seven
                pages of red numbers on this screen whose every actionable total was $0.00 — and a
                list that long, that alarming and that inert is worse than no list, because it
                teaches the reader to scroll past the section that holds the money. What is settled
                stays one keystroke away below; what needs a decision is here.
              */}
              {actionable.length > 0 ? (
                <NadacTable rows={actionable} />
              ) : (
                <p className="mt-2 rounded-lg border border-line bg-surface p-3 text-xs text-ink-2">
                  Nothing here is a shortfall to file or a rate to argue{unsettled.length > 0 ? " yet" : ""}. Every
                  dispensing with a classified plan came in at or above NADAC plus the fee, or is a discount programme
                  where the low number is simply the price.
                </p>
              )}

              {unsettled.length > 0 && (
                <div className="mt-3 rounded-lg border border-warn/40 bg-warn/5 p-3 text-xs">
                  <b>
                    {unsettled.length} dispensing{unsettled.length === 1 ? "" : "s"} came in under NADAC + the fee on a
                    plan nobody has classified — {formatCents(unsettled.reduce((n, r) => n + r.againstBenchmarkCents, 0))}{" "}
                    between them.
                  </b>{" "}
                  Whether that is money owed or simply the price depends entirely on what kind of plan it is: the Kansas
                  floor reaches a commercial or governmental plan and does not reach a discount card. Nothing can be
                  claimed until they are told apart.{" "}
                  <Link href="/plans" className="font-medium underline">Classify these plans</Link> and every one of
                  these rows answers itself.
                  <details className="mt-2">
                    <summary className="cursor-pointer text-ink-3">Show the {unsettled.length} dispensings</summary>
                    <div className="mt-2"><NadacTable rows={unsettled} /></div>
                  </details>
                </div>
              )}

              {settled.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-ink-3">
                    {settled.length} dispensing{settled.length === 1 ? "" : "s"} that need nothing — paid at or above the
                    benchmark, or a discount programme where the low number is the price
                  </summary>
                  <div className="mt-2"><NadacTable rows={settled} /></div>
                </details>
              )}

              {nadacStanding.notCompared.length > 0 && (
                <p className="mt-1 text-xs text-ink-3">
                  Not compared: {nadacStanding.notCompared.map((x) => `${x.fills} with ${x.reason}`).join(", ")}. Named
                  rather than dropped — a shorter list reads as good news.
                </p>
              )}
            </>
          )}

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
          {/*
            The part of the red number that is not a loss at all.

            Somebody reading a four-thousand-dollar loss needs to know before anything else how much
            of it is money already promised. Chasing a plan over a fill that is merely unpaid is the
            most expensive way there is to spend an afternoon.
          */}
          {flags.awaitingFacilitator.length > 0 && (
            <p className="mt-2 rounded-lg border border-warn/40 bg-warn/5 p-3 text-xs">
              <b>
                {flags.awaitingFacilitator.filter((f) => (f.marginCents ?? 0) < 0).length} of these are waiting on a
                facilitator payment the plan already promised — {formatCents(flags.awaitingFacilitatorCents)} between
                them.
              </b>{" "}
              They are marked <span className="badge badge-warn">MTF promised</span> below, with what each becomes once
              it is paid. Nothing about them is a rate to argue over, and nothing needs doing to them: the payment posts
              itself against the fill when it arrives.
            </p>
          )}
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
                          <span className="badge badge-warn ml-1" title="These rows remit more between them than any of them said the drug cost, so they cannot be one chain. The patient's share is floored at nothing rather than invented.">
                            patient share unclear
                          </span>
                        )}
                        {/*
                          A loss the report does not agree is a loss is worth saying before somebody
                          goes and argues with the plan about it.
                        */}
                        {/*
                          The plan's own promise, from the report's column rather than from a gap.
                          A fill that is merely unpaid must not read like a rate worth arguing over.
                        */}
                        {(f.facilitatorOutstandingCents ?? 0) > 0 && (
                          <span
                            className="badge badge-warn ml-1"
                            title="The plan named this facilitator payment when it adjudicated the claim. It has not arrived yet, and it posts itself against this fill when it does."
                          >
                            MTF promised {formatCents(f.facilitatorOutstandingCents ?? 0)}
                          </span>
                        )}
                        {/*
                          A programme that tops the claim up later. The amount is not knowable from
                          the claim — only the memo says it — but the fact that money is coming is,
                          and that is the whole difference between a bad rate and an unpaid bill.
                        */}
                        {f.topOffExpected && (
                          <span
                            className="badge badge-warn ml-1"
                            title="This plan pays part of the claim later, on a credit memo. Nothing has been credited against this fill yet. The amount is not on the claim — it arrives with the memo."
                          >
                            top-off expected
                          </span>
                        )}
                        {f.unreconciledCents !== null && (
                          <span
                            className="badge badge-warn ml-1"
                            title="The report booked this much revenue on this fill that the site did not find in the row. Open the row below to see which column it is in."
                          >
                            {formatCents(f.unreconciledCents)} unaccounted
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCents(f.revenueCents)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCents(f.acquisitionCents ?? 0)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-red-700">
                        {formatCents(f.marginCents ?? 0)}
                        {(f.facilitatorOutstandingCents ?? 0) > 0 && (
                          <span className="block text-[11px] font-normal text-ink-3">
                            {formatCents((f.marginCents ?? 0) + (f.facilitatorOutstandingCents ?? 0))} once the
                            facilitator pays
                          </span>
                        )}
                        {f.unreconciledCents !== null && (
                          <span className="block text-[11px] font-normal text-ink-3">
                            the report says {formatCents((f.marginCents ?? 0) + f.unreconciledCents)}
                          </span>
                        )}
                      </td>
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
                            {/*
                              What the gap is, without pretending to know what caused it.

                              The two candidates want opposite responses — a missing column is fixed
                              here, a promised payment is waited for — and the fill cannot tell them
                              apart. The row above can, which is why it is printed.
                            */}
                            {f.unreconciledCents !== null && (
                              <p className="rounded-md border border-warn/50 bg-warn/10 p-2 text-[11px] text-ink-2">
                                The report says this fill made {formatCents(f.reportedMarginCents ?? 0)} and this site
                                makes it {formatCents(f.marginCents ?? 0)}. PioneerRx computes its figure from the row
                                above, so <b>{formatCents(f.unreconciledCents)} of revenue is on that row and this site
                                did not pick it up</b>. Two things it can be: a patient total in a column this reader is
                                not reading — the usual cause on a small generic, and fixable here — or money the plan
                                promised at adjudication and pays weeks later through{" "}
                                <Link href="/remits/mtf" className="underline">the facilitator</Link>, which is the
                                usual cause on a Part D brand. Compare the figures above against what this site made of
                                them, below, and send me this box: the column it is hiding in will be one of them.
                              </p>
                            )}
                            {f.agreesWithReport === false && (
                              <p className="rounded-md border border-crit bg-crit-soft p-2 text-[11px] text-crit">
                                This site makes this fill {formatCents(f.marginCents ?? 0)} and the report only{" "}
                                {formatCents(f.reportedMarginCents ?? 0)}. We cannot be holding money the report never
                                counted, so one of the columns above is not what this reader thinks it is — that is the
                                bug, not the claim.
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
      {/*
        Where these claims come from, and how to feed it by hand.

        It belongs on this page — the morning after, "did last night's file come in" is one glance
        here. It does not belong above the money. Anyone opening this screen is asking what the
        pharmacy made and what it is owed, and four paragraphs of plumbing before the first figure
        is how a working screen turns into a wall.
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
