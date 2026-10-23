import { familyTabs } from "@/lib/families";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager, requireUser } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { audit } from "@/lib/audit";
import { contractLibrary, type LibraryDoc } from "@/lib/contract-docs";
import { queueTriage, collectTriage, setTriage, testReader, recoverFailures, proveReader, TRIAGE_MODEL } from "@/lib/contract-extract";
import { TRIAGE_KINDS, KIND_MEANS, estimateTriageCost, type TriageKind } from "@/lib/contract-triage";
import { dollars } from "@/lib/ai-spend";
import { fmt } from "@/lib/dates";
import { PageHeader, Card, Notice, Figure, Empty } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sort the folder" };

/**
 * The cheap pass before the expensive one.
 *
 * Not every PDF the portals hand over is a contract, and a full read of a W-9 costs the same as a
 * full read of a rate exhibit. So the folder is sorted first: for nothing where a document has its
 * own text, and for a few cents a document where it is a scan and the small model has to look. The
 * full read then skips only what the sort ruled out, and a person can overrule any verdict here.
 */
export default async function SortPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; test?: string; prove?: string }> }) {
  await requireReimbursement();
  const user = await requireUser();
  const { ok, error, test, prove } = await searchParams;
  const lib = await contractLibrary();
  const withFile = lib.docs.filter((d) => d.fileName && d.state !== "done");
  const unsorted = withFile.filter((d) => !d.triage && !d.sorting);
  const sorting = withFile.filter((d) => d.sorting);
  const byKind = (k: TriageKind) => withFile.filter((d) => d.triage === k);
  const ruledOut = byKind("not_relevant");
  const scanPages = unsorted.reduce((n, d) => n + (d.pages ?? 0), 0);
  const canManage = user.role === "owner" || user.role === "pic";
  const refused = withFile.filter((d) => d.state === "failed");
  const smallest = [...withFile].filter((d) => d.pages && !d.tooLong && d.state !== "queued").sort((a, b) => (a.pages ?? 0) - (b.pages ?? 0))[0] ?? null;

  async function sort() {
    "use server";
    const u = await requireManager();
    try {
      const r = await queueTriage(u.id, u.name);
      revalidatePath("/payers/sort");
      redirect(
        "/payers/sort?ok=" +
          encodeURIComponent(
            `${r.sortedByText} sorted by their own text for nothing` +
              (r.sentToModel ? `; ${r.sentToModel} scan${r.sentToModel === 1 ? "" : "s"} sent to ${TRIAGE_MODEL} (about ${dollars(r.estimate)}) — press Collect when the batch has finished` : "") +
              (r.scansLeft ? `; ${r.scansLeft} more scan${r.scansLeft === 1 ? "" : "s"} wait for the next press of Sort` : "") +
              (r.alreadySorted ? `; ${r.alreadySorted} already sorted` : "") +
              (r.skipped.length ? `; skipped: ${r.skipped.slice(0, 3).join(", ")}${r.skipped.length > 3 ? "…" : ""}` : "") +
              ".",
          ),
      );
    } catch (e) {
      if (e instanceof Error && e.message.includes("NEXT_REDIRECT")) throw e;
      redirect("/payers/sort?error=" + encodeURIComponent(e instanceof Error ? e.message : String(e)));
    }
  }

  async function collect() {
    "use server";
    const u = await requireManager();
    try {
      const r = await collectTriage(u.id, u.name);
      revalidatePath("/payers/sort");
      revalidatePath("/payers/contracts");
      redirect("/payers/sort?ok=" + encodeURIComponent(`${r.sorted} sorted, ${r.notRelevant} ruled out, ${r.failed} left unsure after a refused sort, ${r.stillRunning} still running.`));
    } catch (e) {
      if (e instanceof Error && e.message.includes("NEXT_REDIRECT")) throw e;
      redirect("/payers/sort?error=" + encodeURIComponent(e instanceof Error ? e.message : String(e)));
    }
  }

  /*
   * One document, read now, with the reason if it is refused.
   *
   * The first live batch came back "errored" and nothing else, and the owner had no way to know
   * whether the fault was the file, the key, the model or the page count. This sends the smallest
   * document through the exact same request, waits for the answer, and prints it.
   */
  async function testOne(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    if (!id) redirect("/payers/sort?error=" + encodeURIComponent("Nothing to test."));
    const r = await testReader(id, u.id, u.name);
    revalidatePath("/payers/sort");
    revalidatePath("/payers/contracts");
    redirect("/payers/sort?test=" + encodeURIComponent(JSON.stringify(r)));
  }

  /*
   * The reason for the reads that were refused before the reason was kept.
   *
   * Asks the API for the results of every batch this site ever queued (the audit line names them;
   * the API holds them for 29 days) and writes each refusal on its document in plain words. Nothing
   * is sent to the model, so nothing is charged.
   */
  async function why() {
    "use server";
    const u = await requireManager();
    try {
      const r = await recoverFailures(u.id, u.name);
      revalidatePath("/payers/sort");
      revalidatePath("/payers/contracts");
      const said =
        r.note ||
        `${r.batches} batch${r.batches === 1 ? "" : "es"} asked` +
          (r.gone ? `, ${r.gone} no longer held by the API` : "") +
          (r.stillRunning ? `, ${r.stillRunning} still running` : "") +
          `: ${r.explained.length} refusal${r.explained.length === 1 ? "" : "s"} explained below` +
          (r.recovered ? `, ${r.recovered} finished read${r.recovered === 1 ? "" : "s"} recovered and kept` : "") +
          ".";
      redirect("/payers/sort?ok=" + encodeURIComponent(said));
    } catch (e) {
      if (e instanceof Error && e.message.includes("NEXT_REDIRECT")) throw e;
      redirect("/payers/sort?error=" + encodeURIComponent(e instanceof Error ? e.message : String(e)));
    }
  }

  /*
   * The reader, on the site's own document, marked against a known answer.
   *
   * A real contract proves the request runs; only an invented one, whose every figure is known,
   * proves the read is right. Cents, and the one press to make before a paid run.
   */
  async function proveIt() {
    "use server";
    const u = await requireManager();
    const r = await proveReader(u.id, u.name);
    revalidatePath("/payers/sort");
    redirect("/payers/sort?prove=" + encodeURIComponent(JSON.stringify(r)));
  }

  async function decide(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("id") ?? "");
    const kind = String(fd.get("kind") ?? "") as TriageKind;
    if (!id || !TRIAGE_KINDS.includes(kind)) redirect("/payers/sort?error=" + encodeURIComponent("Pick a kind."));
    await setTriage(id, kind, u.name);
    await audit({ action: "contracts.triage.decided", userId: u.id, userName: u.name, entity: "contract_doc", entityId: id, details: kind });
    revalidatePath("/payers/sort");
    revalidatePath("/payers/contracts");
    redirect("/payers/sort?ok=" + encodeURIComponent("Recorded. The read will follow your word, not the sort's."));
  }

  return (
    <>
      <PageHeader
        tabs={familyTabs("payers", "/payers/sort")}
        title="Sort the folder"
        subtitle="Which PDFs are contracts and which are not, decided before anything is paid to read them."
        help={
          <>
            <p><b>Two sorters, cheapest first.</b> A PDF with its own text is sorted here by its words for nothing: agreement, reimbursement, MAC, AWP, BIN, network and effective date mark a contract; a W-9, a statement, a newsletter mark something else. Anything naming a price or a term is never ruled out.</p>
            <p><b>A scan</b> goes to the small model with one question and a one-sentence answer, in a batch, for a few cents. Only a confident &ldquo;not relevant&rdquo; is acted on.</p>
            <p><b>Your word beats both.</b> Change any verdict and the full read follows you. The read skips only what was ruled out.</p>
            <p><b>Proving the reader.</b> &ldquo;Read now&rdquo; sends the smallest unread document synchronously with the exact batch request and prints its terms or the API&rsquo;s exact refusal. A refused request costs nothing.</p>
          </>
        }
        actions={
          canManage ? (
            <>
              <form action={sort}>
                <SubmitButton pendingLabel="Sorting…" className="btn btn-primary" disabled={unsorted.length === 0}>
                  Sort {unsorted.length} unsorted
                </SubmitButton>
              </form>
              <form action={collect}>
                <SubmitButton pendingLabel="Collecting…" className="btn" disabled={sorting.length === 0}>
                  Collect {sorting.length ? `(${sorting.length} out)` : ""}
                </SubmitButton>
              </form>
            </>
          ) : undefined
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}
      {test && <TestResult json={test} />}
      {prove && <ProveResult json={prove} />}

      {/*
        Where the sort has got to, in the only terms that matter: how many documents the read now
        covers, and what it will cost. The sort's whole purpose is to make that number smaller, and
        it was possible to sort the whole folder here without ever seeing it change.
      */}
      <Card className="mb-4" title="What the read now covers" subtitle="The sort's rejects are out of this count and out of this price. They are not sent.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Figure value={lib.pending} label="waiting to be read" sub={`${lib.pendingPages} pages`} tone={lib.pending ? "ok" : "muted"} />
          <Figure value={ruledOut.length} label="ruled out" sub={ruledOut.length ? "never sent" : "nothing ruled out yet"} tone="muted" />
          <Figure value={`$${lib.estimate.low.toFixed(2)}–${lib.estimate.high.toFixed(2)}`} label="what the read would cost" sub={`at batch prices on ${lib.model}`} tone="muted" />
        </div>
        <p className="mt-3 text-sm text-ink-2">
          {unsorted.length > 0
            ? `${unsorted.length} document${unsorted.length === 1 ? " is" : "s are"} still unsorted, and ${unsorted.length === 1 ? "is" : "are"} counted and priced above as ${unsorted.length === 1 ? "a contract" : "contracts"}. Sorting ${unsorted.length === 1 ? "it" : "them"} first is what makes that figure honest.`
            : "Everything with a file has been sorted."}{" "}
          <Link href="/payers/contracts" className="underline">The contracts</Link> is where the read is started.
        </p>
      </Card>

      {(refused.length > 0 || canManage) && (
        <Card
          className="mb-4"
          title="Reads that were refused"
          count={refused.length}
          subtitle="What the API said about each, in words that say what to do. A read refused before the reason was kept shows only that it failed; ask the API and the reason is fetched back from the batch, which it holds for 29 days. Nothing is charged."
          tone={refused.length ? "warn" : undefined}
          actions={
            canManage ? (
              <form action={why}>
                <SubmitButton pendingLabel="Asking…" className="btn btn-sm btn-primary">Ask the API why</SubmitButton>
              </form>
            ) : undefined
          }
        >
          {refused.length === 0 ? (
            <p className="text-sm text-ink-3">No read stands refused.</p>
          ) : (
            <ul className="rows">
              {refused.map((d) => (
                <li key={d.id} className="row">
                  <div className="min-w-0">
                    <div className="row-title">{d.documentName}</div>
                    <p className="row-why">{d.pbmName} · {d.pages ?? "?"} page{d.pages === 1 ? "" : "s"}</p>
                    {/*
                      Dated, because a stored failure reads exactly like a live one.

                      The refusals that stopped every contract read sat here unchanged after the
                      cause was fixed and the update installed, and nothing on the line said the
                      message was a record rather than the API refusing again.
                    */}
                    <p className="mt-0.5 text-xs text-crit">
                      {d.failedAt ? <span className="text-ink-3">Last read failed {fmt(d.failedAt)}: </span> : null}
                      {d.error ?? "Refused; the reason was not kept. Ask the API why."}
                      {d.failedAt ? <span className="text-ink-3"> — press Read again to try it on the current version.</span> : null}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {canManage && (
        <Card className="mb-4" title="Prove the reader on the site's own document" subtitle="A two-page agreement the site wrote itself, with every figure known: two rate lines, a guarantee that must stay out of the rates, a fee taken back, the appeal window, the payment path. Read through the exact batch request and marked. Cents.">
          <form action={proveIt} className="flex flex-wrap items-center gap-2">
            <SubmitButton pendingLabel="Reading the proving document… (about a minute)" className="btn btn-primary">Prove the reader</SubmitButton>
            <span className="text-xs text-ink-3">Do this before a paid run, and after any change to the prompt, the schema or the model.</span>
          </form>
        </Card>
      )}

      {smallest && canManage && (
        <Card className="mb-4" title="Prove the reader before the run" subtitle="Reads the smallest unread document now, outside the batch, and prints either its terms or the exact refusal. A refused read costs nothing.">
          <form action={testOne} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="id" value={smallest.id} />
            <SubmitButton pendingLabel="Reading… (about a minute)" className="btn btn-primary">Read {smallest.documentName} now</SubmitButton>
            <span className="text-xs text-ink-3">{smallest.pbmName} · {smallest.pages ?? "?"} page{smallest.pages === 1 ? "" : "s"} · at most {dollars(lib.estimate.high * ((smallest.pages ?? 1) / Math.max(1, lib.pendingPages)))} if it succeeds</span>
          </form>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure value={unsorted.length} label="not yet sorted" sub={unsorted.length ? `Sorting the scans among them costs at most ${dollars(estimateTriageCost(scanPages))}` : "everything with a file is sorted"} tone={unsorted.length ? "warn" : "ok"} />
        <Figure value={withFile.length - unsorted.length - sorting.length - ruledOut.length} label="to read" sub="contracts, rate sheets, notices, manuals and the unsure" tone="ok" />
        <Figure value={ruledOut.length} label="ruled out" sub="the read skips these unless you say otherwise" tone="muted" />
        <Figure value={dollars(lib.estimate.high)} label="a full read now costs at most" sub={`${lib.pendingPages} pages the read would send`} tone="muted" />
      </div>

      <Card className="mt-4" title="How this works" subtitle="Two sorters, cheapest first, and a person's word over both.">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-2">
          <li><b>A PDF with its own text is sorted here, for nothing.</b> Words like agreement, reimbursement, MAC, AWP, BIN, network and effective date mark a contract; a W-9, a statement, a newsletter mark something else. Anything that names a price or a term is never ruled out.</li>
          <li><b>A scan goes to {TRIAGE_MODEL}</b> with one question and a one-sentence answer, in a batch, for a few cents a document. Only a confident &ldquo;not relevant&rdquo; is acted on; a hesitant one is read anyway.</li>
          <li><b>The full read then skips only what was ruled out.</b> Change any verdict below and the read follows you.</li>
        </ol>
      </Card>

      {withFile.length === 0 ? (
        <Empty>Nothing to sort. Press &ldquo;Look in the folder&rdquo; on the contracts page first.</Empty>
      ) : (
        (["not_relevant", "unsure", "notice", "rate_sheet", "manual", "contract"] as TriageKind[]).map((k) => {
          const rows = byKind(k);
          if (rows.length === 0) return null;
          return <KindCard key={k} kind={k} rows={rows} decide={decide} canManage={canManage} />;
        })
      )}

      {(unsorted.length > 0 || sorting.length > 0) && (
        <Card className="mt-4" title={sorting.length ? "Out with the model" : "Not yet sorted"} count={unsorted.length + sorting.length}>
          <ul className="rows">
            {[...sorting, ...unsorted].slice(0, 80).map((d) => (
              <li key={d.id} className="row">
                <div className="min-w-0">
                  <div className="row-title">{d.documentName}</div>
                  <p className="row-why">{d.pbmName} · {d.pages ?? "?"} pages{d.sorting ? " · sorting" : ""}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function KindCard({ kind, rows, decide, canManage }: { kind: TriageKind; rows: LibraryDoc[]; decide: (fd: FormData) => Promise<void>; canManage: boolean }) {
  const label: Record<TriageKind, string> = { contract: "Contracts", rate_sheet: "Rate sheets", notice: "Notices", manual: "Manuals", not_relevant: "Ruled out", unsure: "Unsure — read anyway" };
  return (
    <Card className="mt-4" title={label[kind]} count={rows.length} subtitle={KIND_MEANS[kind]} tone={kind === "not_relevant" ? "warn" : undefined}>
      <ul className="rows">
        {rows.map((d) => (
          <li key={d.id} className="row">
            <div className="min-w-0">
              <div className="row-title">
                <Link href={`/payers/contracts/${d.id}`} className="hover:underline">{d.documentName}</Link>
                <span className="ml-2 text-xs font-normal text-ink-3">{d.pbmName} · {d.pages ?? "?"} pages · by {d.triageBy === "rule" ? "its own text" : d.triageBy === "model" ? "the model" : d.triageBy}</span>
              </div>
              <p className="row-why">{d.triageWhy}</p>
            </div>
            {canManage && (
              <form action={decide} className="flex items-center gap-1">
                <input type="hidden" name="id" value={d.id} />
                <select name="kind" defaultValue={kind} className="field w-auto px-1 py-0.5 text-[11px]">
                  {TRIAGE_KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}
                </select>
                <button className="btn btn-sm text-[11px]">Decide</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TestResult({ json }: { json: string }) {
  let r: import("@/lib/contract-extract").ReaderTest | null = null;
  try {
    r = JSON.parse(json);
  } catch {
    return null;
  }
  if (!r) return null;
  if (r.ok) {
    return (
      <Notice kind="ok">
        <b>{r.documentName} read in {r.seconds}s</b> on the same request the batch uses: counterparty {r.counterparty || "not named"}, {r.rates} rate row{r.rates === 1 ? "" : "s"}, {r.tokensIn.toLocaleString()} tokens in and {r.tokensOut.toLocaleString()} out. {r.note}
      </Notice>
    );
  }
  return (
    <Notice kind="crit">
      <b>{r.documentName} was refused.</b> {r.reason}
      <span className="mt-1 block font-mono text-[11px] text-ink-2">{r.detail}</span>
    </Notice>
  );
}

function ProveResult({ json }: { json: string }) {
  let r: import("@/lib/contract-extract").ProvingResult | null = null;
  try {
    r = JSON.parse(json);
  } catch {
    return null;
  }
  if (!r) return null;
  return (
    <Card className="mb-4" title={r.ok ? "The reader passed" : r.refusal ? "The reader was refused" : `The reader passed ${r.passed} of ${r.of} checks`} tone={r.ok ? "ok" : "crit"} subtitle={r.refusal ?? `${r.seconds}s · ${r.tokensIn.toLocaleString()} tokens in, ${r.tokensOut.toLocaleString()} out.`}>
      {r.checks.length > 0 && (
        <ul className="rows text-sm">
          {r.checks.map((c) => (
            <li key={c.check} className="row">
              <span className="min-w-0">
                <span className="row-title">{c.ok ? "✓" : "✗"} {c.check}</span>
                <span className="row-why block font-mono text-[11px]">{c.got.slice(0, 240)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
