import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { audit } from "@/lib/audit";
import { indexContracts } from "@/lib/contract-search";
import { scanContracts } from "@/lib/reference";
import { queueExtraction, collectExtraction } from "@/lib/contract-extract";
import { contractLibrary, adoptUnattached, nameDocument, resetDocument } from "@/lib/contract-docs";
import { PageHeader, Card, Notice, Empty, Figure, BackLink } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { ConfirmButton } from "@/components/confirm-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "The contracts" };

const money = (d: number) => `$${d.toFixed(2)}`;

/**
 * The contract library, and the run that reads it.
 *
 * Every payer agreement the pharmacy holds, as a file in the data folder and as a document the
 * site knows by name. From here the folder is looked in, each file is named, the read is started
 * with its cost on screen, the results are collected when the batch is done, and each draft is
 * opened as a checklist to accept. Nothing a read produces reaches a payer page until a person has
 * looked at the quote beside it and agreed (`docs/reference/contract-reading.md`).
 */
export default async function ContractsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireReimbursement();
  const user = await requireUser();
  const { ok, error } = await searchParams;
  const lib = await contractLibrary();
  const canManage = user.role !== "staff";

  async function look() {
    "use server";
    const u = await requireManager();
    const s = await scanContracts();
    const a = await adoptUnattached();
    const r = await indexContracts();
    await audit({ action: "contracts.look", userId: u.id, userName: u.name, details: `${s.found} files, ${s.matched} matched the listing, ${a.added} adopted, ${r.indexed} indexed` });
    revalidatePath("/payers/contracts");
    redirect(
      "/payers/contracts?ok=" +
        encodeURIComponent(
          s.found === 0
            ? `No PDFs found. They belong in ${lib.folder}.`
            : `${s.found} file${s.found === 1 ? "" : "s"}: ${s.matched} matched the listing, ${a.added} added as ${a.added === 1 ? "a document" : "documents"} of ${a.added === 1 ? "its" : "their"} own${a.added - a.named > 0 ? ` (${a.added - a.named} still to be named)` : ""}; ${r.indexed} indexed for search${r.scans ? `, ${r.scans} scanned with no text` : ""}.`,
        ),
    );
  }

  async function read() {
    "use server";
    const u = await requireManager();
    try {
      const r = await queueExtraction(u.id, u.name);
      revalidatePath("/payers/contracts");
      redirect(
        "/payers/contracts?ok=" +
          encodeURIComponent(
            r.queued === 0
              ? r.skipped.join(" ")
              : `${r.queued} document${r.queued === 1 ? "" : "s"} sent to Claude as batch ${r.batchId}. About ${money(r.estimate.low)}–${money(r.estimate.high)}. It runs while the pharmacy is closed; press “Collect the results” later.${r.skipped.length ? ` Could not send: ${r.skipped.join(", ")}.` : ""}`,
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/payers/contracts?error=" + encodeURIComponent(e instanceof Error ? e.message : "The read could not be started."));
    }
  }

  async function collect() {
    "use server";
    const u = await requireManager();
    try {
      const r = await collectExtraction(u.id, u.name);
      revalidatePath("/payers/contracts");
      redirect(
        "/payers/contracts?ok=" +
          encodeURIComponent(
            `${r.done} read${r.stillRunning ? `, ${r.stillRunning} still running` : ""}${r.failed ? `, ${r.failed} failed` : ""}.${r.rejected.length ? ` Refused for missing quotes: ${r.rejected.map((x) => x.doc).join(", ")}.` : ""}`,
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/payers/contracts?error=" + encodeURIComponent(e instanceof Error ? e.message : "The results could not be collected."));
    }
  }

  async function rename(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const pbm = String(fd.get("pbmName") ?? "");
    await nameDocument(id, pbm, String(fd.get("documentName") ?? ""));
    await audit({ action: "contracts.name", userId: u.id, userName: u.name, details: `${id} → ${pbm}` });
    revalidatePath("/payers/contracts");
    redirect("/payers/contracts?ok=" + encodeURIComponent("Named."));
  }

  async function reset(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    await resetDocument(id);
    await audit({ action: "contracts.reset", userId: u.id, userName: u.name, details: id });
    revalidatePath("/payers/contracts");
    redirect("/payers/contracts?ok=" + encodeURIComponent("Put back to unread. The next read will include it."));
  }

  const read_ = lib.docs.filter((d) => d.state === "done");
  const queued = lib.docs.filter((d) => d.state === "queued");
  const failed = lib.docs.filter((d) => d.state === "failed");
  const unnamed = lib.docs.filter((d) => d.pbmName === "Unnamed");

  return (
    <>
      <BackLink href="/payers">Payers</BackLink>
      <PageHeader
        title="The contracts"
        subtitle="Every agreement the pharmacy holds, read once by Claude with the contract's own words beside every figure, and accepted into the payer pages by you."
        actions={
          canManage ? (
            <>
              <form action={look}><SubmitButton className="btn" pendingLabel="Looking…">Look in the folder</SubmitButton></form>
              {lib.pending > 0 && (
                <form action={read}>
                  <ConfirmButton
                    className="btn btn-primary"
                    message={`Send ${lib.pending} document${lib.pending === 1 ? "" : "s"} (about ${lib.pendingPages} pages) to Claude? Roughly ${money(lib.estimate.low)} to ${money(lib.estimate.high)} at batch prices on ${lib.model}.`}
                  >
                    Read {lib.pending} with Claude · about {money(lib.estimate.low)}–{money(lib.estimate.high)}
                  </ConfirmButton>
                </form>
              )}
              {queued.length > 0 && <form action={collect}><SubmitButton className="btn btn-primary" pendingLabel="Collecting…">Collect the results</SubmitButton></form>}
            </>
          ) : undefined
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}
      {!lib.keyPresent && (
        <Notice kind="warn">
          No Anthropic key is on file, so nothing can be read yet. Add it under <Link href="/settings" className="underline">Settings → Claude</Link>; the folder can still be looked in and searched.
        </Notice>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure value={lib.filesInFolder} label="PDFs in the folder" sub={lib.folder} tone="muted" />
        <Figure value={lib.docs.length} label="documents the site knows" sub={lib.unattached.length ? `${lib.unattached.length} file${lib.unattached.length === 1 ? "" : "s"} not yet a document: look in the folder` : "every file is a document"} tone={lib.unattached.length ? "warn" : "muted"} />
        <Figure value={read_.length} label="read" sub={queued.length ? `${queued.length} running` : lib.pending ? `${lib.pending} waiting to be read` : "nothing waiting"} tone={read_.length ? "ok" : "muted"} />
        <Figure value={unnamed.length} label="unnamed" sub={unnamed.length ? "name the counterparty before reading, where you can" : "every document has its counterparty"} tone={unnamed.length ? "warn" : "ok"} />
      </div>

      <Card
        className="mt-4"
        title="How this works"
        subtitle="Four steps, each one a button above; nothing is written to a payer page by a machine."
      >
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-2">
          <li><b>Look in the folder.</b> Every PDF becomes a document, named from the portal's manifest where there is one, otherwise from its filename. Its words are indexed for search.</li>
          <li><b>Name what is unnamed.</b> The counterparty is the first axis; a document the read cannot name is still yours to name.</li>
          <li><b>Read with Claude.</b> One request per document through the Batch API, the cost shown first. It runs while the pharmacy is closed; collect the results when it is done.</li>
          <li><b>Review and accept.</b> Each draft opens as a checklist: rates, appeal terms, contacts, the payment path, and the plans it governs, each with the contract's own sentence. What you accept is written; what you do not is not.</li>
        </ol>
      </Card>

      <Card className="mt-4" title="Documents" count={lib.docs.length}>
        {lib.docs.length === 0 ? (
          <Empty>Nothing yet. Put the PDFs in {lib.folder} and press “Look in the folder”.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr><th>Counterparty</th><th>Document</th><th>File</th><th>Read</th><th className="num">Rates</th><th>Confidence</th><th /></tr>
              </thead>
              <tbody>
                {lib.docs.map((d) => (
                  <tr key={d.id} className={d.state === "failed" ? "bg-crit-soft/30" : ""}>
                    <td className="text-sm">
                      {d.pbmName === "Unnamed" && canManage ? (
                        <form action={rename} className="flex items-center gap-1">
                          <input type="hidden" name="id" value={d.id} />
                          <input name="pbmName" placeholder="Counterparty" className="!py-1 text-sm" />
                          <SubmitButton className="btn btn-sm" pendingLabel="…">Name</SubmitButton>
                        </form>
                      ) : (
                        <>
                          {d.pbmName}
                          {d.counterparty && d.counterparty.toLowerCase() !== d.pbmName.toLowerCase() && <span className="block text-xs text-ink-3">reads as {d.counterparty}</span>}
                        </>
                      )}
                    </td>
                    <td className="text-sm">
                      {d.documentName}
                      {d.role && <span className="block text-xs text-ink-3">{d.role.replace(/_/g, " ")}</span>}
                    </td>
                    <td className="font-mono text-[11px] text-ink-3">{d.fileName ?? <span className="text-warn">no file</span>}</td>
                    <td className="text-xs">
                      {d.state === "done" && <span className="badge badge-ok">read</span>}
                      {d.state === "queued" && <span className="badge badge-warn">running</span>}
                      {d.state === "failed" && <span className="badge badge-crit" title={d.error ?? undefined}>failed</span>}
                      {d.state === "none" && (d.fileName ? <span className="badge badge-muted">not yet</span> : <span className="text-ink-3">—</span>)}
                      {d.state === "failed" && d.error && <span className="mt-1 block max-w-xs text-ink-3">{d.error}</span>}
                    </td>
                    <td className="num text-sm">{d.state === "done" ? d.rates : "—"}</td>
                    <td className="text-xs">{d.confidence !== null ? `${Math.round(d.confidence * 100)}%${d.caveats ? ` · ${d.caveats} caveat${d.caveats === 1 ? "" : "s"}` : ""}` : "—"}</td>
                    <td>
                      <div className="flex items-center justify-end gap-1.5">
                        {d.state === "done" && <Link href={`/payers/contracts/${d.id}`} className="btn btn-sm btn-primary">Review</Link>}
                        {canManage && (d.state === "done" || d.state === "failed") && (
                          <form action={reset}>
                            <input type="hidden" name="id" value={d.id} />
                            <SubmitButton className="btn btn-sm" pendingLabel="…">Read again</SubmitButton>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {failed.length > 0 && (
          <p className="mt-2 text-xs text-ink-3">
            A document is refused when a rate in it has no supporting sentence, because a figure nobody can trace to the contract is not usable in an appeal. “Read again” sends it once more.
          </p>
        )}
      </Card>
    </>
  );
}
