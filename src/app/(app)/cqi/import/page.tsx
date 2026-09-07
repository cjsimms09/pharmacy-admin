import Link from "next/link";
import { db } from "@/db";
import { requireManager } from "@/lib/auth";
import { hasApiKey } from "@/lib/ai";
import { PageHeader, BackLink, Notice, Field } from "@/components/ui";
import { importPacket } from "../ai-actions";

export const metadata = { title: "Import CQI packets" };

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireManager();
  const { error } = await searchParams;
  const configured = await hasApiKey();
  const imports = await db.query.cqiImports.findMany({ orderBy: (i, { desc }) => [desc(i.createdAt)] });
  return (
    <>
      <BackLink href="/cqi">CQI program</BackLink>
      <PageHeader title="Import previous CQI packets" subtitle="Upload a scanned C-550 with its C-650s. Claude reads it and turns it into incidents, corrective action plans, and CAP reviews. You check everything before it's saved." />
      {error && <Notice kind="crit">{error}</Notice>}
      {!configured && <Notice kind="warn">Claude isn't set up yet. Add your Anthropic API key under <Link href="/settings" className="underline">Settings → Claude</Link> first.</Notice>}

      <section className="card mb-6 max-w-2xl">
        <form action={importPacket} encType="multipart/form-data" className="grid gap-3">
          <Field label="Scanned packet (PDF)" hint="One summary period per file works best. Large scans can take a minute or two to read.">
            <input name="file" type="file" className="field" accept="application/pdf,.pdf" required />
          </Field>
          <p className="text-xs text-ink-3">The scan is sent to Anthropic's API to be read. It contains prescription numbers and staff names but no patient identities. Anthropic does not train on API data.</p>
          <div><button className="btn btn-primary" disabled={!configured}>Read with Claude</button></div>
        </form>
      </section>

      {imports.length > 0 && (
        <section className="card max-w-2xl">
          <h2 className="mb-3 font-semibold">Previous imports</h2>
          <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>When</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {imports.map((i) => (
                <tr key={i.id}>
                  <td className="text-xs">{i.createdAt.slice(0, 16).replace("T", " ")}</td>
                  <td><span className={`badge ${i.status === "applied" ? "badge-ok" : i.status === "failed" ? "badge-crit" : "badge-warn"}`}>{i.status}</span>{i.error && <div className="text-xs text-crit">{i.error}</div>}</td>
                  <td>{i.status === "extracted" && <Link href={`/cqi/import/${i.id}`} className="text-xs text-accent hover:underline">Review</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </section>
      )}
    </>
  );
}
