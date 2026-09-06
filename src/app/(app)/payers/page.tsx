import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { importReference, referenceCounts, pbmDirectory, lookupBin, scanContracts } from "@/lib/reference";
import { requireReimbursement } from "@/lib/features";
import { PageHeader, Notice, Empty, Field } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { unknownBins, nameBin } from "@/lib/unknown-bins";
import { indexContracts, searchContracts, contractsForUnknownBins, contractIndexState, type ContractHit } from "@/lib/contract-search";

export const metadata = { title: "Payers" };
export const dynamic = "force-dynamic";

export default async function PayersPage({ searchParams }: { searchParams: Promise<{ bin?: string; q?: string; imported?: string; error?: string }> }) {
  await requireReimbursement();
  const user = await requireUser();
  const { bin, q, imported, error } = await searchParams;
  const counts = await referenceCounts();
  const directory = await pbmDirectory();
  const hit = bin?.trim() ? await lookupBin(bin) : null;
  /*
   * The BINs the pharmacy actually bills that nothing here can name.
   *
   * They were being printed at the end of an import line and scrolling away — eighteen of them on
   * the first real day. That is eighteen payers whose reimbursement cannot be grouped, whose MAC
   * appeals have no help-desk number, and whose contract cannot be found when a rate looks wrong.
   */
  const gaps = await unknownBins();
  const canManage = user.role !== "staff";
  /*
   * Which contract on file names each unnamed BIN.
   *
   * The numbers come from the claims and the answers are in the PDFs, and nothing had ever put the
   * two in the same room — so eighteen BINs went unnamed while the contracts naming them sat on the
   * same disk.
   */
  const [inContracts, indexState] = await Promise.all([
    contractsForUnknownBins(gaps.map((g) => g.bin)),
    contractIndexState(),
  ]);
  const found = q?.trim() ? await searchContracts(q) : null;
  const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const needle = (q ?? "").trim().toLowerCase();
  const shown = needle
    ? directory.filter((d) => d.pbmName.toLowerCase().includes(needle) || d.bins.some((b) => b.includes(needle)))
    : directory;

  async function runImport() {
    "use server";
    const u = await requireManager();
    try {
      const r = await importReference();
      const s = await scanContracts();
      await audit({
        action: "reference.import",
        userId: u.id,
        userName: u.name,
        details: `${r.bins} BINs, ${r.docs} documents, ${r.rates} rates, ${r.appeals} appeal routes, ${r.routing} payment routes, ${r.contacts} contacts, ${r.communications} notices; ${s.matched}/${s.found} contract files matched`,
      });
      revalidatePath("/payers");
      const note = [
        `${r.bins} BINs, ${r.rates} network rates, ${r.appeals} appeal routes, ${r.communications} notices.`,
        r.unresolvedPbms.length ? `Not on the BIN listing: ${r.unresolvedPbms.join(", ")}.` : "",
        r.skipped.length ? `No file for: ${r.skipped.join(", ")}.` : "",
      ].filter(Boolean).join(" ");
      redirect("/payers?imported=" + encodeURIComponent(note));
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e; // redirect() throws; let it through
      redirect("/payers?error=" + encodeURIComponent(e instanceof Error ? e.message : "Import failed."));
    }
  }

  /** Reads every contract PDF in the data folder and keeps its words, so they can be searched. */
  async function reindex() {
    "use server";
    const u = await requireManager();
    const r = await indexContracts();
    await audit({ action: "contracts.index", userId: u.id, userName: u.name, details: `${r.indexed} read of ${r.files}` });
    revalidatePath("/payers");
    redirect(
      "/payers?imported=" +
        encodeURIComponent(
          r.files === 0
            ? "No contract PDFs were found. They belong in the contracts folder inside the data directory."
            : `${r.indexed} contract${r.indexed === 1 ? "" : "s"} read${r.unchanged ? `, ${r.unchanged} unchanged since last time` : ""}` +
              (r.scans ? `. ${r.scans} ${r.scans === 1 ? "is a scan with no text in it and cannot be searched" : "are scans with no text in them and cannot be searched"}` : "") +
              (r.problems.length ? `. ${r.problems[0]}` : "") +
              ".",
        ),
    );
  }

  /** Names a BIN and attributes every claim already held under it. */
  async function name(fd: FormData) {
    "use server";
    const u = await requireManager();
    const b = String(fd.get("bin") ?? "");
    try {
      const r = await nameBin(b, String(fd.get("pbmName") ?? ""), { helpDesk: String(fd.get("helpDesk") ?? "") }, u);
      await audit({ action: "payer.bin.name", userId: u.id, userName: u.name, details: `${b} = ${String(fd.get("pbmName") ?? "")}` });
      revalidatePath("/payers");
      revalidatePath("/claims");
      redirect(
        "/payers?imported=" +
          encodeURIComponent(
            `BIN ${b} is ${String(fd.get("pbmName") ?? "")}. ${r.claims} claim${r.claims === 1 ? "" : "s"} already held under it ${r.claims === 1 ? "was" : "were"} attributed to them.`,
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/payers?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not save that."));
    }
  }

  return (
    <>
      <PageHeader
        title="Payers"
        subtitle="Every BIN we bill, the network rates behind it, how a MAC appeal reaches it, and where the money comes from."
        actions={
          <>
            <Link href="/payers/performance" className="btn btn-primary">Who pays best</Link>
            <Link href="/claims/floor" className="btn">Kansas floor (SB 20)</Link>
            <Link href="/plans" className="btn">Classify plans</Link>
          </>
        }
      />

      {imported && <Notice kind="ok">Imported. {imported}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {/*
        The gap, ordered by the money behind it.

        A BIN billed once last Tuesday and a BIN carrying a fifth of the revenue are not the same
        problem, and a list that treats them alike gets read once. Nothing here guesses what a BIN
        belongs to: a BIN wrongly attributed is worse than an unnamed one, because an appeal sent to
        the wrong PBM is a rate the pharmacy then believes it has challenged.
      */}
      {/*
        Searching the contracts, which until now were filed and never opened.

        A filing cabinet is not a record. The question actually asked of a contract is "which one
        covers this BIN", and answering it meant opening twenty PDFs by hand.
      */}
      <section className="mb-6 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Search the contracts on file</h2>
        <p className="mt-1 text-xs text-ink-2">
          {indexState.files === 0 ? (
            <>
              Nothing has been read yet. The contract PDFs live in <code>data/contracts/</code>; press below and their
              words are kept so a BIN, PCN or group number can be traced to the agreement that covers it.
            </>
          ) : (
            <>
              {indexState.withText} contract{indexState.withText === 1 ? "" : "s"} readable
              {indexState.scans > 0 && (
                <>
                  , {indexState.scans} {indexState.scans === 1 ? "is a scan" : "are scans"} with no text in them — those
                  cannot be searched and have to be read by eye
                </>
              )}
              .
            </>
          )}
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <form method="get" className="flex flex-wrap items-end gap-2">
            <input name="q" defaultValue={q ?? ""} className="field w-72 py-1.5 text-sm" placeholder="A BIN, PCN, group number or a plan's name" />
            <button className="btn btn-sm btn-primary">Search</button>
          </form>
          {canManage && (
            <form action={reindex}>
              <SubmitButton className="btn btn-sm" pendingLabel="Reading the contracts…">
                {indexState.files === 0 ? "Read the contracts" : "Read them again"}
              </SubmitButton>
            </form>
          )}
        </div>
        {found && (
          <div className="mt-3">
            {found.length === 0 ? (
              <p className="text-sm text-ink-2">
                Nothing on file contains &ldquo;{q}&rdquo;.
                {indexState.withText === 0 && " Nothing has been read yet — press the button above first."}
              </p>
            ) : (
              <ul className="rows text-sm">
                {found.map((h) => (
                  <li key={h.fileName} className="py-2">
                    <b>{h.fileName}</b> <span className="text-xs text-ink-3">· {h.matches} mention{h.matches === 1 ? "" : "s"}</span>
                    {h.snippets.map((sn, i) => (
                      <p key={i} className="mt-0.5 text-xs text-ink-2">&hellip;{sn}&hellip;</p>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {gaps.length > 0 && (
        <section className="mb-6 rounded-lg border border-warn bg-surface p-4">
          <h2 className="text-sm font-semibold text-warn">
            {gaps.length} BIN{gaps.length === 1 ? "" : "s"} on your claims that nothing here can name
          </h2>
          <p className="mt-1 text-xs text-ink-2">
            {money(gaps.reduce((n, g) => n + g.receivedCents, 0))} of reimbursement sits behind them, across{" "}
            {gaps.reduce((n, g) => n + g.claims, 0).toLocaleString()} claims. Until each is named, that money cannot be
            grouped by payer, a MAC appeal has no help desk to reach, and no contract can be found when a rate looks
            wrong. Name the PBM and every claim already held under that BIN is attributed in the same press.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>BIN</th><th className="text-right">Claims</th><th className="text-right">Reimbursed</th>
                  <th>As the claim named it</th><th>Who is it?</th>
                </tr>
              </thead>
              <tbody>
                {gaps.map((g) => (
                  <tr key={g.bin}>
                    <td className="font-mono text-sm">{g.bin}</td>
                    <td className="num text-sm">{g.claims}</td>
                    <td className="num text-sm">{money(g.receivedCents)}</td>
                    <td className="text-xs text-ink-2">
                      {g.labels.length ? g.labels.join(", ") : <span className="text-ink-3">the claim carried no payer name</span>}
                      {g.lastSeen && <span className="block text-ink-3">last seen {g.lastSeen}</span>}
                      {/*
                        The answer, where it is already on this disk.

                        A hit is a fact — this contract contains this number — and the sentence
                        around it is shown so a person decides what it means. Nothing here concludes
                        that the contract *is* the payer: a BIN wrongly attributed is worse than an
                        unnamed one.
                      */}
                      {(inContracts.get(g.bin) ?? []).map((h: ContractHit) => (
                        <span key={h.fileName} className="mt-1 block text-accent">
                          in {h.fileName}
                          {h.snippets[0] && <span className="block text-ink-3">&hellip;{h.snippets[0].slice(0, 160)}&hellip;</span>}
                        </span>
                      ))}
                    </td>
                    <td>
                      {canManage && (
                        <form action={name} className="flex flex-wrap items-center gap-1.5">
                          <input type="hidden" name="bin" value={g.bin} />
                          <input name="pbmName" required className="field w-44 py-1 text-xs" placeholder="PBM or plan name" />
                          <input name="helpDesk" className="field w-32 py-1 text-xs" placeholder="help desk" />
                          <button className="btn btn-sm">Name it</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-ink-3">
            Nothing is guessed. The published listing did not carry these, so somebody who knows which plan they are has
            to say — the claim&rsquo;s own payer name, where it carried one, is beside each as the starting point.
          </p>
        </section>
      )}

      {counts.bins === 0 ? (
        <Notice kind="warn">
          Nothing loaded yet. Put the reference CSVs in <code>data/reference/</code> and run the import below.
        </Notice>
      ) : null}

      <div className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="BINs" n={counts.bins} />
        <Stat label="Network rates" n={counts.rates} />
        <Stat label="Contract documents" n={counts.docs} />
        <Stat label="Payer notices" n={counts.communications} />
      </div>

      {/* ── BIN lookup: the question actually asked at the counter ── */}
      <section className="mb-6 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Look up a BIN</h2>
        <p className="mt-1 text-xs text-ink-3">
          Type the BIN from a claim. Sixty of them are used by more than one PBM, so where that happens every
          candidate is listed rather than one being guessed at.
        </p>
        <form className="mt-3 flex gap-2" method="GET">
          <input
            name="bin"
            defaultValue={bin ?? ""}
            placeholder="610011"
            inputMode="numeric"
            className="w-40 rounded-md border border-line px-3 py-2 text-sm"
          />
          <button className="rounded-md bg-ink px-3 py-2 text-sm text-white">Look up</button>
        </form>

        {hit && (
          <div className="mt-3">
            {hit.candidates.length === 0 ? (
              <Notice kind="warn">BIN {hit.bin} is not on the HMA listing. It may be a payer we hold no contract for.</Notice>
            ) : (
              <>
                {hit.ambiguous && (
                  <Notice kind="warn">
                    BIN {hit.bin} is shared by {hit.pbmNames?.length} PBMs. The PCN or network ID on the claim decides which.
                  </Notice>
                )}
                <ul className="mt-2 space-y-2">
                  {hit.candidates.map((c) => (
                    <li key={c.id} className="rounded-md border border-line p-3 text-sm">
                      <Link href={`/payers/${encodeURIComponent(c.pbmName)}`} className="font-medium underline">
                        {c.pbmName}
                      </Link>
                      {c.subNetwork && <span className="text-ink-3"> — {c.subNetwork}</span>}
                      {c.linesOfBusiness && <div className="mt-1 text-xs text-ink-3">{c.linesOfBusiness}</div>}
                      {c.macContact && <div className="mt-1 text-xs">MAC: {c.macContact}</div>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </section>

      {/* ── Directory ── */}
      <form className="mb-3 flex gap-2" method="GET">
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Filter by payer name or BIN"
          className="w-full max-w-sm rounded-md border border-line px-3 py-2 text-sm"
        />
        <button className="rounded-md border border-line px-3 py-2 text-sm">Filter</button>
      </form>

      {shown.length === 0 ? (
        <Empty>No payer matches that.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
              <tr>
                <th className="px-3 py-2">Payer</th>
                <th className="px-3 py-2">BINs</th>
                <th className="px-3 py-2">Rates</th>
                <th className="px-3 py-2">Appeal route</th>
                <th className="px-3 py-2">Payment</th>
                <th className="px-3 py-2">Contracts held</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.pbmName} className="border-t border-line">
                  <td className="px-3 py-2">
                    <Link href={`/payers/${encodeURIComponent(d.pbmName)}`} className="font-medium underline">
                      {d.pbmName}
                    </Link>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{d.bins.length || <span className="text-ink-3">—</span>}</td>
                  <td className="px-3 py-2 tabular-nums">{d.rates || <span className="text-ink-3">—</span>}</td>
                  <td className="px-3 py-2">{d.appeals ? "yes" : <span className="text-ink-3">—</span>}</td>
                  <td className="px-3 py-2">{d.hasRouting ? "yes" : <span className="text-ink-3">—</span>}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {d.docsKnown ? `${d.docsHere} / ${d.docsKnown}` : <span className="text-ink-3">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="mt-8 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Reload reference data</h2>
        <p className="mt-1 text-xs text-ink-3">
          Reads every CSV in <code>data/reference/</code> and rebuilds the tables above, then re-checks{" "}
          <code>data/contracts/</code> for the PDFs. Safe to run again at any time — it replaces rather than
          duplicates, and file matches already made are kept.
        </p>
        <form action={runImport} className="mt-3">
          <button className="rounded-md border border-line px-3 py-2 text-sm hover:bg-ground">Run import</button>
        </form>
      </section>
    </>
  );
}

function Stat({ label, n }: { label: string; n: number }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="text-xl font-semibold tabular-nums">{n.toLocaleString()}</div>
      <div className="text-xs text-ink-3">{label}</div>
    </div>
  );
}
