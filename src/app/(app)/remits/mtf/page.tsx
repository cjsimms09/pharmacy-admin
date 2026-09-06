import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { testMtf, downloadMtf, mtfStatus, saveCliLocation, findCli } from "@/lib/mtf";
import { getSettings } from "@/lib/settings";
import { requireReimbursement } from "@/lib/features";
import { PageHeader, Notice, Field, Empty, BackLink } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { formatCents } from "@/lib/money";

export const metadata = { title: "Medicare MFP refunds" };
export const dynamic = "force-dynamic";

const iso = (d: Date) => d.toISOString().slice(0, 10);

export default async function MtfPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; out?: string; found?: string }> }) {
  await requireReimbursement();
  await requireManager();
  const { ok, error, out, found } = await searchParams;
  const candidates = (found ?? "").split("|").filter(Boolean);
  const s = await mtfStatus();
  const settings = await getSettings();
  const { facilitatorMoney } = await import("@/lib/claim-payments");
  const money = await facilitatorMoney("mtf");

  const today = new Date();
  const ninetyAgo = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);

  async function test() {
    "use server";
    const u = await requireManager();
    const r = await testMtf();
    await audit({ action: "mtf.test", userId: u.id, userName: u.name, details: r.message.slice(0, 200) });
    revalidatePath("/remits/mtf");
    const q = new URLSearchParams(r.ok ? { ok: r.message } : { error: r.message });
    if (r.output) q.set("out", r.output.slice(0, 4000));
    redirect("/remits/mtf?" + q.toString());
  }

  async function pull(fd: FormData) {
    "use server";
    const u = await requireManager();
    const from = String(fd.get("from") ?? "");
    const to = String(fd.get("to") ?? "");
    const r = await downloadMtf(from, to, fd.get("onlyNew") === "on");
    await audit({ action: "mtf.download", userId: u.id, userName: u.name, details: `${from}..${to} — ${r.message}`.slice(0, 200) });
    revalidatePath("/remits/mtf");
    const q = new URLSearchParams(r.ok ? { ok: r.message } : { error: r.message });
    if (r.output) q.set("out", r.output.slice(0, 4000));
    redirect("/remits/mtf?" + q.toString());
  }

  /**
   * Looks for the tool rather than telling somebody where it "usually" is.
   *
   * A guess dressed as instruction, when wrong, produces an error repeating the same wrong path
   * back at the person. The computer knows where the file is; it can look.
   */
  async function locate() {
    "use server";
    await requireManager();
    const r = await findCli();
    revalidatePath("/remits/mtf");
    if (r.found.length === 0) {
      redirect(
        "/remits/mtf?error=" +
          encodeURIComponent(
            `Nothing named mtf-cli was found under your user folder, Downloads, Desktop or Documents. If you extracted it somewhere else — another drive, or a shared folder — open that folder, find the file, and paste its full path in below. Looked in ${r.searched.length} folders.`,
          ),
      );
    }
    redirect("/remits/mtf?found=" + encodeURIComponent(r.found.join("|")));
  }

  /** The whole cycle at once — fetch, read, post — for somebody who does not want to wait a day. */
  async function runNow() {
    "use server";
    const u = await requireManager();
    const { mtfCycle } = await import("@/lib/mtf");
    const r = await mtfCycle(u);
    await audit({ action: "mtf.cycle", userId: u.id, userName: u.name, details: r.message.slice(0, 200) });
    revalidatePath("/remits/mtf");
    revalidatePath("/claims");
    revalidatePath("/money");
    redirect("/remits/mtf?" + new URLSearchParams(r.ran ? { ok: r.message } : { error: r.message }).toString());
  }

  /** Records where the tool is, checks it runs, and points its downloads at the folder this reads. */
  async function saveWhere(fd: FormData) {
    "use server";
    const u = await requireManager();
    const r = await saveCliLocation(String(fd.get("cliPath") ?? ""), String(fd.get("downloadDir") ?? ""));
    await audit({ action: "mtf.configure", userId: u.id, userName: u.name, details: r.message.slice(0, 200) });
    revalidatePath("/remits/mtf");
    redirect("/remits/mtf?" + new URLSearchParams(r.ok ? { ok: r.message } : { error: r.message }).toString());
  }

  /**
   * Reads what has been downloaded, and puts the money against the fills it belongs to.
   *
   * The step that was missing between a folder of 835 files and a claim that knows it was paid.
   * Downloading them was already possible; nothing read them, so a fill a facilitator paid $146.18
   * on sat on the loss list for ever and the plan that underpaid it was judged on money it never
   * sent.
   */
  async function readThem() {
    "use server";
    const u = await requireManager();
    const { sweepRemittances } = await import("@/lib/claim-payments");
    const r = await sweepRemittances(u);
    await audit({ action: "mtf.read", userId: u.id, userName: u.name, details: `${r.payments} payments, ${r.amountCents}c` });
    revalidatePath("/remits/mtf");
    revalidatePath("/claims");
    revalidatePath("/payers/performance");
    revalidatePath("/money");
    redirect(
      "/remits/mtf?" +
        new URLSearchParams(
          r.files === 0
            ? { error: "No files are in the download folder yet. Download some above, or point the CLI's download directory at that folder." }
            : {
                ok:
                  `${r.read} remittance${r.read === 1 ? "" : "s"} read: ` +
                  `${r.payments} payment${r.payments === 1 ? "" : "s"} worth ` +
                  `$${(r.amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. ` +
                  `${r.matched} matched a claim we hold` +
                  (r.unmatched ? `, ${r.unmatched} name a prescription not loaded yet and will attach themselves when it arrives` : "") +
                  "." +
                  (r.problems.length ? ` ${r.problems[0]}` : ""),
              },
        ).toString(),
    );
  }

  return (
    <>
      <BackLink href="/settings/connections">Connections</BackLink>
      <PageHeader
        title="Medicare MFP refunds"
        subtitle="835 remittance files from the Medicare Transaction Facilitator, for Maximum Fair Price refunds on selected Part D drugs."
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {/*
        What has actually come out of this channel.

        The payments land on individual fills, which is right for working out whether a fill made
        money and useless for the question asked at the end of a month. Counted by the date the
        money was received rather than the date the prescription was filled: a remittance settles
        weeks after the fill, so counting by fill date would credit this month's receipts to a month
        that closed long ago and the figure would never agree with the bank.
      */}
      <section className="my-4 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">What this has brought in</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <Money value={money.monthToDateCents} label="This month so far" sub={`${money.monthToDatePayments} payment${money.monthToDatePayments === 1 ? "" : "s"}`} strong />
          <Money value={money.lastMonthCents} label="Last month" sub="The whole of it" />
          <Money value={money.allTimeCents} label="Since this started" sub={`${money.allTimePayments} payment${money.allTimePayments === 1 ? "" : "s"}`} />
          <Money
            value={money.unmatchedCents}
            label="Not yet on a claim"
            sub={money.unmatched ? `${money.unmatched} name a prescription not loaded` : "All of it is matched"}
            warn={money.unmatched > 0}
          />
        </div>
        {money.undatedCents > 0 && (
          <p className="mt-2 text-xs text-warn">
            {formatCents(money.undatedCents)} carried no payment date on its remittance, so it is in the total but in no
            month. It is counted once, not twice.
          </p>
        )}

        {money.thisMonth.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
                <tr>
                  <th className="px-3 py-2">Prescription</th>
                  <th className="px-3 py-2">Drug</th>
                  <th className="px-3 py-2">Received</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Trace</th>
                </tr>
              </thead>
              <tbody>
                {money.thisMonth.map((p, i) => (
                  <tr key={`${p.rxNumber}-${i}`} className="border-t border-line">
                    <td className="px-3 py-2 font-mono text-xs">
                      {p.rxNumber}
                      {p.dateFilled && <span className="block text-ink-3">filled {p.dateFilled}</span>}
                    </td>
                    <td className="px-3 py-2 text-xs">{p.itemName ?? p.ndc11 ?? <span className="text-warn">not on a claim we hold</span>}</td>
                    <td className="px-3 py-2 text-xs">{p.receivedOn ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCents(p.amountCents)}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-ink-3">{p.reference ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-ink-3">
              Every line carries the trace number from its remittance, which is what finds the deposit on a bank
              statement.
            </p>
          </div>
        )}

        {money.months.length > 1 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-ink-3 hover:text-accent">Month by month</summary>
            <table className="mt-1 w-full max-w-md text-sm">
              <tbody>
                {money.months.map((m) => (
                  <tr key={m.month} className="border-t border-line">
                    <td className="py-1.5">{m.month}</td>
                    <td className="py-1.5 text-right text-xs text-ink-3">{m.payments} payment{m.payments === 1 ? "" : "s"}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatCents(m.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}

        {money.allTimePayments === 0 && (
          <p className="mt-2 text-sm text-ink-2">
            Nothing has been received yet. That is a normal answer — CMS issues these only for selected Part D drugs at
            their Maximum Fair Price, and only once a qualifying fill has been adjudicated.
          </p>
        )}
      </section>

      {s.hasKey && s.keyDaysLeft !== null && s.keyDaysLeft <= 15 && (
        <Notice kind={s.keyDaysLeft <= 0 ? "crit" : "warn"}>
          {s.keyDaysLeft <= 0
            ? `This API key was stored ${s.keySetOn} and MTF keys last 90 days, so it has expired. Generate a new one in the portal and paste it in.`
            : `This API key expires in about ${s.keyDaysLeft} days — MTF keys last 90 days from generation. Generate a replacement before it lapses.`}
        </Notice>
      )}

      {!s.hasKey && (
        <Notice kind="warn">
          No MTF API key stored yet. Add it in Settings → Connections first — generate it in the MTF portal under
          Developer Tools → API key → Generate, and copy it straight away, because generating a new key cancels the
          previous one and the portal will not show it again.
        </Notice>
      )}

      {/*
        Where the tool is, typed in.

        The path was a setting with no field, so the only way in was editing the system PATH — an
        environment variable, a reopened terminal, and a failure mode ("mtf-cli is not recognised")
        that reads as the software being broken.
      */}
      <section className="my-4 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Where the tool is</h2>
        <p className="mt-1 text-xs text-ink-2">
          Paste the full path to the program, including the file name. On Windows, extracting the download into your
          user folder puts it at <code>C:\Users\&lt;your user&gt;\mtf-cli\bin\mtf-cli.exe</code>. You do not need to
          touch the system PATH.
        </p>
        <form action={locate} className="mt-2">
          <button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-ground">Find it for me</button>
          <span className="ml-2 text-xs text-ink-3">
            Looks under your user folder, Downloads, Desktop and Documents. Nothing is changed — it only reports what it
            finds.
          </span>
        </form>

        {candidates.length > 0 && (
          <div className="mt-3 rounded-md border border-accent bg-accent-soft p-3 text-xs">
            <p className="font-semibold text-accent">
              Found {candidates.length === 1 ? "it" : `${candidates.length} of them`}. Use the one below, or copy the path
              you want into the box.
            </p>
            <ul className="mt-1 space-y-1 font-mono">
              {candidates.map((c) => <li key={c}>{c}</li>)}
            </ul>
          </div>
        )}

        <form action={saveWhere} className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Program">
            <input
              name="cliPath"
              className="w-full rounded-md border border-line px-3 py-2 font-mono text-xs"
              defaultValue={settings.mtf_cli_path ?? ""}
              placeholder="C:\Users\wwfprx\mtf-cli\bin\mtf-cli.exe"
            />
          </Field>
          <Field label="Download folder" hint="Leave blank to use the folder beside this site's database, which is what it reads.">
            <input
              name="downloadDir"
              className="w-full rounded-md border border-line px-3 py-2 font-mono text-xs"
              defaultValue={settings.mtf_download_dir ?? ""}
              placeholder={s.dir}
            />
          </Field>
          <div className="sm:col-span-2">
            <button className="rounded-md bg-ink px-3 py-2 text-sm text-white">Save and check it runs</button>
            <span className="ml-2 text-xs text-ink-3">
              It is run once to prove it is really there, and the stored API key is written into it so a scheduled
              download uses the same key and the same folder.
            </span>
            <p className="mt-2 text-xs text-ink-2">
              If you set up a scheduled download in Task Scheduler, set its <b>Start in</b> box to{" "}
              <code>{process.cwd()}</code>. Version 2.2.0 of the tool works out its download folder by joining what it
              was given onto whatever folder it was started in, so a task started somewhere else puts the files
              somewhere else and this page finds nothing.
            </p>
          </div>
        </form>
      </section>

      <div className="my-4 grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold">Test the connection</h2>
          <p className="mt-1 text-xs text-ink-3">
            Before this can work, the MTF portal's Developer Tools page must have <b>Enable report downloads</b>
            switched on. Without it CMS answers 404 even with a valid key. That page also has a
            <b> Generate test file</b> button, which puts a file in the mailbox so a search has something to find.
          </p>
          <p className="mt-1 text-sm text-ink-2">
            Asks MTF what 835 files exist for the last 90 days. It only looks — nothing is downloaded and nothing
            changes — so it is safe to run whenever you want to check the key still works.
          </p>
          <p className="mt-2 text-xs text-ink-3">
            If it comes back saying the key works but no files exist, that is a normal answer. It means CMS has not
            issued any MFP refunds to us yet, not that anything is broken.
          </p>
          <form action={test} className="mt-3">
            <button className="rounded-md bg-ink px-3 py-2 text-sm text-white" disabled={!s.hasKey}>
              Test connection
            </button>
          </form>
        </section>

        <section className="rounded-lg border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold">Download 835 files</h2>
          <form action={pull} className="mt-3 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="From"><input name="from" type="date" defaultValue={iso(ninetyAgo)} className="w-full rounded-md border border-line px-3 py-2 text-sm" /></Field>
              <Field label="To"><input name="to" type="date" defaultValue={iso(today)} className="w-full rounded-md border border-line px-3 py-2 text-sm" /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="onlyNew" defaultChecked /> Only files we have not already taken
            </label>
            <button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-ground" disabled={!s.hasKey}>
              Download
            </button>
          </form>
        </section>
      </div>

      {/*
        What happens without anybody here.

        Downloading and reading were two buttons, which means the money only arrives when somebody
        remembers to go and get it — and the reason these payments were invisible for so long is
        that nobody was going to check a portal every day.
      */}
      <section className="mb-4 rounded-lg border border-accent bg-surface p-4">
        <h2 className="text-sm font-semibold">This runs on its own</h2>
        <p className="mt-1 text-sm text-ink-2">
          Once a day the site fetches anything new, reads it, and posts each payment onto the fill it names. It looks
          three weeks back every time, because CMS publishes a remittance days after the fill and not on a schedule —
          asking only for today would miss a late one for ever. Nothing is fetched twice: the tool skips files it has
          taken and this site skips payments it has already posted.
        </p>
        <p className="mt-1 text-xs text-ink-3">
          {s.lastPull ? (
            <>
              Last run {new Date(s.lastPull).toLocaleString()}
              {s.lastResult ? ` — ${s.lastResult}` : ""}
            </>
          ) : (
            "It has not run yet. It starts within a few minutes of the site starting up, and the buttons below do the same thing by hand."
          )}
        </p>
        <form action={runNow} className="mt-3">
          <SubmitButton className="rounded-md bg-ink px-3 py-2 text-sm text-white" pendingLabel="Fetching and posting…">
            Do it now rather than waiting
          </SubmitButton>
        </form>
      </section>

      <section className="mb-4 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Put the money against the claims</h2>
        <p className="mt-1 text-sm text-ink-2">
          Reads every 835 in the folder below and records what each one paid against the prescription it names. The
          money is added to that fill&rsquo;s revenue and kept apart from what the plan itself paid, so a facilitator
          payment can never flatter the plan that underpaid.
        </p>
        <p className="mt-1 text-xs text-ink-3">
          Safe to run again: a payment is identified by the remittance&rsquo;s trace number and the claim&rsquo;s own
          reference, so re-reading a file changes nothing — which matters, because a scheduled download re-fetches the
          same days. A payment for a prescription not yet loaded is kept and attaches itself when the claim arrives.
        </p>
        <form action={readThem} className="mt-3">
          <button className="rounded-md bg-ink px-3 py-2 text-sm text-white">Read the files and post the payments</button>
        </form>
      </section>

      <section className="rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Files we hold</h2>
        <p className="mt-1 text-xs text-ink-3">
          Saved to <code>{s.dir}</code>
          {s.lastPull && <> · last run {new Date(s.lastPull).toLocaleString()}{s.lastResult ? ` — ${s.lastResult}` : ""}</>}
        </p>
        {s.files.length === 0 ? (
          <div className="mt-3"><Empty>No 835 files yet.</Empty></div>
        ) : (
          <ul className="mt-3 divide-y divide-line text-sm">
            {s.files.map((f) => <li key={f} className="py-1.5 font-mono text-xs">{f}</li>)}
          </ul>
        )}
      </section>

      {out && (
        <details className="mt-4 rounded-lg border border-line bg-surface p-4" open={Boolean(error)}>
          <summary className="cursor-pointer text-sm font-medium">What the MTF tool said</summary>
          <p className="mt-2 text-xs text-ink-3">
            The exact output from the tool. If something went wrong, this is what to send to MTF support or to
            paste back here — it usually names the address it called and what came back.
          </p>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs text-ink-2">{out}</pre>
        </details>
      )}

      <section className="mt-8 rounded-lg border border-line bg-surface p-4 text-sm">
        <h2 className="text-sm font-semibold">What this does and does not cover</h2>
        <p className="mt-2 text-ink-2">
          MTF carries Maximum Fair Price refunds only — the difference CMS refunds on the selected drugs subject to
          the negotiated price. It is not a source for ordinary Part D payments and carries nothing commercial. Those
          still come through Health Mart Atlas central pay and the payers directly.
        </p>
        <p className="mt-2 text-ink-2">
          Setting it up needs the MTF command-line tool installed on this machine. It downloads from the same
          Developer Tools page as the API key. Once it is installed, everything on this page works without a command
          prompt.
        </p>
      </section>
    </>
  );
}

/** A money figure, sized so the month-to-date one is the thing seen first. */
function Money({ value, label, sub, strong, warn }: { value: number; label: string; sub?: string; strong?: boolean; warn?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${warn && value > 0 ? "border-warn" : "border-line"}`}>
      <div className={`text-2xl font-bold leading-none tabular-nums ${strong ? "text-accent" : value === 0 ? "text-ink-3" : "text-ink"}`}>
        {formatCents(value)}
      </div>
      <div className="mt-1.5 text-xs font-semibold">{label}</div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}
