import Link from "next/link";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { requireManager } from "@/lib/auth";
import { fmt } from "@/lib/dates";
import { PageHeader, Notice, Empty, Field } from "@/components/ui";
import { CREDENTIAL_TYPES } from "@/db/schema";
import { CREDENTIAL_LABEL } from "@/lib/labels";
import { hasApiKey, type ClassifiedDocT } from "@/lib/ai";
import { dropFiles } from "./actions";
import { DropZone } from "./drop-zone";

export const metadata = { title: "Add documents" };
export const dynamic = "force-dynamic";

export default async function IntakePage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; done?: string }> }) {
  await requireManager();
  const { error, saved, done } = await searchParams;
  const [items, docs, aiReady, people] = await Promise.all([
    db.query.intakeItems.findMany({ orderBy: (i, { desc }) => [desc(i.createdAt)], limit: 60 }),
    db.query.documents.findMany(),
    hasApiKey(),
    db.query.people.findMany({ where: eq(schema.people.active, true), orderBy: (p, { asc }) => [asc(p.lastName)] }),
  ]);
  const pending = items.filter((i) => i.status === "extracted");
  const failed = items.filter((i) => i.status === "failed");
  const docOf = (id: string) => docs.find((d) => d.id === id);

  return (
    <>
      <PageHeader
        title="Add documents"
        subtitle="Drop anything in — a licence, a CPR card, a training certificate, a signed form. Claude reads it, works out what it is and whose it is, and fills in the dates. You check it before it is filed."
      />
      {error && <Notice kind="crit">{error}</Notice>}
      {saved && <Notice>{done ? "Filed. Nothing else is waiting." : "Filed."}</Notice>}

      {!aiReady && (
        <Notice kind="warn">
          Add your Anthropic API key under <Link href="/settings/connections" className="underline">Settings → Connections</Link> to have dropped files read and sorted. Until then, upload documents from the page they belong to.
        </Notice>
      )}

      {aiReady && (
        <section className="card mb-6">
          <form action={dropFiles} encType="multipart/form-data" className="flex flex-col gap-3">
            <DropZone />

            {/*
              Optional, and only worth filling in for a stack that shares an answer — one person's
              renewals, or a set of the same certificate. Claude works both out from the document
              itself; saying it here just saves correcting the same field on every file.
            */}
            <details>
              <summary className="cursor-pointer text-xs text-ink-3">
                Tell Claude what these are, if they all share an answer (optional)
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Whose are they?" hint="Leave blank to let each document say.">
                  <select name="hintPersonId" className="field" defaultValue="">
                    <option value="">— read it off each document —</option>
                    {people.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
                  </select>
                </Field>
                <Field label="What are they?" hint="Leave blank to let each document say.">
                  <select name="hintCredentialType" className="field" defaultValue="">
                    <option value="">— read it off each document —</option>
                    {CREDENTIAL_TYPES.map((t) => <option key={t} value={t}>{CREDENTIAL_LABEL[t]}</option>)}
                  </select>
                </Field>
              </div>
            </details>

            <div className="flex flex-wrap items-center gap-3">
              <button className="btn btn-primary" type="submit">Read and sort</button>
              <span className="text-xs text-ink-3">PDFs and photos. Several at once is fine — about half a minute each.</span>
            </div>
          </form>
        </section>
      )}

      {failed.length > 0 && (
        <section className="card mb-6 border-crit">
          <h2 className="font-semibold text-crit">{failed.length} could not be read</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {failed.map((i) => (
              <li key={i.id}>
                <Link href={`/intake/${i.id}`} className="text-accent hover:underline">{docOf(i.documentId)?.fileName ?? "file"}</Link>
                {i.error && <span className="text-ink-2"> — {i.error}</span>}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-3">The files are safely in the vault. Open one to try again or file it by hand.</p>
        </section>
      )}

      <section className="card">
        <h2 className="mb-1 font-semibold">Waiting for you to check ({pending.length})</h2>
        <p className="mb-3 text-xs text-ink-3">Nothing here has been filed yet. Open each one, correct anything Claude got wrong, and file it.</p>
        {pending.length === 0 ? (
          <Empty>Nothing waiting. Drop a file above and it appears here.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {pending.map((i) => {
              const r = safeParse(i.resultJson);
              const doc = docOf(i.documentId);
              return (
                <li key={i.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/intake/${i.id}`} className="font-medium text-accent hover:underline">{r?.title || doc?.fileName || "Document"}</Link>
                    <div className="text-xs text-ink-2">
                      {r?.personName ? `${r.personName} · ` : ""}
                      {r?.expiresOn ? `expires ${fmt(r.expiresOn)} · ` : ""}
                      {doc?.fileName}
                    </div>
                  </div>
                  {r && r.confidence < 0.6 && <span className="badge badge-warn">check carefully</span>}
                  <Link href={`/intake/${i.id}`} className="btn">Check and file</Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

function safeParse(json: string): ClassifiedDocT | null {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && "kind" in v ? (v as ClassifiedDocT) : null;
  } catch {
    return null;
  }
}
