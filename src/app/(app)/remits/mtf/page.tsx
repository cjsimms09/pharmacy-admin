import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { testMtf, downloadMtf, mtfStatus } from "@/lib/mtf";
import { requireReimbursement } from "@/lib/features";
import { PageHeader, Notice, Field, Empty, BackLink } from "@/components/ui";

export const metadata = { title: "Medicare MFP refunds" };
export const dynamic = "force-dynamic";

const iso = (d: Date) => d.toISOString().slice(0, 10);

export default async function MtfPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; out?: string }> }) {
  await requireReimbursement();
  await requireManager();
  const { ok, error, out } = await searchParams;
  const s = await mtfStatus();

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

  return (
    <>
      <BackLink href="/settings/connections">Connections</BackLink>
      <PageHeader
        title="Medicare MFP refunds"
        subtitle="835 remittance files from the Medicare Transaction Facilitator, for Maximum Fair Price refunds on selected Part D drugs."
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

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
