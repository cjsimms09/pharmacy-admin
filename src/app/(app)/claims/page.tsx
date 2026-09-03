import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { importClaims, claimFlags, claimsByPayer, claimImports } from "@/lib/claims";
import { formatCents } from "@/lib/money";
import { requireReimbursement } from "@/lib/features";
import { PageHeader, Notice, Empty } from "@/components/ui";

export const metadata = { title: "Claims" };
export const dynamic = "force-dynamic";

export default async function ClaimsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireReimbursement();
  await requireUser();
  const { ok, error } = await searchParams;
  const [flags, byPayer, imports] = await Promise.all([claimFlags(), claimsByPayer(), claimImports()]);

  async function upload(fd: FormData) {
    "use server";
    const u = await requireManager();
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) redirect("/claims?error=" + encodeURIComponent("Choose a file first."));
    try {
      const r = await importClaims(Buffer.from(await file.arrayBuffer()), file.name, u.id);
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

  return (
    <>
      <PageHeader title="Claims" subtitle="Dispensing and adjudication detail from PioneerRx, matched to the payer that priced it." />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <section className="my-4 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Load a claims export</h2>
        <p className="mt-1 text-xs text-ink-3">
          The PioneerRx Completed Prescriptions export, as .xlsx or .csv. Loading an overlapping file again is safe —
          a claim is identified by prescription number, fill number and fill date, so anything already held is
          counted rather than added twice.
        </p>
        <form action={upload} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="file" name="file" accept=".xlsx,.csv" className="text-sm" />
          <button className="rounded-md bg-ink px-3 py-2 text-sm text-white">Load</button>
        </form>
      </section>

      {flags.total === 0 ? (
        <Empty>No claims loaded yet.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Claims held" value={flags.total.toLocaleString()} />
            <Stat label="Dispensed at a loss" value={String(flags.belowCost.length)} tone={flags.belowCost.length ? "warn" : undefined} sub={formatCents(flags.belowCostTotalCents)} />
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
          {flags.belowCost.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-sm">
                <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
                  <tr>
                    <th className="px-3 py-2">Filled</th>
                    <th className="px-3 py-2">Drug</th>
                    <th className="px-3 py-2">Payer</th>
                    <th className="px-3 py-2">Network</th>
                    <th className="px-3 py-2 text-right">Loss</th>
                  </tr>
                </thead>
                <tbody>
                  {[...flags.belowCost].sort((a, b) => (a.grossProfitCents ?? 0) - (b.grossProfitCents ?? 0)).slice(0, 50).map((c) => (
                    <tr key={c.id} className="border-t border-line">
                      <td className="px-3 py-2 whitespace-nowrap text-xs">{c.dateFilled}</td>
                      <td className="px-3 py-2">{c.itemName ?? c.ndc11 ?? "—"}</td>
                      <td className="px-3 py-2">{c.pbmName ?? c.payerLabel ?? "—"}</td>
                      <td className="px-3 py-2 text-xs text-ink-3">{c.networkId ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-red-700">{formatCents(c.grossProfitCents ?? 0)}</td>
                    </tr>
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
