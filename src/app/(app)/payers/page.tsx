import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { importReference, referenceCounts, pbmDirectory, lookupBin, scanContracts } from "@/lib/reference";
import { PageHeader, Notice, Empty } from "@/components/ui";

export const metadata = { title: "Payers" };
export const dynamic = "force-dynamic";

export default async function PayersPage({ searchParams }: { searchParams: Promise<{ bin?: string; q?: string; imported?: string; error?: string }> }) {
  await requireUser();
  const { bin, q, imported, error } = await searchParams;
  const counts = await referenceCounts();
  const directory = await pbmDirectory();
  const hit = bin?.trim() ? await lookupBin(bin) : null;

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

  return (
    <>
      <PageHeader
        title="Payers"
        subtitle="Every BIN we bill, the network rates behind it, how a MAC appeal reaches it, and where the money comes from."
      />

      {imported && <Notice kind="ok">Imported. {imported}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

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
