import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { register, upsert, remove, registerStatus } from "@/lib/business-associates";
import { storeFile } from "@/lib/files";
import { newId } from "@/lib/crypto";
import { db, schema } from "@/db";
import { fmt, todayIso } from "@/lib/dates";
import { PageHeader, Card, Figure, Notice, Field, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agreements" };

/**
 * Every outside party that can see patient information, and the paper that lets them.
 *
 * HIPAA requires an agreement with each of them — 45 CFR 164.502(e) — and the failure is never
 * that nobody signed one. It is that three years later nobody can find it, or it lapsed and the
 * relationship carried on regardless, and the first anyone hears of either is during a breach
 * investigation, at the most expensive possible moment to find out.
 *
 * Two kinds live here and the difference matters. A business associate agreement covers a vendor
 * doing something on the pharmacy's behalf. A school affiliation agreement is not one: the
 * students are working under this pharmacy's supervision and count as its workforce for HIPAA
 * purposes, which means they need training and supervision rather than a BAA. Recording it here
 * anyway is right — it is the paper that has to be produced — but calling it the wrong thing is
 * how a pharmacy ends up believing a document protects it in a way it does not.
 */
export default async function AgreementsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; edit?: string }>;
}) {
  await requireUser();
  const { ok, error, edit } = await searchParams;
  const [rows, status] = await Promise.all([register(), registerStatus()]);
  const editing = edit ? rows.find((r) => r.id === edit) : undefined;

  async function save(fd: FormData) {
    "use server";
    const u = await requireManager();
    try {
      let documentId: string | null = null;
      const file = fd.get("file");
      if (file instanceof File && file.size > 0) {
        const stored = await storeFile(file);
        documentId = newId();
        await db.insert(schema.documents).values({
          id: documentId,
          category: "agreement",
          title: `${String(fd.get("name") ?? "Agreement")} — signed agreement`,
          fileName: file.name.slice(0, 200),
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          storageKey: stored.storageKey,
          effectiveOn: String(fd.get("signedOn") ?? "") || todayIso(),
          expiresOn: String(fd.get("expiresOn") ?? "") || null,
          noExpiry: fd.get("noExpiry") === "on",
          uploadedBy: u.id,
        });
      }
      await upsert(
        {
          id: String(fd.get("id") ?? "") || undefined,
          name: String(fd.get("name") ?? ""),
          service: String(fd.get("service") ?? ""),
          contactName: String(fd.get("contactName") ?? ""),
          contactEmail: String(fd.get("contactEmail") ?? ""),
          signedOn: String(fd.get("signedOn") ?? ""),
          expiresOn: String(fd.get("expiresOn") ?? ""),
          noExpiry: fd.get("noExpiry") === "on",
          endedOn: String(fd.get("endedOn") ?? ""),
          notes: String(fd.get("notes") ?? ""),
          documentId,
        },
        u,
      );
      await audit({ action: "agreement.save", userId: u.id, userName: u.name, details: String(fd.get("name") ?? "") });
      revalidatePath("/agreements");
      revalidatePath("/");
      redirect("/agreements?ok=" + encodeURIComponent("Saved."));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/agreements?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not save that."));
    }
  }

  async function del(fd: FormData) {
    "use server";
    const u = await requireManager();
    await remove(String(fd.get("id") ?? ""));
    await audit({ action: "agreement.delete", userId: u.id, userName: u.name, details: String(fd.get("id") ?? "") });
    revalidatePath("/agreements");
    redirect("/agreements?ok=" + encodeURIComponent("Removed."));
  }

  const live = rows.filter((r) => !r.endedOn);
  const finished = rows.filter((r) => r.endedOn);

  return (
    <>
      <PageHeader
        title="Agreements"
        subtitle="Every outside party that can see patient information, and the signed paper that lets them."
        actions={<Link href="/documents" className="btn">Documents</Link>}
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure value={live.length} label="Current agreements" tone={live.length > 0 ? "ok" : "crit"} />
        <Figure
          value={status.problems}
          label="Need attention"
          sub={status.problems === 0 ? "Signed, attached and in date" : "Unsigned, unattached or lapsed"}
          tone={status.problems === 0 ? "ok" : "crit"}
        />
        <Figure
          value={live.filter((r) => r.documentId).length}
          label="Document attached"
          sub="Only an attached one can be produced on request"
          tone={live.length > 0 && live.every((r) => r.documentId) ? "ok" : "warn"}
        />
        <Figure value={finished.length} label="Ended" sub="Kept for their retention period" tone="muted" />
      </div>

      {rows.length === 0 ? (
        <Empty>
          Nothing recorded yet. Start with your software vendor, your shredding company, your PSAO and any school you
          take students from.
        </Empty>
      ) : (
        <Card title="The register" count={rows.length} subtitle={status.summary} className="mb-6">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr><th>Who</th><th>What they do</th><th>Signed</th><th>Runs to</th><th>Status</th><th>Agreement</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.endedOn ? "opacity-60" : ""}>
                    <td>
                      <div className="font-medium">{r.name}</div>
                      {r.contactName && <div className="text-xs text-ink-3">{r.contactName}{r.contactEmail ? ` · ${r.contactEmail}` : ""}</div>}
                    </td>
                    <td className="text-xs text-ink-2">{r.service ?? "—"}</td>
                    <td className="whitespace-nowrap text-xs">{r.signedOn ? fmt(r.signedOn) : <span className="text-crit">not signed</span>}</td>
                    <td className="whitespace-nowrap text-xs">
                      {r.endedOn ? `ended ${fmt(r.endedOn)}` : r.noExpiry ? "no end date" : r.expiresOn ? fmt(r.expiresOn) : "—"}
                    </td>
                    <td>
                      {r.endedOn ? (
                        <span className="badge badge-muted">ended</span>
                      ) : r.problem ? (
                        <span className="badge badge-crit" title={r.problem}>needs attention</span>
                      ) : (
                        <span className="badge badge-ok">in order</span>
                      )}
                      {r.problem && !r.endedOn && <div className="mt-1 text-xs text-crit">{r.problem}</div>}
                    </td>
                    <td className="text-xs">
                      {r.documentId ? (
                        <a href={`/files/${r.documentId}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">open</a>
                      ) : (
                        <span className="text-warn">not attached</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      <Link href={`/agreements?edit=${r.id}`} className="btn btn-sm">Edit</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title={editing ? `Edit ${editing.name}` : "Add an agreement"}>
        <form action={save} className="grid gap-3 sm:grid-cols-2" encType="multipart/form-data">
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <Field label="Who" hint="The vendor, school or partner.">
            <input name="name" className="field" required defaultValue={editing?.name ?? ""} placeholder="KU School of Pharmacy" />
          </Field>
          <Field label="What they do" hint="Why they can see patient information at all.">
            <input name="service" className="field" defaultValue={editing?.service ?? ""} placeholder="Student rotations · pharmacy software · shredding" />
          </Field>
          <Field label="Contact name"><input name="contactName" className="field" defaultValue={editing?.contactName ?? ""} /></Field>
          <Field label="Contact email"><input name="contactEmail" type="email" className="field" defaultValue={editing?.contactEmail ?? ""} /></Field>
          <Field label="Signed on"><input name="signedOn" type="date" className="field" defaultValue={editing?.signedOn ?? ""} /></Field>
          <Field label="Runs to" hint="Many agreements are evergreen. Tick below rather than leaving it blank — blank means nobody looked.">
            <input name="expiresOn" type="date" className="field" defaultValue={editing?.expiresOn ?? ""} />
            <label className="mt-1.5 flex items-center gap-2 text-xs">
              <input type="checkbox" name="noExpiry" defaultChecked={editing?.noExpiry ?? false} />
              This agreement has no end date
            </label>
          </Field>
          <Field label="Relationship ended on" hint="Leave blank while it is live. The agreement is kept either way.">
            <input name="endedOn" type="date" className="field" defaultValue={editing?.endedOn ?? ""} />
          </Field>
          <Field label="The signed agreement" hint="PDF or a scan. An agreement nobody can produce is not evidence of anything.">
            <input name="file" type="file" className="field" />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <textarea name="notes" rows={2} className="field" defaultValue={editing?.notes ?? ""} />
          </Field>
          <div className="flex gap-2 sm:col-span-2">
            <button className="btn btn-primary">{editing ? "Save" : "Add it"}</button>
            {editing && (
              <>
                <Link href="/agreements" className="btn">Cancel</Link>
                <button formAction={del} name="id" value={editing.id} className="btn btn-danger">Delete</button>
              </>
            )}
          </div>
        </form>
      </Card>
    </>
  );
}
