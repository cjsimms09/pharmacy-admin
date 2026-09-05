import fs from "node:fs/promises";
import path from "node:path";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { loadNadacFiles, nadacCoverage, nadacClaimCoverage, nadacWeekGaps, nadacDir } from "@/lib/nadac";
import { fetchNadac, fetchNadacFrom, yearArchiveUrl, archiveYears } from "@/lib/nadac-fetch";
import { getSettings, setSetting } from "@/lib/settings";
import { PageHeader, Notice, Empty } from "@/components/ui";

export const metadata = { title: "NADAC" };
export const dynamic = "force-dynamic";

export default async function NadacPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  /*
   * Reachable whether or not the reimbursement pages are switched on.
   *
   * It used to be guarded like the rest of that section, which made the alert telling somebody
   * their price history had stopped collecting point at a page that redirected them home. The
   * collection deliberately runs regardless — a week not collected cannot be fetched later — so
   * the one screen that can diagnose and restart it has to be reachable regardless too.
   */
  await requireUser();
  const { ok, error } = await searchParams;
  const s = await getSettings();
  const cov = await nadacCoverage();
  const claimCov = cov.prices > 0 ? await nadacClaimCoverage() : null;
  const gaps = claimCov && claimCov.priced < claimCov.withNdc ? await nadacWeekGaps() : [];

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

  /**
   * Loading one named file, from an address pasted in.
   *
   * The weekly pull can only ever fetch this week. Everything before it has to come from a back
   * file, and making somebody download ten of them by hand is how the history never gets loaded.
   */
  async function pullFrom(fd: FormData) {
    "use server";
    const u = await requireManager();
    const url = String(fd.get("url") ?? "").trim();
    if (!url) redirect("/nadac?error=" + encodeURIComponent("Paste the address of the file first."));
    const r = await fetchNadacFrom([url]);
    await audit({ action: "nadac.fetch_url", userId: u.id, userName: u.name, details: `${url} — ${r.message.slice(0, 160)}` });
    revalidatePath("/nadac");
    redirect(`/nadac?${r.ok ? "ok" : "error"}=` + encodeURIComponent(r.message));
  }

  /**
   * Pulling a whole calendar year in one go.
   *
   * CMS keeps a dataset per year holding every weekly file for that year, which is the thing that
   * turns "hunt down ten weekly files" into one button. Same load path and the same refusals as
   * everything else: parsed before it is written, so a page that is not NADAC never lands.
   */
  async function pullYear(fd: FormData) {
    "use server";
    const u = await requireManager();
    const year = String(fd.get("year") ?? "");
    const url = yearArchiveUrl(year);
    if (!url) redirect("/nadac?error=" + encodeURIComponent(`No archive address is known for ${year}.`));
    const r = await fetchNadacFrom([url]);
    await audit({ action: "nadac.fetch_year", userId: u.id, userName: u.name, details: `${year} — ${r.message.slice(0, 160)}` });
    revalidatePath("/nadac");
    redirect(`/nadac?${r.ok ? "ok" : "error"}=` + encodeURIComponent(`${year}: ${r.message}`));
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
            <input type="checkbox" name="auto" defaultChecked={s.nadac_auto !== "no"} />
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

      {/*
        The weeks that are actually missing, named.

        "184 claims have no NADAC" is a fact nobody can act on. One file per week is how CMS
        publishes, so naming the weeks turns the problem into a shopping list — and downloading a
        single file closes a whole row of this table.
      */}
      {gaps.length > 0 && (
        <section className="my-4 rounded-lg border border-warn bg-warn-soft p-4">
          <h2 className="text-sm font-semibold text-warn">The weeks you are missing</h2>
          <p className="mt-1 text-sm text-ink-2">
            These claims were filled in weeks no loaded file covers. Get the CMS weekly file published on or just
            before each date below and the whole row prices. Fetching the current file again will not help — it
            carries only this week&rsquo;s prices, and any that have changed since are gone from it.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="table">
              <thead>
                <tr><th>Week beginning</th><th className="text-right">Claims</th><th className="text-right">Products</th><th>For example</th></tr>
              </thead>
              <tbody>
                {gaps.map((g) => (
                  <tr key={g.weekStart}>
                    <td className="whitespace-nowrap font-medium">{g.weekStart}</td>
                    <td className="text-right">{g.claims}</td>
                    <td className="text-right text-ink-2">{g.distinctNdcs}</td>
                    <td className="text-xs text-ink-3">{g.examples.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/*
        A whole year in one download.

        The weekly pull only ever carries this week. CMS also publishes a dataset per calendar
        year holding every weekly file for that year — which is what makes back-filling the
        history a single button rather than ten trips to a download page.
      */}
      <section className="my-4 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Back-fill a whole year</h2>
        <p className="mt-1 text-sm text-ink-2">
          Each year&rsquo;s dataset holds every weekly file CMS published that year, so one download covers every
          effective date in it. This is how you price claims from months ago &mdash; fetching the current file again
          never will, because it carries only this week&rsquo;s prices.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {archiveYears().map((y) => (
            <form key={y} action={pullYear}>
              <input type="hidden" name="year" value={y} />
              <button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-ground">Fetch {y}</button>
            </form>
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-3">
          A year is a large file and may take a few minutes. If it comes back saying it is too large to load in one
          piece, download it in a browser and use the file box below &mdash; the result is identical.
        </p>
      </section>

      <section className="my-4 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Load one file from an address</h2>
        <p className="mt-1 text-sm text-ink-2">
          For back files. Find the week you need on <code>data.medicaid.gov</code>, copy the link to its CSV, and
          paste it here — it is loaded through exactly the same checks as the automatic pull, so a page that is not a
          NADAC file is refused rather than saved.
        </p>
        <form action={pullFrom} className="mt-3 flex flex-wrap items-center gap-2">
          <input name="url" placeholder="https://download.medicaid.gov/…" className="field flex-1 font-mono text-xs" />
          <button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-ground">Fetch it</button>
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
          A CMS weekly file is about thirty thousand rows and takes a couple of seconds. The page will not respond
          while it works — if you have several weeks to load, do them a few at a time rather than all at once.
        </p>
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
