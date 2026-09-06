import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq, desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { todayIso, fmt } from "@/lib/dates";
import { storeFile } from "@/lib/files";
import { newId } from "@/lib/crypto";
import { parseQuantityThousandths } from "@/lib/money";
import { normalizeClaimNdc } from "@/lib/claims";
import { PageHeader, Notice, BackLink, Empty, Field } from "@/components/ui";

export const metadata = { title: "Inventory discrepancies" };
export const dynamic = "force-dynamic";

/** Thousandths back to a readable count: 90000 -> "90", 2500 -> "2.5". */
const qty = (n: number | null) => (n === null ? "—" : String(n / 1000));

export default async function DiscrepanciesPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; edit?: string }> }) {
  await requireUser();
  const { ok, error, edit } = await searchParams;
  const rows = await db.query.csDiscrepancies.findMany({ orderBy: [desc(schema.csDiscrepancies.discoveredOn)] });
  const open = rows.filter((r) => !r.resolvedOn);
  // An entry can be corrected after the fact; the audit log says it was, and by whom.
  const editing = edit ? rows.find((r) => r.id === edit) ?? null : null;

  async function log(fd: FormData) {
    "use server";
    const u = await requireManager();
    const drugName = String(fd.get("drugName") ?? "").trim();
    const narrative = String(fd.get("narrative") ?? "").trim();
    if (!drugName) redirect("/inventory/discrepancies?error=" + encodeURIComponent("Name the drug."));
    if (narrative.length < 10) redirect("/inventory/discrepancies?error=" + encodeURIComponent("Write down what happened — that account is the whole point of the log."));

    const existingId = String(fd.get("id") ?? "") || null;
    if (existingId && !(await db.query.csDiscrepancies.findFirst({ where: eq(schema.csDiscrepancies.id, existingId), columns: { id: true } }))) {
      redirect("/inventory/discrepancies?error=" + encodeURIComponent("That entry is no longer on file."));
    }
    const id = existingId ?? newId();
    const file = fd.get("file");
    if (file instanceof File && file.size > 0) {
      const stored = await storeFile(file, { allowReportTypes: true });
      await db.insert(schema.documents).values({
        id: newId(),
        category: "cs_discrepancy",
        title: `${drugName} — count discrepancy ${String(fd.get("discoveredOn") ?? todayIso())}`,
        fileName: file.name,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        storageKey: stored.storageKey,
        csDiscrepancyId: id,
        effectiveOn: String(fd.get("discoveredOn") ?? todayIso()),
        uploadedBy: u.id,
      });
    }

    const facts = {
      discoveredOn: String(fd.get("discoveredOn") ?? "") || todayIso(),
      drugName,
      ndc11: normalizeClaimNdc(String(fd.get("ndc") ?? "")),
      strength: String(fd.get("strength") ?? "").trim() || null,
      schedule: (String(fd.get("schedule") ?? "unknown") as "CII" | "CIII" | "CIV" | "CV" | "non_controlled" | "unknown"),
      expectedThousandths: parseQuantityThousandths(String(fd.get("expected") ?? "")),
      countedThousandths: parseQuantityThousandths(String(fd.get("counted") ?? "")),
      unit: String(fd.get("unit") ?? "EA").trim() || "EA",
      narrative,
    };
    if (existingId) {
      await db.update(schema.csDiscrepancies).set({ ...facts, updatedAt: new Date().toISOString() }).where(eq(schema.csDiscrepancies.id, existingId));
      await audit({ action: "discrepancy.edit", userId: u.id, userName: u.name, details: `${existingId} ${drugName} on ${facts.discoveredOn}` });
      revalidatePath("/inventory/discrepancies");
      redirect("/inventory/discrepancies?ok=" + encodeURIComponent("Corrected. The original entry and this change are both in the audit log."));
    }
    await db.insert(schema.csDiscrepancies).values({ id, ...facts, createdBy: u.name });
    await audit({ action: "discrepancy.log", userId: u.id, userName: u.name, details: `${drugName} on ${fd.get("discoveredOn")}` });
    revalidatePath("/inventory/discrepancies");
    redirect("/inventory/discrepancies?ok=" + encodeURIComponent("Logged."));
  }

  async function resolve(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const resolution = String(fd.get("resolution") ?? "").trim();
    if (resolution.length < 5) redirect("/inventory/discrepancies?error=" + encodeURIComponent("Say what the conclusion was."));
    await db.update(schema.csDiscrepancies)
      .set({ resolution, resolvedOn: todayIso(), updatedAt: new Date().toISOString() })
      .where(eq(schema.csDiscrepancies.id, id));
    await audit({ action: "discrepancy.resolve", userId: u.id, userName: u.name, details: id });
    revalidatePath("/inventory/discrepancies");
    redirect("/inventory/discrepancies?ok=" + encodeURIComponent("Closed."));
  }

  return (
    <>
      <BackLink href="/inventory">CS inventories</BackLink>
      <PageHeader
        title="Inventory discrepancies"
        subtitle="A count that did not come out right, written down while it is fresh."
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <Notice kind="ok">
        Kansas does not require this log and nothing here files itself anywhere. It is kept because a pattern across
        months is worth seeing, and because a discrepancy reasoned through at the time reads very differently to an
        inspector than one reconstructed a year later. A significant loss of controlled substances is a separate
        matter and still needs a DEA Form 106.
      </Notice>

      <section id="log" className="my-4 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">{editing ? `Correct the entry for ${editing.drugName}` : "Log one"}</h2>
        <form key={editing?.id ?? "new"} action={log} className="mt-3 grid gap-3 sm:grid-cols-3">
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <Field label="Date discovered">
            <input type="date" name="discoveredOn" defaultValue={editing?.discoveredOn ?? todayIso()} className="field" />
          </Field>
          <Field label="Drug" className="sm:col-span-2">
            <input name="drugName" placeholder="Oxycodone 5 mg tablet" defaultValue={editing?.drugName ?? ""} className="field" />
          </Field>
          <Field label="NDC" hint="Optional.">
            <input name="ndc" placeholder="11 digits" defaultValue={editing?.ndc11 ?? ""} className="field font-mono" />
          </Field>
          <Field label="Strength" hint="If it is not in the name.">
            <input name="strength" defaultValue={editing?.strength ?? ""} className="field" />
          </Field>
          <Field label="Schedule">
            <select name="schedule" className="field" defaultValue={editing?.schedule ?? "CII"}>
              <option value="CII">CII</option>
              <option value="CIII">CIII</option>
              <option value="CIV">CIV</option>
              <option value="CV">CV</option>
              <option value="non_controlled">Not controlled</option>
              <option value="unknown">Not sure</option>
            </select>
          </Field>
          <Field label="Should have had" hint="What the system said.">
            <input name="expected" inputMode="decimal" defaultValue={editing?.expectedThousandths != null ? String(editing.expectedThousandths / 1000) : ""} className="field" />
          </Field>
          <Field label="Actually counted">
            <input name="counted" inputMode="decimal" defaultValue={editing?.countedThousandths != null ? String(editing.countedThousandths / 1000) : ""} className="field" />
          </Field>
          <Field label="Unit">
            <input name="unit" defaultValue={editing?.unit ?? "EA"} className="field" />
          </Field>
          <Field
            label="What happened"
            hint="In your own words. What you found, when, who was involved, what you checked. This is the part that matters later."
            className="sm:col-span-3"
          >
            <textarea name="narrative" rows={4} defaultValue={editing?.narrative ?? ""} className="field" />
          </Field>
          <Field label="Back-of-house audit form or count sheet" className="sm:col-span-3">
            <input type="file" name="file" className="field" />
          </Field>
          <div className="flex gap-2 sm:col-span-3">
            <button className="btn btn-primary">{editing ? "Save the correction" : "Save"}</button>
            {editing && <Link href="/inventory/discrepancies" className="btn">Cancel</Link>}
          </div>
        </form>
      </section>

      <h2 className="mt-8 text-sm font-semibold">
        Logged {open.length > 0 && <span className="font-normal text-ink-3">· {open.length} still open</span>}
      </h2>
      {rows.length === 0 ? (
        <div className="mt-2"><Empty>Nothing logged yet.</Empty></div>
      ) : (
        <div className="mt-2 space-y-3">
          {rows.map((r) => {
            const diff =
              r.expectedThousandths !== null && r.countedThousandths !== null
                ? (r.countedThousandths - r.expectedThousandths) / 1000
                : null;
            return (
              <article key={r.id} className={`rounded-lg border p-4 ${r.resolvedOn ? "border-line bg-surface" : "border-amber-300 bg-amber-50"}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">{r.drugName}{r.strength ? ` ${r.strength}` : ""}</h3>
                    <div className="text-xs text-ink-3">
                      {fmt(r.discoveredOn)} · {r.schedule === "non_controlled" ? "not controlled" : r.schedule}
                      {r.ndc11 && <> · <span className="font-mono">{r.ndc11}</span></>}
                      {" · logged by "}{r.createdBy}
                      {" · "}<Link href={`/inventory/discrepancies?edit=${r.id}#log`} className="text-accent underline">correct it</Link>
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    {diff !== null ? (
                      <span className={`font-semibold tabular-nums ${diff < 0 ? "text-red-700" : diff > 0 ? "text-amber-800" : ""}`}>
                        {diff > 0 ? "+" : ""}{diff} {r.unit}
                      </span>
                    ) : (
                      <span className="text-ink-3">count not recorded</span>
                    )}
                    <div className="text-xs text-ink-3">
                      {qty(r.expectedThousandths)} expected, {qty(r.countedThousandths)} counted
                    </div>
                  </div>
                </div>

                <p className="mt-2 whitespace-pre-wrap text-sm text-ink-2">{r.narrative}</p>

                {r.resolvedOn ? (
                  <p className="mt-2 border-t border-line pt-2 text-sm">
                    <b>Closed {fmt(r.resolvedOn)}.</b> {r.resolution}
                  </p>
                ) : (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm underline">Close it out</summary>
                    <form action={resolve} className="mt-2 flex flex-wrap gap-2">
                      <input type="hidden" name="id" value={r.id} />
                      <input name="resolution" placeholder="What it turned out to be" className="field flex-1 min-w-64" />
                      <button className="btn">Close</button>
                    </form>
                  </details>
                )}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
