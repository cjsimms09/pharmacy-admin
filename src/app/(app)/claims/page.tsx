import React from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { importClaims, describeTransactionImport, claimFlags, claimsByPayer, claimImports } from "@/lib/claims";
import { claimsImportJob, claimsImportRunning } from "@/lib/claims-import-job";
import { looksLikeRxTransactions } from "@/lib/rx-transactions";
import { getSettings } from "@/lib/settings";
import { hasMailPassword } from "@/lib/mailbox";
import { formatCents } from "@/lib/money";
import { requireReimbursement } from "@/lib/features";
import { PageHeader, Notice, Empty, Figure } from "@/components/ui";
import { ExportData } from "@/components/export-data";
import { SubmitButton } from "@/components/submit-button";

export const metadata = { title: "Claims" };
export const dynamic = "force-dynamic";

export default async function ClaimsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; from?: string; to?: string; rx?: string; payer?: string }>;
}) {
  await requireReimbursement();
  await requireUser();
  const { ok, error, from, to, rx, payer } = await searchParams;
  // A large file importing in its own process, so the page can say so rather than go quiet.
  const importJob = await claimsImportJob();

  /*
   * One day, unless somebody asks for more.
   *
   * This screen used to answer for every claim ever loaded, on every render, to show one day's work
   * — grouping every dispensing, pricing each against the whole federal NADAC table, and parsing the
   * stored text of every row. It got slower every week by construction, because the work grew with
   * the archive rather than with the question being asked.
   *
   * A fill never spans two dates, so a day is a safe unit: narrowing by it splits no dispensing.
   */
  const scope = { from: from ?? null, to: to ?? null, rx: rx ?? null, payer: payer ?? null };
  const searching = Boolean(from || to || rx || payer);

  const { laterPaymentSummary } = await import("@/lib/claim-payments");
  const [flags, laterMoney, imports, s, mailReady] = await Promise.all([
    claimFlags(scope),
    laterPaymentSummary(),
    claimImports(),
    getSettings(),
    hasMailPassword(),
  ]);
  /*
   * The fills that sentence below is about, counted and totalled from the same list.
   *
   * The count was filtered to the fills showing a loss and the money was not — it was every awaiting
   * fill's outstanding, profitable ones included. Two halves of one sentence describing two
   * different populations. On the single day the page shows, both awaiting fills happen to be losses,
   * so the two figures agree by luck and the fault is invisible; across September it is nine fills
   * quoted with a ten-fill total.
   */
  const promisedLosses = flags.awaitingFacilitator.filter((f) => (f.marginCents ?? 0) < 0);
  const promisedLossCents = promisedLosses.reduce((n, f) => n + (f.facilitatorOutstandingCents ?? 0), 0);

  /* From the fills already grouped, rather than reading every claim and grouping them a second time. */
  const byPayer = await claimsByPayer({ fills: flags.fills, networks: flags.networks });

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
      <div className="mt-2 overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Filled</th>
              <th>Drug</th>
              <th>Payer</th>
              <th className="text-right">Came in</th>
              <th className="text-right">NADAC + fee</th>
              <th className="text-right">Against it</th>
              <th>What it means</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 60).map((r) => (
              <tr key={r.key}>
                <td className="whitespace-nowrap text-xs">{r.dateFilled}</td>
                <td>
                  {r.itemName ?? r.ndc11}
                  <span className="block font-mono text-[11px] text-ink-3">
                    Rx {r.rxNumber}{r.fillNumber !== null ? `-${r.fillNumber}` : ""} · NADAC of {r.nadacOn}
                  </span>
                </td>
                <td className="text-xs">{r.payer}</td>
                <td className="text-right tabular-nums">{formatCents(r.receivedCents)}</td>
                <td className="text-right tabular-nums text-ink-2">
                  {formatCents(r.benchmarkCents)}
                  <span className="block text-[11px] text-ink-3">
                    {formatCents(r.nadacCents)} + {formatCents(r.dispensingFeeCents)}
                  </span>
                </td>
                <td className={`px-3 py-2 text-right tabular-nums font-medium ${r.againstBenchmarkCents < 0 ? "text-red-700" : "text-accent"}`}>
                  {r.againstBenchmarkCents > 0 ? "+" : ""}{formatCents(r.againstBenchmarkCents)}
                </td>
                <td className="text-xs">
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
        // A remittance can beat the daily report. Anything waiting for this prescription attaches now.
        const { matchOrphanPayments } = await import("@/lib/claim-payments");
        let attachedNote = "";
        const attach = async () => {
          const attached = await matchOrphanPayments();
          attachedNote = attached.matched ? ` ${attached.matched} payment${attached.matched === 1 ? "" : "s"} that arrived before the claim ${attached.matched === 1 ? "was" : "were"} attached.` : "";
        };
        // The twelve-month history imports in a process of its own; the daily file inline.
        const { importClaimsFile } = await import("@/lib/claims-import-job");
        const outcome = await importClaimsFile({ buf, fileName: file.name, user: { id: u.id, name: u.name }, after: attach });
        if (outcome.apart) {
          revalidatePath("/claims");
          redirect(`/claims?${outcome.started ? "ok" : "error"}=` + encodeURIComponent(outcome.message));
        }
        const t = outcome.report;
        const text = describeTransactionImport(t) + attachedNote;
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
  /*
   * One button that makes everything held agree with the reader as it is today.
   *
   * A fix to this reader does nothing for claims already stored — they keep the old reader's
   * answers for ever. The row as it arrived is kept against every claim, so nothing has to be
   * re-sent from PioneerRx: this reads that row again, restates what the report said, pairs any
   * reversal that was stranded, attaches any payment that arrived before its claim, and then says
   * whether the books balance. That last part is the point: it is the only way to know it worked.
   */
  async function recheckEverything() {
    "use server";
    const u = await requireManager();
    const { recheckHeldClaims } = await import("@/lib/claims");
    const r = await recheckHeldClaims();
    await audit({
      action: "claims.recheck",
      userId: u.id,
      userName: u.name,
      details: `${r.restated} of ${r.read} restated, ${r.reversalsPaired} reversals paired, ${r.paymentsMatched} payments matched`,
    });
    revalidatePath("/claims");
    revalidatePath("/purchasing");
    revalidatePath("/payers/performance");
    revalidatePath("/");

    const nothing = r.restated === 0 && r.reversalsPaired === 0 && r.paymentsMatched === 0;
    const did = [
      r.restated ? `${r.restated} claim${r.restated === 1 ? "" : "s"} restated from the row the report actually sent` : null,
      r.reversalsPaired
        ? `${r.reversalsPaired} reversal${r.reversalsPaired === 1 ? "" : "s"} finally matched the claim${r.reversalsPaired === 1 ? "" : "s"} they cancel, which had been standing as live revenue`
        : null,
      r.paymentsMatched ? `${r.paymentsMatched} payment${r.paymentsMatched === 1 ? "" : "s"} attached to the fill it belongs to` : null,
    ].filter(Boolean);

    const balance =
      r.after.fillsOff === 0 && Math.abs(r.after.differenceCents) <= 2
        ? "The books now balance: this site and PioneerRx agree to the cent on every fill."
        : `${r.after.fillsOff} fill${r.after.fillsOff === 1 ? "" : "s"} still disagree with the report` +
          (r.before.fillsOff > r.after.fillsOff ? `, down from ${r.before.fillsOff}` : "") +
          ". Open one below and send me the row.";

    redirect(
      "/claims?ok=" +
        encodeURIComponent(
          (nothing ? `Nothing needed changing — all ${r.read.toLocaleString()} claims already read the way this site reads them today. ` : `${did.join(". ")}. `) +
            balance,
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
            <Link href="/payers/performance" className="btn">Who pays best</Link>
            <Link href="/claims/floor" className="btn">Paid under the floor</Link>
            <Link href="/plans" className="btn">Classify plans</Link>
            <form action={recheckEverything}>
              <SubmitButton className="btn" pendingLabel="Rechecking…">Recheck every claim held</SubmitButton>
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
      {/*
        One line per thing, with the amount and the way to it.

        This was five paragraphs of prose stacked above the first number — each one written when it
        was the only one on the screen, and together a wall nobody could read. The explanations are
        still worth having and are still here; they are just folded away, because "what do I do
        today" and "why does this work like that" are different questions and only one of them gets
        asked every morning.
      */}
      <Todo
        items={[
          flags.awaitingFacilitator.length > 0
            ? {
                key: "promised",
                tone: "warn" as const,
                amount: formatCents(flags.awaitingFacilitatorCents),
                title: `promised by a plan and not yet paid — ${flags.awaitingFacilitator.length} fills`,
                href: "/remits/mtf",
                action: "Facilitator feed",
                why: `The plan named the payment when it adjudicated the claim; the money comes weeks later. Every one of these shows as a loss below until it lands, and none of them is a rate to argue about. Biggest is Rx ${flags.awaitingFacilitator[0].rxNumber}${flags.awaitingFacilitator[0].fillNumber !== null ? `-${flags.awaitingFacilitator[0].fillNumber}` : ""}${flags.awaitingFacilitator[0].itemName ? ` (${flags.awaitingFacilitator[0].itemName})` : ""} at ${formatCents(flags.awaitingFacilitator[0].facilitatorOutstandingCents ?? 0)}.`,
              }
            : null,
          /*
           * Money on account, split into the two things it actually is.
           *
           * A charge raised and not collected is a debt with a name on it. A dispensing with no
           * charge raised at all is the same money and no debt, so it shows up nowhere — it reads
           * as a fill that lost its entire acquisition cost, which is exactly what it will keep
           * looking like until somebody bills it.
           */
          flags.onAccount.unbilledCostCents > 0
            ? {
                key: "unbilled",
                tone: "crit" as const,
                amount: formatCents(flags.onAccount.unbilledCostCents),
                title: `dispensed on account with nothing billed — ${flags.onAccount.unbilled.length} fill${flags.onAccount.unbilled.length === 1 ? "" : "s"}`,
                href: "#on-account",
                action: "See them",
                why: `The drug left the shelf and no charge was raised against it, so it is not owed by anybody yet — it is simply cost the pharmacy has absorbed. Each one shows below as a loss of its whole acquisition cost, and will until it is billed. Biggest is Rx ${flags.onAccount.unbilled[0].rxNumber}${flags.onAccount.unbilled[0].fillNumber !== null ? `-${flags.onAccount.unbilled[0].fillNumber}` : ""}${flags.onAccount.unbilled[0].itemName ? ` (${flags.onAccount.unbilled[0].itemName})` : ""} at ${formatCents(flags.onAccount.unbilled[0].unbilledCostCents ?? 0)}.`,
              }
            : null,
          flags.onAccount.receivableCents > 0
            ? {
                key: "receivable",
                tone: "warn" as const,
                amount: formatCents(flags.onAccount.receivableCents),
                title: `billed to an account and not yet collected — ${flags.onAccount.fills.filter((f) => f.receivableCents > 0).length} fill${flags.onAccount.fills.filter((f) => f.receivableCents > 0).length === 1 ? "" : "s"}`,
                href: "#on-account",
                action: "See them",
                why: "Counted as revenue, because the sale happened and the report counts it. The cash has not arrived, so it is not in the till and does not belong in any figure that says what the pharmacy took.",
              }
            : null,
          /*
           * Remits against claims. A plan's 835 says what it paid on each fill; the claim says what
           * it was adjudicated for; the two must agree to the cent. Short is money to chase, over is
           * money that will be taken back. Only where a plan's remittance has been read in.
           */
          flags.remits.short.length > 0
            ? {
                key: "remit-short",
                tone: "crit" as const,
                amount: formatCents(flags.remits.shortCents),
                title: `paid short of what was adjudicated — ${flags.remits.short.length} fill${flags.remits.short.length === 1 ? "" : "s"} on the plans' own remittances`,
                href: "/claims/appeals",
                action: "Appeal",
                why: `The plan's 835 paid less than the claim adjudicated for. Worst is Rx ${flags.remits.short[0].rxNumber}${flags.remits.short[0].fillNumber !== null ? `-${flags.remits.short[0].fillNumber}` : ""}${flags.remits.short[0].itemName ? ` (${flags.remits.short[0].itemName})` : ""}: adjudicated ${formatCents(flags.remits.short[0].adjudicatedCents)}, paid ${formatCents(flags.remits.short[0].paidCents)} by ${flags.remits.short[0].payer ?? "the plan"}.`,
              }
            : null,
          flags.remits.over.length > 0
            ? {
                key: "remit-over",
                tone: "warn" as const,
                amount: formatCents(flags.remits.overCents),
                title: `paid over what was adjudicated — ${flags.remits.over.length} fill${flags.remits.over.length === 1 ? "" : "s"}; expect it back`,
                why: "A plan that paid more than it adjudicated will recover the difference. It is in the bank and it is not the pharmacy's; keep it out of any figure that says what the month made.",
              }
            : null,
          flags.remits.checked > 0 && flags.remits.short.length === 0 && flags.remits.over.length === 0
            ? {
                key: "remit-ok",
                tone: "ok" as const,
                amount: "",
                title: `the plans paid exactly what they adjudicated on ${flags.remits.checked} payment${flags.remits.checked === 1 ? "" : "s"}`,
                why: "Every plan remittance read in agrees with its claim to the cent. The remits balance to the claims.",
              }
            : null,
          !flags.balance.balances
            ? {
                key: "balance",
                tone: "crit" as const,
                amount: formatCents(Math.abs(flags.balance.differenceCents)),
                title: `the books do not balance — ${flags.balance.fillsOff} fill${flags.balance.fillsOff === 1 ? "" : "s"} disagree with the report`,
                href: "#loss",
                action: "See them",
                why: `This site makes these dispensings ${formatCents(flags.balance.ourMarginCents)} and PioneerRx makes them ${formatCents(flags.balance.reportMarginCents)}. Both are computed from the same rows, so a column is not where this reader thinks it is.${flags.unreconciled.length > 0 ? ` Worst is Rx ${flags.unreconciled[0].rxNumber}${flags.unreconciled[0].fillNumber !== null ? `-${flags.unreconciled[0].fillNumber}` : ""}${flags.unreconciled[0].itemName ? ` (${flags.unreconciled[0].itemName})` : ""}, out by ${formatCents(Math.abs(flags.unreconciled[0].unreconciledCents ?? 0))} — open "Why is this a loss?" on it and send me the box.` : ""}`,
              }
            : flags.balance.unchecked > 0
              ? {
                  /*
                    The books balance. That is the headline, and it was not the headline.

                    This tile showed "$35.00" in the amount slot in a warning colour, and the owner read
                    it — twice — as the books being $35.00 out. They are not: 260 dispensings agree to
                    the cent and nothing disagrees. The $35.00 is what PioneerRx calls gross profit on
                    one prescription whose acquisition cost was never recorded, which is the whole of
                    the payment precisely because it has no cost to take off either.

                    A money figure in the amount slot of a warning tile means money at risk everywhere
                    else on this page. So it is not one here, the tone says the books hold, and the
                    prescription is named — because a number with nothing to act on is a number that
                    gets asked about again.
                  */
                  key: "balance",
                  tone: "ok" as const,
                  amount: "",
                  title: `The books balance — ${(flags.balance.checkedFills ?? 0).toLocaleString("en-US")} dispensings agree to the cent, ${flags.balance.unchecked} has no cost to check`,
                  href: "#loss",
                  action: "See them",
                  why: `Nothing is out of balance. This site and the report agree to the cent on ${(flags.balance.checkedFills ?? 0).toLocaleString("en-US")} dispensings, and none disagrees. ${flags.balance.uncheckedNamed.map((u) => `${u.itemName ?? "One prescription"} (Rx ${u.rxNumber}${u.fillNumber !== null ? `-${u.fillNumber}` : ""}, ${u.dateFilled})`).join("; ")} went out with no acquisition cost recorded, so this site will not claim a margin on it — a bottle of unknown cost is not a free one. PioneerRx shows ${formatCents(flags.balance.uncheckedReportMarginCents)} of gross profit on it, which is the whole of the payment because it has no cost to take off either. It settles itself when the wholesaler's cost for that bottle comes through; nothing needs correcting in the account.`,
                }
            : {
                key: "balance",
                tone: "ok" as const,
                amount: "",
                title: "The books balance — this site and the report agree to the cent",
                why: `This site makes these dispensings ${formatCents(flags.balance.ourMarginCents)} and PioneerRx's own gross profit over the same rows comes to ${formatCents(flags.balance.reportMarginCents)}. Two answers worked out independently, agreeing exactly.`,
              },
          flags.undetermined > 0
            ? {
                key: "plans",
                tone: "warn" as const,
                amount: formatCents(flags.underFeeUndeterminedShortfallCents),
                title: `may or may not be owed — ${flags.undetermined} claims on plans nobody has classified`,
                href: "/plans",
                action: "Classify",
                why: "A low payment is only a shortfall on a plan the Kansas floor reaches; on a cash discount programme it is simply the price. Until each plan is told apart, nothing here can be claimed or dismissed.",
              }
            : null,
          flags.unlistedBins.length > 0
            ? {
                key: "bins",
                tone: "warn" as const,
                amount: "",
                title: `${flags.unlistedClaims} claims on ${flags.unlistedBins.length} BINs with no contract on file`,
                href: "/payers",
                action: "Payers",
                why: `Health Mart Atlas does not publish these at all, so nothing they pay can be checked against a rate: ${flags.unlistedBins.join(", ")}.`,
              }
            : null,
          laterMoney.length > 0
            ? {
                key: "later",
                tone: "ok" as const,
                amount: formatCents(laterMoney.reduce((n, x) => n + x.amountCents, 0)),
                                /*
                  Only what can still be matched. A payment against a prescription filled before the
                  claims feed began has nothing to match to and never will, so counting it as
                  pending made a number that could only go up.
                */
                title: `has reached these claims since they were transmitted${laterMoney.some((x) => x.unmatched > 0) ? ` — ${laterMoney.reduce((n, x) => n + x.unmatched, 0)} not yet matched to a claim` : laterMoney.some((x) => x.beforeTheFeed > 0) ? ` — every one matched, bar ${laterMoney.reduce((n, x) => n + x.beforeTheFeed, 0)} for prescriptions filled before this feed began` : ""}`,
                why: `From ${laterMoney.map((x) => `${x.payments} ${x.source.toUpperCase()}`).join(", ")}. Added to the fill it belongs to and kept apart from what the plan itself paid. Anything naming a prescription this site has not loaded attaches itself when it arrives.`,
              }
            : null,
          flags.unpriceable > 0
            ? {
                key: "noqty",
                tone: "warn" as const,
                amount: "",
                title: `${flags.unpriceable} claims carry no dispensed quantity, so they cannot be priced`,
                why: "That column comes through blank on the current PioneerRx export. Nothing can be measured against a contract or against NADAC without it.",
              }
            : null,
          flags.ambiguousPayer > 0
            ? {
                key: "ambiguous",
                tone: "warn" as const,
                amount: "",
                title: `${flags.ambiguousPayer} claims sit on a BIN shared by more than one PBM`,
                why: "The payer name did not settle which. Read the PCN or network ID off the claim to decide — they are not attached to a guess.",
              }
            : null,
        ].filter((x): x is NonNullable<typeof x> => x !== null)}
      />

      {/*
        What is on screen, and how to ask for something else.

        Named rather than assumed: every figure below is drawn from this range, and a balance struck
        over one day must not be read as a balance over the year.
      */}
      <form method="get" className="my-4 rounded-lg border border-line bg-surface p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            <span className="block text-ink-3">From</span>
            <input type="date" name="from" defaultValue={flags.scope.from ?? ""} className="mt-0.5 rounded-md border border-line px-2 py-1 text-sm" />
          </label>
          <label className="text-xs">
            <span className="block text-ink-3">To</span>
            <input type="date" name="to" defaultValue={flags.scope.to ?? ""} className="mt-0.5 rounded-md border border-line px-2 py-1 text-sm" />
          </label>
          <label className="text-xs">
            <span className="block text-ink-3">Prescription</span>
            <input name="rx" defaultValue={flags.scope.rx ?? ""} placeholder="331488" className="mt-0.5 w-32 rounded-md border border-line px-2 py-1 text-sm" />
          </label>
          <label className="text-xs">
            <span className="block text-ink-3">Payer or BIN</span>
            <input name="payer" defaultValue={flags.scope.payer ?? ""} placeholder="Caremark" className="mt-0.5 w-40 rounded-md border border-line px-2 py-1 text-sm" />
          </label>
          <button className="btn btn-sm btn-primary">Search</button>
          {searching && (
            <Link href="/claims" className="btn btn-sm">Back to the last day</Link>
          )}
        </div>
        <p className="mt-2 text-xs text-ink-3">
          {flags.scope.rx || flags.scope.payer ? (
            <>
              Showing {flags.total.toLocaleString()} claim{flags.total === 1 ? "" : "s"} matching{" "}
              {[flags.scope.rx ? `prescription ${flags.scope.rx}` : null, flags.scope.payer ? `payer ${flags.scope.payer}` : null]
                .filter(Boolean)
                .join(" and ")}
              {flags.scope.from ? ` between ${flags.scope.from} and ${flags.scope.to}` : " across every day held"}.
            </>
          ) : flags.scope.from === flags.scope.to && flags.scope.from ? (
            <>
              Showing <b>{flags.scope.from}</b> — the last day dispensed. Every figure below is that day&rsquo;s.
              Widen the dates to take in more; the screen loads what it shows and nothing else.
            </>
          ) : (
            <>
              Showing {flags.scope.from ?? "the beginning"} to {flags.scope.to ?? "today"}. Every figure below is drawn
              from that range.
            </>
          )}
        </p>
      </form>

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}
      {importJob && claimsImportRunning(importJob) && (
        <Notice kind="ok">
          Importing {importJob.fileName} in the background — {importJob.step}. Refresh to see where it has got to.
        </Notice>
      )}
      {importJob && importJob.state === "failed" && (
        <Notice kind="crit">
          The background import of {importJob.fileName} did not finish: {importJob.error ?? importJob.step}
        </Notice>
      )}
      {importJob && importJob.state === "done" && importJob.finishedAt && Date.now() - Date.parse(importJob.finishedAt) < 6 * 3_600_000 && (
        <Notice kind="ok">
          {importJob.fileName} imported in the background: {importJob.result ?? importJob.step}
        </Notice>
      )}

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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Figure
              label="What these fills made"
              value={formatCents(flags.marginCents)}
              tone={flags.marginCents < 0 ? "crit" : "ok"}
              sub={`${formatCents(flags.revenueCents)} taken in on ${flags.pricedFills.toLocaleString()} of ${flags.fills.length.toLocaleString()} dispensings`}
            />
            <Figure
              label="Counted, not found in the row"
              value={formatCents(flags.unreconciledCents)}
              tone={flags.unreconciledCents ? "warn" : "ok"}
              sub={flags.unreconciled.length ? `${flags.unreconciled.length} fills the report values higher than we can` : "The report and this site agree"}
            />
            <Figure
              label="Promised, not yet paid"
              value={formatCents(flags.awaitingFacilitatorCents)}
              tone={flags.awaitingFacilitatorCents ? "warn" : "ok"}
              sub={
                flags.awaitingFacilitator.length
                  ? `${flags.awaitingFacilitator.length} fills awaiting the facilitator`
                  : flags.underFee.length
                    ? `${formatCents(flags.underFeeShortfallCents)} under $10.50 on ${flags.underFee.length} in-scope claims`
                    : "Nothing outstanding"
              }
            />
            <Figure
              label="Dispensed at a loss"
              value={formatCents(flags.lossFillsTotalCents)}
              tone={flags.lossFills.length ? "crit" : "ok"}
              sub={`${flags.lossFills.length} dispensings, after every payer is counted`}
            />
          </div>
          <p className="mt-1 text-xs text-ink-3">
            {flags.total.toLocaleString()} claim rows became {flags.fills.length.toLocaleString()} dispensings — a
            prescription billed to a plan and then to a card is one bottle, and counting it twice doubles its cost and
            invents a loss.
            {flags.unpriceable > 0 && ` ${flags.unpriceable} carry no dispensed quantity and cannot be priced at all.`}
          </p>

          {/*
            The unclassified plans, the unlisted BINs, the missing quantities and the shared BINs
            are each one line of the list at the top of the page, with the amount and the way to
            it. They were repeated here as four paragraphs, so the same news arrived twice.
          */}

          {/*
            Folded shut. It is a reference table, not a morning read — nobody opens this screen to
            find out how Blue Cross did across 261 fills; they open it to find out what needs doing.
          */}
          <details className="mt-8">
          <summary className="cursor-pointer text-sm font-semibold">By payer — {byPayer.length} payers on these fills</summary>
          <p className="mb-2 mt-1 text-xs text-ink-3">
            Per dispensing, on the same arithmetic as everything else on this page — one bottle counted once, the
            patient counted once. A fill two plans coordinated on cannot be split between them honestly, so it is held
            out of the profit column and shown on its own, with each plan credited only with the money it sent.{" "}
            Open a payer to see its contracted rates and appeal route next to its claims.
          </p>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Payer</th>
                  <th className="text-right">Fills</th>
                  <th className="text-right">Received</th>
                  <th className="text-right">Gross profit</th>
                  <th className="text-right">At a loss</th>
                  <th className="text-right">Shared</th>
                  <th>Networks</th>
                </tr>
              </thead>
              <tbody>
                {byPayer.map((p) => (
                  <tr key={p.pbmName} className="border-t border-line align-top">
                    <td>
                      {p.pbmName.includes("unmatched") || p.pbmName === "Unidentified payer" ? (
                        <span>{p.pbmName}</span>
                      ) : (
                        <Link href={`/payers/${encodeURIComponent(p.pbmName)}`} className="font-medium underline">{p.pbmName}</Link>
                      )}
                      <div className="text-xs text-ink-3">{p.bins.join(", ") || "—"}</div>
                    </td>
                    <td className="text-right tabular-nums">{p.fills || <span className="text-ink-3">—</span>}</td>
                    <td className="text-right tabular-nums">{p.fills ? formatCents(p.receivedCents) : <span className="text-ink-3">—</span>}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${p.profitCents < 0 ? "text-red-700" : ""}`}>
                      {p.fills ? formatCents(p.profitCents) : <span className="text-ink-3">—</span>}
                    </td>
                    <td className="text-right tabular-nums">{p.belowCost || <span className="text-ink-3">—</span>}</td>
                    <td className="text-right text-xs tabular-nums text-ink-3">
                      {p.coordinatedFills ? (
                        <span title="Fills this plan priced alongside another. One bottle cannot be split between two plans honestly, so only the money this plan sent is shown.">
                          {p.coordinatedFills} · {formatCents(p.coordinatedRemitCents)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="text-xs text-ink-3">{p.networks.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </details>

          {/* ── Against the benchmark, also folded: it is a study, not a task ── */}
          <details className="mt-6">
          <summary className="cursor-pointer text-sm font-semibold">
            Against NADAC + the dispensing fee — {nadacStanding.rows.length} dispensings measured
            {actionable.length > 0 ? `, ${actionable.length} worth acting on` : ", none needing action"}
          </summary>
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
              <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Figure label="Compared" value={nadacStanding.rows.length} tone="muted" sub="Dispensings with a NADAC for that date" />
                <Figure
                  label="Owed — the floor reaches them"
                  value={formatCents(nadacStanding.owedCents)}
                  tone={nadacStanding.owedCents ? "warn" : "ok"}
                  sub="A shortfall to claim"
                />
                <Figure
                  label="Under, but out of reach"
                  value={formatCents(nadacStanding.argueCents)}
                  tone="muted"
                  sub="Not a claim — a rate to argue"
                />
                <Figure label="At or above the benchmark" value={nadacStanding.atOrAbove} tone="ok" sub="Paid what the drug cost, and the fee" />
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

          </details>

          {/*
            On account: the money that is not in the till.

            Kept above the loss list on purpose, because most of it *is* in the loss list and would
            be read wrongly there. A fill dispensed on account with nothing billed carries its whole
            acquisition cost as a loss, and it is not a pricing problem or a plan paying badly — it
            is a charge nobody raised. Reading it as a bad rate sends somebody to argue with a payer
            about money that was never claimed from one.
          */}
          {/*
            Shown only when it is a question.
            
            The owner: "you still havent fixed any of these.. including on account??" The rows had
            been corrected to say what each fill actually did — both were paid, both made money, and
            nothing was owed — and he was still looking at a section headed "On account" with two
            four-figure costs under it. A heading that names a problem is read as a problem however
            carefully the small print underneath explains that there is not one.
            
            So when nothing is owed and nothing went out unbilled, there is nothing here. What the
            fills were is on the dispensing itself for anyone who goes looking.
          */}
          {flags.onAccount.count > 0 && (flags.onAccount.receivableCents > 0 || flags.onAccount.unbilled.length > 0) && (
            <>
              <h2 id="on-account" className="mt-8 text-sm font-semibold">On account</h2>
              <p className="mt-1 text-xs text-ink-2">
                PioneerRx&rsquo;s &ldquo;AR&rdquo; — accounts receivable. In practice these are usually the leg of a
                dispensing that carries the acquisition cost while the money arrives on a different transmission, often
                on a different plan altogether. Grouped into the fill they belong to, most turn out to have been paid;
                what is listed here is the fill, not the row, so a cost leg that was settled elsewhere is not reported
                as a debt.
                {flags.onAccount.receivableCents === 0 && flags.onAccount.unbilled.length === 0 && (
                  <>
                    {" "}
                    <b>Every one of them has been paid</b> — nothing on this list is owed to the pharmacy.
                  </>
                )}
                {flags.onAccount.unbilled.length > 0 && (
                  <>
                    {" "}
                    <b className="text-crit">
                      {flags.onAccount.unbilled.length} of {flags.onAccount.count} had no charge raised at all
                    </b>
                    , so {formatCents(flags.onAccount.unbilledCostCents)} of cost is not owed by anybody yet — it is
                    absorbed until somebody bills it.
                  </>
                )}
              </p>
              <div className="mt-2 overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Rx</th>
                      <th>Drug</th>
                      <th>Filled</th>
                      <th>Plan</th>
                      <th className="text-right">Cost</th>
                      <th className="text-right">Came in</th>
                      <th className="text-right">Still owed</th>
                      <th>What it is</th>
                    </tr>
                  </thead>
                  <tbody>
                    {flags.onAccount.fills.map((f) => (
                      <tr key={f.key}>
                        <td className="whitespace-nowrap">
                          {f.rxNumber}
                          {f.fillNumber !== null && `-${f.fillNumber}`}
                        </td>
                        <td>{f.itemName ?? f.ndc11 ?? "—"}</td>
                        <td className="whitespace-nowrap text-xs">{f.dateFilled}</td>
                        <td className="text-xs">{f.payers[0]?.name ?? f.payers[0]?.bin ?? "—"}</td>
                        <td className="text-right">{f.acquisitionCents === null ? "—" : formatCents(f.acquisitionCents)}</td>
                        <td className="text-right">{formatCents(f.revenueCents)}</td>
                        <td className={`text-right ${f.receivableCents > 0 ? "text-crit" : ""}`}>{formatCents(f.receivableCents)}</td>
                        <td className="text-xs">
                          {/*
                            The row used to read "Billed. Not cash until it is collected." beside a nought, on a
                            fill that had been paid in full. The owner asked what he was looking at, which is the
                            right question: a $1,147.17 cost, nothing in the billed column and a sentence about
                            money not yet collected says a four-figure debt, and there was none. The paragraph
                            above the table had it right all along — most of these turn out to have been paid —
                            and the row underneath it disagreed.

                            Three different states, three different sentences, each drawn from this fill's own
                            arithmetic rather than from the status on its cost leg.
                          */}
                          {(f.unbilledCostCents ?? 0) > 0 ? (
                            <span className="text-crit">
                              Cost out of the door and nothing billed on any leg. Raise the charge, or find out which
                              plan should have had it.
                            </span>
                          ) : f.receivableCents > 0 ? (
                            <>Billed to the account and not yet collected.</>
                          ) : (
                            <>
                              Paid. The cost sits on the {f.payers[0]?.name ?? f.payers[0]?.bin ?? "account"} leg and the
                              money arrived on{" "}
                              {f.payers.filter((x) => x.remitCents > 0).map((x) => x.name ?? x.bin).join(" and ") || "another transmission"}
                              {f.marginCents !== null && <> &mdash; {formatCents(f.marginCents)} on the bottle</>}. Nothing is owed.
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-ink-3">
                Nothing before today has been carried in — these start from the first report loaded, as asked.
              </p>
            </>
          )}

          <h2 id="loss" className="mt-8 text-sm font-semibold">Dispensed at a loss</h2>
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
                {/*
                  And it carries its scope. The page shows one day — the last dispensed — and says so
                  higher up, but this sentence did not, so "2 ... $193.78" read as the whole feed:
                  "im pretty sure we have more than 2 MTF claims from 09/01, whats going on here."
                  He was right about the pharmacy and the page was right about the day; nothing on
                  this line said which was being answered.
                */}
                {promisedLosses.length} of these are waiting on a facilitator payment the plan already promised —{" "}
                {formatCents(promisedLossCents)} between them, on{" "}
                {flags.scope.from && flags.scope.to && flags.scope.from !== flags.scope.to
                  ? `${flags.scope.from} to ${flags.scope.to}`
                  : (flags.scope.from ?? "the day shown")}.
              </b>{" "}
              They are marked <span className="badge badge-warn">MTF promised</span> below, with what each becomes once
              it is paid. Nothing about them is a rate to argue over, and nothing needs doing to them: the payment posts
              itself against the fill when it arrives.
            </p>
          )}
          {flags.lossFills.length === 0 ? (
            <Empty>None — every dispensing brought in at least what the drug cost.</Empty>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Filled</th>
                    <th>Drug</th>
                    <th>Paid by</th>
                    <th className="text-right">Came in</th>
                    <th className="text-right">Cost</th>
                    <th className="text-right">Loss</th>
                  </tr>
                </thead>
                <tbody>
                  {/*
                    Cut at fifty, and it never said so — on a page whose other table says "the worst
                    60 of N". Today there are forty-five so nothing is lost; widen the dates and two
                    hundred and forty become fifty rows with no note.
                  */}
                  {flags.lossFills.slice(0, 50).map((f) => (
                    <React.Fragment key={f.key}>
                    <tr>
                      <td className="whitespace-nowrap text-xs">{f.dateFilled}</td>
                      <td>
                        {f.itemName ?? f.ndc11 ?? "—"}
                        <span className="block font-mono text-[11px] text-ink-3">Rx {f.rxNumber}{f.fillNumber !== null ? `-${f.fillNumber}` : ""}</span>
                      </td>
                      <td className="text-xs">
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
                      <td className="text-right tabular-nums">{formatCents(f.revenueCents)}</td>
                      <td className="text-right tabular-nums">{formatCents(f.acquisitionCents ?? 0)}</td>
                      <td className="text-right tabular-nums text-red-700">
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
              {flags.lossFills.length > 50 && (
                <p className="mt-2 text-xs text-ink-3">
                  The worst 50 of {flags.lossFills.length} are shown.
                </p>
              )}
            </div>
          )}

          {imports.length > 0 && (
            <>
              {/* Every file ever loaded is a record, not a reading: folded, with the newest on the summary line. */}
              <details className="mt-8">
                <summary className="cursor-pointer text-sm font-semibold">
                  Files loaded <span className="font-normal text-ink-3">— {imports.length}, the newest {imports[0]?.fileName ?? "none"}{imports[0] ? ` (${imports[0].claimsAdded} added)` : ""}</span>
                </summary>
              <ul className="mt-2 divide-y divide-line rounded-lg border border-line bg-surface text-sm">
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
              </details>
            </>
          )}
        </>
      )}
      {/*
        Where these claims come from, and how to feed it by hand.

        Folded shut as well. "Did last night's file come in" is worth one glance, and it is one
        glance — not the four paragraphs of plumbing it used to take to answer.

        It belongs on this page — the morning after, "did last night's file come in" is one glance
        here. It does not belong above the money. Anyone opening this screen is asking what the
        pharmacy made and what it is owed, and four paragraphs of plumbing before the first figure
        is how a working screen turns into a wall.
      */}
      <details className="my-4 rounded-lg border border-line bg-surface p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          Daily claims feed{lastImport ? ` — last file ${lastImport.fileName}` : " — nothing received yet"}
        </summary>
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
      </details>

      <details className="my-4 rounded-lg border border-line bg-surface p-4">
        <summary className="cursor-pointer text-sm font-semibold">Load a file by hand</summary>
        <p className="mt-1 text-xs text-ink-3">
          The daily transaction report (.txt) or the Completed Prescriptions export (.xlsx or .csv). Loading the same
          file again is safe — every row is identified, so anything already held is counted rather than added twice.
        </p>
        <form action={upload} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="file" name="file" accept=".xlsx,.csv,.txt" className="text-sm" />
          <button className="btn btn-primary">Load</button>
        </form>
      </details>


      <ExportData page="claims" params={{ from, to, rx, payer }} className="mt-6" />
    </>
  );
}

/**
 * The day's work, one line each.
 *
 * The rule this screen broke: an explanation is worth writing once and reading once, and a screen
 * that reprints it every morning stops being read at all. So each line says the amount, what it is,
 * and where to go — and the reasoning sits behind a disclosure for the day somebody wants it.
 */
function Todo({
  items,
}: {
  items: { key: string; tone: "ok" | "warn" | "crit"; amount: string; title: string; href?: string; action?: string; why: string }[];
}) {
  if (items.length === 0) return null;
  const dot = { ok: "bg-accent", warn: "bg-warn", crit: "bg-crit" };
  return (
    <ul className="my-4 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {items.map((i) => (
        <li key={i.key} className="px-3 py-2.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot[i.tone]}`} aria-hidden />
            {i.amount && <b className="tabular-nums">{i.amount}</b>}
            <span className="min-w-0 flex-1 text-sm">{i.title}</span>
            {i.href && (
              <Link href={i.href} className="btn btn-sm shrink-0">
                {i.action ?? "Open"}
              </Link>
            )}
          </div>
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-ink-3 hover:text-accent">Why</summary>
            <p className="mt-1 pr-8 text-xs leading-snug text-ink-2">{i.why}</p>
          </details>
        </li>
      ))}
    </ul>
  );
}

