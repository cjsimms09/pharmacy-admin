import fs from "node:fs/promises";
import path from "node:path";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { loadNadacFiles, nadacCoverage, nadacClaimCoverage, nadacDir } from "@/lib/nadac";
import { fetchNadac } from "@/lib/nadac-fetch";
import { getSettings, setSetting } from "@/lib/settings";
import { requireReimbursement } from "@/lib/features";
import { PageHeader, Notice, Empty } from "@/components/ui";

export const metadata = { title: "NADAC" };
export const dynamic = "force-dynamic";

export default async function NadacPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireReimbursement();
  await requireUser();
  const { ok, error } = await searchParams;
  const s = await getSettings();
  const cov = await nadacCoverage();
  const claimCov = cov.prices > 0 ? await nadacClaimCoverage() : null;

  async function pullNow() {
    "use server";
    const u = await requireManager();
    const r = await fetchNadac();
    await audit({ action: "nadac.fetch", userId: u.id, userName: u.name, details: r.message.slice(0, 200) });
    revalidatePath("/nadac");
    redirect(`/nadac?${r.ok ? "ok" : "error"}=` + encodeURIComponent(r.message));
  }

  async function saveAuto(fd: FormData) {
    "use server";
    const u = await requireManager();
    await setSetting("nadac_auto", fd.get("auto") ? "yes" : "no");
    await setSetting("nadac_source_url", String(fd.get("sourceUrl") ?? "").trim());
    await audit({ action: "nadac.settings", userId: u.id, userName: u.name });
    revalidatePath("/nadac");
    redirect("/nadac?ok=" + encodeURIComponent("Saved."));
  }

  async function upload(fd: FormData) {
    "use server";
    const u = await requireManager();
    const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) redirect("/nadac?error=" + encodeURIComponent("Choose at least one file."));
    const dir = nadacDir();
    await fs.mkdir(dir, { recursive: true });
    for (const f of files) {
      // Keep the CMS filename — it carries the publication date, which is how a week is identified.
      const safe = path.basename(f.name).replace(/[^A-Za-z0-9._-]/g, "_");
      await fs.writeFile(path.join(dir, safe), Buffer.from(await f.arrayBuffer()));
    }
    try {
      const reports = await loadNadacFiles();
      const added = reports.reduce((s, r) => s + r.added, 0);
      const had = reports.reduce((s, r) => s + r.alreadyHad, 0);
      const skipped = reports.reduce((s, r) => s + r.skipped, 0);
      await audit({ action: "nadac.load", userId: u.id, userName: u.name, details: `${added} prices added, ${had} already held, ${skipped} rows skipped` });
      revalidatePath("/nadac");
      const bits = [`${added.toLocaleString()} prices added`];
      if (had) bits.push(`${had.toLocaleString()} already held`);
      if (skipped) {
        const why = reports.flatMap((r) => Object.entries(r.reasons));
        const merged = new Map<string, number>();
        for (const [k, v] of why) merged.set(k, (merged.get(k) ?? 0) + v);
        bits.push(`${skipped.toLocaleString()} rows skipped (${[...merged].map(([k, v]) => `${v} ${k}`).join(", ")})`);
      }
      redirect("/nadac?ok=" + encodeURIComponent(bits.join(", ") + "."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/nadac?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not read those files."));
    }
  }

  return (
    <>
      <PageHeader
        title="NADAC"
        subtitle="The National Average Drug Acquisition Cost, published weekly by CMS. Under Kansas SB 20 it is the reimbursement floor for commercial plans outside ERISA."
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {cov.prices === 0 && (
        <Notice kind="warn">
          No NADAC loaded. Until it is, no claim can be checked against the statutory floor — the engine will decline
          to price rather than estimate.
        </Notice>
      )}

      {/* ── Automatic ── */}
      <section className="my-4 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Fetch it automatically</h2>
        <p className="mt-1 text-sm text-ink-2">
          NADAC is free and public and needs no account. CMS publishes weekly, on a Wednesday, so this checks a couple
          of times a week and does nothing when there is nothing new.
        </p>
        <p className="mt-1 text-xs text-ink-3">
          Worth leaving on even while the reimbursement pages are switched off: each weekly file carries only the
          prices in force that week, so a month with this off is a month of history to reconstruct later.
        </p>
        <form action={saveAuto} className="mt-3 space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="auto" defaultChecked={s.nadac_auto === "yes"} />
            Keep NADAC up to date automatically
          </label>
          <label className="block text-xs text-ink-3">
            Address to download from (leave blank unless CMS has moved it)
            <input name="sourceUrl" defaultValue={s.nadac_source_url} placeholder="https://download.medicaid.gov/…" className="field font-mono text-xs" />
          </label>
          <button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-ground">Save</button>
        </form>
        <form action={pullNow} className="mt-3 border-t border-line pt-3">
          <button className="rounded-md bg-ink px-3 py-2 text-sm text-white">Fetch now</button>
          {s.nadac_last_fetch && (
            <p className="mt-2 text-xs text-ink-3">
              Last checked {new Date(s.nadac_last_fetch).toLocaleString()} — {s.nadac_last_result}
            </p>
          )}
        </form>
      </section>

      <section className="my-4 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Or load files by hand</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink-2">
          <li>
            Go to <code>data.medicaid.gov</code> and search for <b>NADAC (National Average Drug Acquisition Cost)</b>.
            It is free and needs no account.
          </li>
          <li>
            Download the weekly CSV for <b>every week that overlaps the claims you want to price</b>, not just the
            current one. Each weekly file carries only the prices in force that week. A price that changed since is
            gone from the newest file, so pricing an August claim needs a file from around August.
          </li>
          <li>Drop the files in below. Loading the same file twice is safe — a price is keyed on NDC plus effective date.</li>
        </ol>
        <form action={upload} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="file" name="files" accept=".csv,.txt" multiple className="text-sm" />
          <button className="rounded-md bg-ink px-3 py-2 text-sm text-white">Load</button>
        </form>
        <p className="mt-2 text-xs text-ink-3">
          Files can also be copied straight into <code>{nadacDir()}</code> and loaded from here.
        </p>
      </section>

      {cov.prices > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Prices held" value={Number(cov.prices).toLocaleString()} />
            <Stat label="Distinct NDCs" value={Number(cov.ndcs).toLocaleString()} />
            <Stat label="Earliest effective" value={cov.earliest ?? "—"} />
            <Stat label="Latest effective" value={cov.latest ?? "—"} />
          </div>

          {claimCov && claimCov.claims > 0 && (
            <>
              <h2 className="mt-8 text-sm font-semibold">Against our own claims</h2>
              <p className="mb-2 text-xs text-ink-3">
                The only coverage figure that matters: how many claims we hold have a NADAC in force on their own fill
                date. A file of thirty thousand NDCs is no use if it misses the twelve we dispensed.
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Claims held" value={claimCov.claims.toLocaleString()} />
                <Stat label="Can be priced" value={claimCov.priced.toLocaleString()} tone={claimCov.priced ? "ok" : "warn"} />
                <Stat
                  label="No NADAC on the fill date"
                  value={(claimCov.withNdc - claimCov.priced).toLocaleString()}
                  tone={claimCov.withNdc - claimCov.priced ? "warn" : undefined}
                />
                <Stat label="No NDC on the claim" value={claimCov.noNdc.toLocaleString()} tone={claimCov.noNdc ? "warn" : undefined} />
              </div>

              {claimCov.missing.length > 0 && (
                <>
                  <h3 className="mt-6 text-sm font-semibold">Drugs with no NADAC in force</h3>
                  <p className="mb-2 text-xs text-ink-3">
                    Usually means the weekly file covering that fill date has not been loaded. Some products genuinely
                    have no NADAC — CMS does not price everything.
                  </p>
                  <div className="overflow-x-auto rounded-lg border border-line">
                    <table className="w-full text-sm">
                      <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
                        <tr><th className="px-3 py-2">NDC</th><th className="px-3 py-2">Drug</th><th className="px-3 py-2 text-right">Claims</th></tr>
                      </thead>
                      <tbody>
                        {claimCov.missing.slice(0, 40).map((m) => (
                          <tr key={m.ndc11} className="border-t border-line">
                            <td className="px-3 py-2 font-mono text-xs">{m.ndc11}</td>
                            <td className="px-3 py-2">{m.itemName ?? "—"}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{m.claims}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}

          <h2 className="mt-8 text-sm font-semibold">Weeks loaded</h2>
          {cov.weeks.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-sm">
                <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
                  <tr><th className="px-3 py-2">Effective date</th><th className="px-3 py-2 text-right">Prices</th></tr>
                </thead>
                <tbody>
                  {cov.weeks.map((w) => (
                    <tr key={w.effectiveOn} className="border-t border-line">
                      <td className="px-3 py-2">{w.effectiveOn}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(w.n).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" | "ok" }) {
  const border = tone === "warn" ? "border-amber-300 bg-amber-50" : tone === "ok" ? "border-emerald-300 bg-emerald-50" : "border-line bg-surface";
  return (
    <div className={`rounded-lg border p-3 ${border}`}>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-ink-3">{label}</div>
    </div>
  );
}
