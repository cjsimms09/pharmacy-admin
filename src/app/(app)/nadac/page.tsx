import fs from "node:fs/promises";
import path from "node:path";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { loadNadacFiles, nadacCoverage, nadacClaimCoverage, nadacWeekGaps, nadacDir, nadacHealth } from "@/lib/nadac";
import { yearArchiveUrlAsync, archiveYearsAsync, nadacAuto, nadacDatasets, weekSources } from "@/lib/nadac-fetch";
import { nadacJob, startNadacFetch, runNadacFetch, nadacJobRunning } from "@/lib/nadac-job";
import { JobPanel } from "@/components/job-panel";
import { getSettings, setSetting } from "@/lib/settings";
import { PageHeader, Notice, Empty, Card, Figure } from "@/components/ui";
import { ExportData } from "@/components/export-data";

export const metadata = { title: "NADAC" };
export const dynamic = "force-dynamic";

/*
 * Every fetch is a background job.
 *
 * The button used to do the download, parse and load inside its own request, and it froze the
 * site: the browser's router waits on a pending action, so nothing else answered until a
 * multi-megabyte download had finished. Now the press claims the job and returns at once; the
 * work runs after the response and the panel on the page shows where it has got to.
 *
 * At module level, not inside the page. An inline server action's closed-over variables are
 * serialised into the form, and a function cannot be — a version that defined this next to the
 * actions rendered as "Functions cannot be passed directly to Client Components" in production.
 */
async function begin(what: string, sources: string[]): Promise<never> {
  const u = await requireManager();
  const r = await startNadacFetch(u, what);
  if (r.started) after(() => runNadacFetch(u, r.runId!, what, sources));
  revalidatePath("/nadac");
  redirect(`/nadac?${r.started ? "ok" : "error"}=` + encodeURIComponent(r.message));
}

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
  const health = await nadacHealth();
  const claimCov = cov.prices > 0 ? await nadacClaimCoverage() : null;
  const gaps = claimCov && claimCov.priced < claimCov.withNdc ? await nadacWeekGaps() : [];
  const job = await nadacJob();
  const running = nadacJobRunning(job);
  // What data.medicaid.gov currently calls its NADAC datasets, so the ids are never stale.
  const datasets = await nadacDatasets();
  const years = await archiveYearsAsync();


  async function saveAuto(fd: FormData) {
    "use server";
    const u = await requireManager();
    await setSetting("nadac_auto", fd.get("auto") ? "yes" : "no");
    await setSetting("nadac_source_url", String(fd.get("sourceUrl") ?? "").trim());
    await audit({ action: "nadac.settings", userId: u.id, userName: u.name });
    revalidatePath("/nadac");
    redirect("/nadac?ok=" + encodeURIComponent("Saved."));
  }



  async function pullNow() {
    "use server";
    const { weeklySourcesAsync } = await import("@/lib/nadac-fetch");
    const s2 = await getSettings();
    await begin("the current weekly file", await weeklySourcesAsync(s2.nadac_source_url));
  }

  /*
   * One missing week, fetched on its own.
   *
   * The gaps table names the weeks; this is the button beside each. It tries the plain weekly
   * file for that week's Wednesday, then the week cut out of the yearly dataset — a few megabytes
   * — rather than the whole archive.
   */
  async function pullWeek(fd: FormData) {
    "use server";
    const weekStart = String(fd.get("weekStart") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) redirect("/nadac?error=" + encodeURIComponent("That is not a week."));
    await begin(`the file for the week of ${weekStart}`, await weekSources(weekStart));
  }

  async function refreshDatasets() {
    "use server";
    const u = await requireManager();
    const d = await nadacDatasets({ refresh: true });
    await audit({ action: "nadac.datasets", userId: u.id, userName: u.name, details: d ? `weekly ${d.weekly?.id ?? "none"}; years ${Object.keys(d.years).join(", ")}` : "listing unreachable" });
    revalidatePath("/nadac");
    redirect("/nadac?" + (d ? `ok=${encodeURIComponent(`Read the dataset listing: ${d.weekly ? "the current weekly file" : "no weekly file"}, archives for ${Object.keys(d.years).sort().reverse().join(", ") || "no years"}.`)}` : `error=${encodeURIComponent("Could not read the dataset listing on data.medicaid.gov. The built-in addresses are still in use.")}`));
  }

  async function pullFrom(fd: FormData) {
    "use server";
    const url = String(fd.get("url") ?? "").trim();
    if (!url) redirect("/nadac?error=" + encodeURIComponent("Paste the address of the file first."));
    await begin("the file at the address you pasted", [url]);
  }

  async function pullYear(fd: FormData) {
    "use server";
    const year = String(fd.get("year") ?? "");
    const url = await yearArchiveUrlAsync(year);
    if (!url) redirect("/nadac?error=" + encodeURIComponent(`No archive address is known for ${year}.`));
    await begin(`the ${year} archive`, [url]);
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

      {/*
        The verdict, before any detail.

        This page used to open with a settings form and a row of counts, and a pharmacist looking at
        it could not answer the only question that matters. A fetch reporting "720,000 rows read, 0
        new" is a complete success — every price CMS has published was already held — and read like
        a failure. So the page now says, in a sentence, whether today's claims can be priced.
      */}
      <div
        className={`my-4 rounded-lg border p-4 ${
          health.state === "current" ? "border-accent bg-accent-soft" : health.state === "behind" ? "border-warn bg-warn-soft" : "border-crit bg-crit-soft"
        }`}
      >
        <p className={`text-sm font-semibold ${health.state === "current" ? "text-accent" : health.state === "behind" ? "text-warn" : "text-crit"}`}>
          {health.headline}
        </p>
        <p className="mt-1 text-sm text-ink-2">{health.detail}</p>
      </div>

      {/* ── Automatic ── */}
      <Card title="Fetch it automatically" className="my-4">        <p className="mt-1 text-sm text-ink-2">
          NADAC is free and public and needs no account. CMS publishes one file a week, on a Wednesday, of a few
          megabytes, at a fixed address ending in that Wednesday&rsquo;s date. Press <b>Fetch now</b> once to take the
          most recent one; after that it looks every day and downloads only a week it does not already hold. The
          Wednesday is in the address, so a week already here is never asked for again and the ordinary daily check
          costs nothing at all. If a week was not published, the week before it is taken instead, so there is always
          something to price against.
        </p>
        <p className="mt-1 text-xs text-ink-3">
          Worth leaving on even while the reimbursement pages are switched off: each weekly file carries only the
          prices in force that week, so a month with this off is a month of history to reconstruct later.
        </p>
        {/*
          A stale override is the failure that hid the 2022 problem.

          The pharmacy's own address is tried before every built-in one — which is right, since it
          exists for the day CMS moves the file. But it then wins for ever, silently, including
          over corrections to the built-in list. Somebody who pasted an address a year ago has no
          reason to remember it, and nothing on the page said it was in force.
        */}
        {s.nadac_source_url?.trim() && (
          <p className="mt-3 rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm text-warn">
            <b>An address of your own is set, and it is tried before every built-in one.</b> Everything downloads from{" "}
            <span className="font-mono text-xs">{s.nadac_source_url}</span> unless it fails. If prices are coming in
            from the wrong year, empty this box and save — the built-in list is kept current.
          </p>
        )}
        <form action={saveAuto} className="mt-3 space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="auto" defaultChecked={nadacAuto(s)} />
            Keep NADAC up to date automatically
          </label>
          <label className="block text-xs text-ink-3">
            Address to download from (leave blank unless CMS has moved it)
            <input name="sourceUrl" defaultValue={s.nadac_source_url} placeholder="https://download.medicaid.gov/…" className="field font-mono text-xs" />
          </label>
          <button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-ground">Save</button>
        </form>
        <div className="mt-3 border-t border-line pt-3">
          {running ? (
            <JobPanel step={`Fetching ${job!.what} — ${job!.step}`} done={0} total={0} startedAt={job!.startedAt} by={job!.by} />
          ) : (
            <form action={pullNow}>
              <button className="btn btn-primary">Fetch now</button>
            </form>
          )}
          {!running && job && job.state !== "running" && (
            <p className={`mt-2 text-xs ${job.state === "failed" ? "text-crit" : "text-ink-3"}`}>
              {job.state === "failed" ? "Last fetch failed" : "Last fetch"}
              {job.finishedAt ? ` ${new Date(job.finishedAt).toLocaleString()}` : ""} — {job.step}
            </p>
          )}
          {!job && s.nadac_last_fetch && (
            <p className="mt-2 text-xs text-ink-3">
              Last checked {new Date(s.nadac_last_fetch).toLocaleString()} — {s.nadac_last_result}
            </p>
          )}
        </div>
      </Card>

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
                <tr><th>Week beginning</th><th className="text-right">Claims</th><th className="text-right">Products</th><th>For example</th><th></th></tr>
              </thead>
              <tbody>
                {gaps.map((g) => (
                  <tr key={g.weekStart}>
                    <td className="whitespace-nowrap font-medium">{g.weekStart}</td>
                    <td className="text-right">{g.claims}</td>
                    <td className="text-right text-ink-2">{g.distinctNdcs}</td>
                    <td className="text-xs text-ink-3">{g.examples.join(", ") || "—"}</td>
                    <td className="text-right">
                      <form action={pullWeek}>
                        <input type="hidden" name="weekStart" value={g.weekStart} />
                        <button className="rounded-md border border-line px-2 py-1 text-xs hover:bg-ground" disabled={running}>
                          Fetch this week
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/*
        Earlier weeks of this year, and nothing older.

        The weekly pull only ever carries this week. The 2026 dataset holds every weekly file CMS
        has published this year, so one download fills in the weeks between 1 July — when the
        Kansas floor took effect — and the first weekly pull. That is the only back-fill anyone
        will ever need: no claim before 1 July can have been paid under the floor, and the claim
        history starts from scratch. It is deliberately one quiet button rather than a row of
        years.
      */}
      {/*
        Where the ids come from. The yearly dataset gets a new id every January; a site that only
        knew last year's would offer an archive that no longer exists, or fetch the wrong one, and
        say nothing. So the listing is read once a week and what it said is shown here.
      */}
      <Card title="What data.medicaid.gov calls these files" className="my-4">        {datasets ? (
          <p className="mt-1 text-sm text-ink-2">
            Read {new Date(datasets.readAt).toLocaleDateString()}: {datasets.weekly ? "the current weekly file" : "no current weekly file"}
            {Object.keys(datasets.years).length ? `, and yearly archives for ${Object.keys(datasets.years).sort().reverse().join(", ")}` : ", and no yearly archives"}.
            The addresses used above follow this, so a dataset CMS renumbers in January is picked up without anybody editing anything.
          </p>
        ) : (
          <p className="mt-1 text-sm text-ink-2">
            The dataset listing has not been read yet, so only the built-in addresses are in use. Reading it is one small
            request and needs no account.
          </p>
        )}
        <form action={refreshDatasets} className="mt-2">
          <button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-ground" disabled={running}>Read the listing now</button>
        </form>
      </Card>

      {/* Three more ways in, needed once in a while: the archive for back weeks, a pasted address, a file by hand. */}
      <details className="my-4">
        <summary className="cursor-pointer text-sm font-semibold">Other ways to load a file <span className="font-normal text-ink-3">— earlier weeks, a pasted address, or by hand</span></summary>
      <Card className="my-4">
        <h2 className="text-sm font-semibold">Earlier weeks of {years[0]}</h2>
        <p className="mt-1 text-sm text-ink-2">
          Only needed to price claims filled <b>before the first weekly pull</b>. The floor took effect on 1 July
          2026, so nothing earlier than that is ever wanted, and once the weekly fetch has been running there is no
          reason to press this again.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {years.map((y) => (
            <form key={y} action={pullYear}>
              <input type="hidden" name="year" value={y} />
              <button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-ground" disabled={running}>
                Fetch the {y} archive
              </button>
            </form>
          ))}
          <span className="text-xs text-ink-3">
            A large file: it runs in the background and takes several minutes. The panel above shows it going.
          </span>
        </div>
      </Card>

      <Card title="Load one file from an address" className="my-4">        <p className="mt-1 text-sm text-ink-2">
          For back files. Find the week you need on <code>data.medicaid.gov</code>, copy the link to its CSV, and
          paste it here — it is loaded through exactly the same checks as the automatic pull, so a page that is not a
          NADAC file is refused rather than saved.
        </p>
        <form action={pullFrom} className="mt-3 flex flex-wrap items-center gap-2">
          <input name="url" placeholder="https://download.medicaid.gov/…" className="field flex-1 font-mono text-xs" />
          <button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-ground">Fetch it</button>
        </form>
      </Card>

      <Card title="Or load files by hand" className="my-4">        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink-2">
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
          <button className="btn btn-primary">Load</button>
        </form>
        <p className="mt-2 text-xs text-ink-3">
          A CMS weekly file is about thirty thousand rows and takes a couple of seconds. The page will not respond
          while it works — if you have several weeks to load, do them a few at a time rather than all at once.
        </p>
        <p className="mt-2 text-xs text-ink-3">
          Files can also be copied straight into <code>{nadacDir()}</code> and loaded from here.
        </p>
      </Card>
      </details>

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
                  <details className="mt-6">
                  <summary className="cursor-pointer text-sm font-semibold">Drugs with no NADAC in force <span className="font-normal text-ink-3">— {claimCov.missing.length}, most claimed first</span></summary>
                  <p className="mb-2 mt-1 text-xs text-ink-3">
                    Usually means the weekly file covering that fill date has not been loaded. Some products genuinely
                    have no NADAC — CMS does not price everything.
                  </p>
                  <div className="overflow-x-auto">
                    <table className="table">
                      <thead>
                        <tr><th>NDC</th><th>Drug</th><th className="text-right">Claims</th></tr>
                      </thead>
                      <tbody>
                        {claimCov.missing.slice(0, 40).map((m) => (
                          <tr key={m.ndc11}>
                            <td className="font-mono text-xs">{m.ndc11}</td>
                            <td>{m.itemName ?? "—"}</td>
                            <td className="text-right tabular-nums">{m.claims}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  </details>
                </>
              )}
            </>
          )}

          <h2 className="mt-8 text-sm font-semibold">Weeks loaded</h2>
          {cov.weeks.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr><th>Effective date</th><th className="text-right">Prices</th></tr>
                </thead>
                <tbody>
                  {cov.weeks.map((w) => (
                    <tr key={w.effectiveOn}>
                      <td>{w.effectiveOn}</td>
                      <td className="text-right tabular-nums">{Number(w.n).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <ExportData page="nadac" className="mt-6" />
    </>
  );
}

/*
 * The page's own tile, which is now the shared one wearing this page's prop names.
 *
 * It drew its own amber and emerald straight from Tailwind's palette rather than the theme's
 * tokens, so a change to what "needs attention" looks like reached every screen except the five
 * that had quietly forked it. The signature is kept so nothing at the call sites has to move.
 */
function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" | "ok" }) {
  return <Figure value={value} label={label} tone={tone ?? "muted"} />;
}
