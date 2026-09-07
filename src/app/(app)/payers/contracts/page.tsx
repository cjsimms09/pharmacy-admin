import { familyTabs } from "@/lib/families";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { audit } from "@/lib/audit";
import { indexContracts } from "@/lib/contract-search";
import { scanContracts } from "@/lib/reference";
import { queueExtraction, collectExtraction } from "@/lib/contract-extract";
import { contractLibrary, adoptUnattached, nameDocument, resetDocument, resetAll, applyAllReads } from "@/lib/contract-docs";
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
              : `${r.queued} document${r.queued === 1 ? "" : "s"} sent to Claude in ${r.batches.length} batch${r.batches.length === 1 ? "" : "es"}. About ${money(r.estimate.low)}–${money(r.estimate.high)}. It runs while the pharmacy is closed; press “Collect the results” later.${r.skipped.length ? ` Not sent: ${r.skipped.join("; ")}.` : ""}`,
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/payers/contracts?error=" + encodeURIComponent(e instanceof Error ? e.message : "The read could not be started."));
    }
  }

  /** The one big run: every document with a file, read or not, sent together. */
  async function readAll() {
    "use server";
    const u = await requireManager();
    try {
      const n = await resetAll();
      const r = await queueExtraction(u.id, u.name);
      await audit({ action: "contracts.extract.all", userId: u.id, userName: u.name, details: `${n} reset, ${r.queued} queued` });
      revalidatePath("/payers/contracts");
      redirect(
        "/payers/contracts?ok=" +
          encodeURIComponent(
            r.queued === 0
              ? r.skipped.join(" ")
              : `${r.queued} document${r.queued === 1 ? "" : "s"} sent to Claude in ${r.batches.length} batch${r.batches.length === 1 ? "" : "es"}, the whole library. About ${money(r.estimate.low)}–${money(r.estimate.high)}. Press “Collect the results” when it is done.${r.skipped.length ? ` Not sent: ${r.skipped.join("; ")}.` : ""}`,
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

  /** Everything certain from every read document, onto the payer pages and the plans, in one pass. */
  async function applyAll() {
    "use server";
    const u = await requireManager();
    try {
      const r = await applyAllReads(u);
      await audit({ action: "contracts.apply.all", userId: u.id, userName: u.name, details: `${r.documents} documents: ${r.rates} rates, ${r.appeals} appeal terms, ${r.contacts} contacts, ${r.routing} payment paths, ${r.links} plan links, ${r.claims} claims attributed; ${r.decisions.length} with decisions left` });
      revalidatePath("/payers");
      revalidatePath("/payers/contracts");
      revalidatePath("/claims");
      redirect(
        "/payers/contracts?ok=" +
          encodeURIComponent(
            `${r.documents} document${r.documents === 1 ? "" : "s"} applied: ${r.rates} rate${r.rates === 1 ? "" : "s"}, ${r.appeals} appeal term${r.appeals === 1 ? "" : "s"}, ${r.contacts} contact${r.contacts === 1 ? "" : "s"}, ${r.routing} payment path${r.routing === 1 ? "" : "s"}, ${r.links} plan link${r.links === 1 ? "" : "s"} (${r.claims} claim${r.claims === 1 ? "" : "s"} now attributed)${r.named ? `; ${r.named} named from what was read` : ""}.` +
              (r.decisions.length ? ` Left for you, a BIN printed in more than one document: ${r.decisions.map((d) => `${d.documentName} (${d.contested})`).join(", ")} — open Review on each.` : " Nothing left to decide."),
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/payers/contracts?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not apply."));
    }
  }

  /** One document on its own: the way to prove the run on a few cents before the library goes. */
  async function readOne(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    try {
      await resetDocument(id);
      const r = await queueExtraction(u.id, u.name, [id]);
      revalidatePath("/payers/contracts");
      redirect(
        "/payers/contracts?ok=" +
          encodeURIComponent(
            r.queued === 0
              ? r.skipped.join(" ")
              : `Sent to Claude as batch ${r.batchId}. About ${money(r.estimate.low)}–${money(r.estimate.high)}. Press “Collect the results” in a while.`,
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/payers/contracts?error=" + encodeURIComponent(e instanceof Error ? e.message : "The read could not be started."));
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

  const read_ = lib.docs.filter((d) => d.state === "done");
  const queued = lib.docs.filter((d) => d.state === "queued");
  const failed = lib.docs.filter((d) => d.state === "failed");
  const unnamed = lib.docs.filter((d) => d.pbmName === "Unnamed");

  return (
    <>
      <BackLink href="/payers">Payers</BackLink>
      <PageHeader
        tabs={familyTabs("payers", "/payers/contracts")}
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
              {lib.withFile > lib.pending && queued.length === 0 && (
                <form action={readAll}>
                  <ConfirmButton
                    className="btn"
                    message={`Read the whole library again: ${lib.withFile} document${lib.withFile === 1 ? "" : "s"}, about ${lib.allPages} pages, roughly ${money(lib.estimateAll.low)} to ${money(lib.estimateAll.high)} at batch prices on ${lib.model}? Earlier drafts are replaced; what you already accepted onto the payer pages stays until you replace it.`}
                  >
                    Read everything again · about {money(lib.estimateAll.low)}–{money(lib.estimateAll.high)}
                  </ConfirmButton>
                </form>
              )}
              {queued.length > 0 && <form action={collect}><SubmitButton className="btn btn-primary" pendingLabel="Collecting…">Collect the results</SubmitButton></form>}
              {read_.length > 0 && queued.length === 0 && (
                <form action={applyAll}>
                  <ConfirmButton
                    className="btn btn-primary"
                    message={`Apply everything certain from ${read_.length} read document${read_.length === 1 ? "" : "s"} to the payer pages and the plans? Rates with their sentence, appeal terms, contacts, payment paths, and plan links no other document disputes. A BIN printed in two documents is left for you.`}
                  >
                    Apply everything certain
                  </ConfirmButton>
                </form>
              )}
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
          <li><b>Read one first.</b> “Read this one” on the most important exhibit costs a few cents and proves the whole path: the read, the collect, the review, the accept. Then read the library.</li>
          <li><b>Read with Claude.</b> One request per document through the Batch API, the cost shown first and refused if it would carry the month past the ceiling. A document over {100} pages is not sent and is named; split it. It runs while the pharmacy is closed; collect the results within a month.</li>
          <li><b>Apply everything certain.</b> One press writes every rate that carries its sentence, the appeal terms, contacts and payment paths, and every plan link no other document disputes, then attributes the claims. Unnamed documents are named from what they read, in the payer pages' own spelling.</li>
          <li><b>Decide what is left.</b> A BIN printed in two documents is the one thing not decided for you. Review on that document shows both, with the PCNs and the claims on each.</li>
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
                      {d.tooLong && <span className="badge badge-crit mt-1 block w-fit" title={`${d.pages} pages; the limit is 100 a document`}>{d.pages} pages: split it</span>}
                    </td>
                    <td className="num text-sm">{d.state === "done" ? d.rates : "—"}</td>
                    <td className="text-xs">{d.confidence !== null ? `${Math.round(d.confidence * 100)}%${d.caveats ? ` · ${d.caveats} caveat${d.caveats === 1 ? "" : "s"}` : ""}` : "—"}</td>
                    <td>
                      <div className="flex items-center justify-end gap-1.5">
                        {d.state === "done" && <Link href={`/payers/contracts/${d.id}`} className="btn btn-sm btn-primary">Review</Link>}
                        {canManage && d.fileName && !d.tooLong && d.state !== "queued" && (
                          <form action={readOne}>
                            <input type="hidden" name="id" value={d.id} />
                            <ConfirmButton className="btn btn-sm" message={`Read “${d.documentName}” on its own now? About ${d.pages ?? "?"} page${d.pages === 1 ? "" : "s"}, a few cents at batch prices.`}>
                              {d.state === "done" || d.state === "failed" ? "Read again" : "Read this one"}
                            </ConfirmButton>
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
