import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager, requireUser } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { audit } from "@/lib/audit";
import { contractLibrary, type LibraryDoc } from "@/lib/contract-docs";
import { queueTriage, collectTriage, setTriage, testReader, TRIAGE_MODEL } from "@/lib/contract-extract";
import { TRIAGE_KINDS, KIND_MEANS, estimateTriageCost, type TriageKind } from "@/lib/contract-triage";
import { dollars } from "@/lib/ai-spend";
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
export default async function SortPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; test?: string }> }) {
  await requireReimbursement();
  const user = await requireUser();
  const { ok, error, test } = await searchParams;
  const lib = await contractLibrary();
  const withFile = lib.docs.filter((d) => d.fileName && d.state !== "done");
  const unsorted = withFile.filter((d) => !d.triage && !d.sorting);
  const sorting = withFile.filter((d) => d.sorting);
  const byKind = (k: TriageKind) => withFile.filter((d) => d.triage === k);
  const ruledOut = byKind("not_relevant");
  const scanPages = unsorted.reduce((n, d) => n + (d.pages ?? 0), 0);
  const canManage = user.role === "owner" || user.role === "pic";
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
        title="Sort the folder"
        subtitle="Which PDFs are contracts and which are not, decided before anything is paid to read them."
        back={{ href: "/payers/contracts", label: "The contracts" }}
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
