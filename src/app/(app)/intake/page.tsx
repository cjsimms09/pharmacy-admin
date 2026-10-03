import { familyTabs } from "@/lib/families";
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
import { FILE_KINDS } from "./kinds";
import { describeBusinessDoc, type BusinessDocT } from "@/lib/business-docs";
import { KIND_LABEL as BUSINESS_LABEL } from "./[id]/business-review";

export const metadata = { title: "Add documents" };
export const dynamic = "force-dynamic";

export default async function IntakePage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; done?: string; outcome?: string; where?: string }> }) {
  await requireManager();
  const { error, saved, done, outcome, where } = await searchParams;
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
        tabs={familyTabs("arrivals", "/intake")}
        title="Add documents"
        subtitle="Drop in or photograph anything the business runs on — a wholesaler's invoice, a supply bill, the electricity bill, a remittance advice, a rebate statement, a licence or a certificate. Claude reads it, says what it is and who it is from, and fills in the figures; you check the card and file it where the money goes."
      />
      {error && <Notice kind="crit">{error}</Notice>}
      {saved && (
        <Notice>
          {outcome ?? "Filed."}{" "}
          {where && <Link href={where} className="underline">See it there</Link>}
          {done ? " Nothing else is waiting." : ""}
        </Notice>
      )}

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
              What is this? — asked before the guess rather than after it.

              The owner uploaded a balance-on-hand report and had no way to say so: "no way to tell
              system that's what this is in the add tool. need many more options!!!" The optional
              block below offered a person and a credential type, which are the two things a
              wholesaler's catalogue is not.

              Out in the open rather than behind the "optional" fold, because the fold is for
              refinements and this is the question. Left on "let the site work it out" it behaves
              exactly as it did.
            */}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="What is this?" hint="Naming it skips the guess. Leave it and the site reads the file to find out.">
                <select name="hintKind" className="field" defaultValue="">
                  {FILE_KINDS.map((k) => (
                    <option key={k.key} value={k.key}>{k.label}</option>
                  ))}
                </select>
              </Field>
              {/*
                Shown always rather than only for a count, because a select that reveals a field is
                a select somebody has to discover. The hint says who it is for, and it is ignored
                for every other kind.
              */}
              <Field
                label="If it is a count, which day is it for?"
                hint="Leave blank to use the date the report prints on itself. Only a count needs this."
              >
                <input type="date" name="hintCountedOn" className="field" defaultValue="" />
              </Field>
            </div>

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
              <span className="text-xs text-ink-3">PDFs, photos and 835 files. Several at once is fine — about half a minute each. On a phone, &ldquo;Take a photo&rdquo; opens the camera.</span>
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
              const b = safeBusiness(i.resultJson);
              const doc = docOf(i.documentId);
              return (
                <li key={i.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/intake/${i.id}`} className="font-medium text-accent hover:underline">{b ? b.summary : r?.title || doc?.fileName || "Document"}</Link>
                    <div className="text-xs text-ink-2">
                      {b ? `${describeBusinessDoc(b)} · ${BUSINESS_LABEL[b.kind]} · ` : ""}
                      {r?.personName ? `${r.personName} · ` : ""}
                      {r?.expiresOn ? `expires ${fmt(r.expiresOn)} · ` : ""}
                      {doc?.fileName}
                    </div>
                  </div>
                  {((r && r.confidence < 0.6) || (b && b.confidence < 0.6)) && <span className="badge badge-warn">check carefully</span>}
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

function safeBusiness(json: string): BusinessDocT | null {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && v.kind === "business" && v.doc ? (v.doc as BusinessDocT) : null;
  } catch {
    return null;
  }
}

function safeParse(json: string): ClassifiedDocT | null {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && "kind" in v ? (v as ClassifiedDocT) : null;
  } catch {
    return null;
  }
}
