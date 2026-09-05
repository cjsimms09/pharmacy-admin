import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { requireReimbursement } from "@/lib/features";
import { formatCents } from "@/lib/money";
import { payerMap, payerTree, GAP_MEANS, type ChainGap, type CompanyNode } from "@/lib/payer-map";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { savePayerLink, applyLinksToClaims } from "@/lib/payer-links";
import { searchContracts } from "@/lib/contract-search";
import { PageHeader, Card, Notice, Empty, Figure } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Who pays best" };

/**
 * The line from a claim to the money, drawn end to end, and what it shows.
 *
 * Five true things about the same payer were held in five places and never joined: the claim knew
 * the BIN, a listing knew which PBM that BIN belongs to, a register knew what kind of plan it is, a
 * folder held the contracts, and a rate table held what each network agreed to pay. None of them
 * could answer the only question worth asking — who pays us well, and who does not.
 *
 * Three sections, in the order the questions are asked. Who pays best. Which drugs are reimbursed
 * best, and by whom. And where the chain breaks, because a gap is a job and the kind of gap
 * decides which job: a BIN nobody can name is a chase, a named BIN with no contract is a document
 * to go and get, and a contract with no rate sheet is a reading job. Put in one bucket marked
 * "unknown", none of the three gets done.
 *
 * Every figure is worked out over fills, never over claims. A prescription billed to a primary and
 * then a secondary is one bottle and two rows carrying the same acquisition cost; ranked per claim,
 * the primary of every coordinated fill sinks its payer to the bottom of the table on money the
 * pharmacy was in fact paid.
 */
export default async function PayerPerformancePage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireReimbursement();
  const user = await requireUser();
  const { ok, error } = await searchParams;
  const canManage = user.role !== "staff";
  const { links, scores, ndcs, totals } = await payerMap();
  const { companies, unnamedRevenueCents } = await payerTree();

  /*
   * Settling one of these, once.
   *
   * The contracts are searched for the BIN when the row is drawn; confirming turns that candidate
   * into a fact this site holds, so nothing searches for it again and every claim already on file
   * is attributed in the same press.
   */
  async function confirm(fd: FormData) {
    "use server";
    const u = await requireManager();
    const bin = String(fd.get("bin") ?? "") || null;
    const groupNumber = String(fd.get("groupNumber") ?? "") || null;
    try {
      const r = await savePayerLink(
        { bin, pcn: null, groupNumber, contractId: null },
        {
          pbmName: String(fd.get("pbmName") ?? ""),
          contractFileName: String(fd.get("contractFileName") ?? "") || null,
          basis: String(fd.get("basis") ?? "") || null,
        },
        u,
      );
      const applied = await applyLinksToClaims();
      await audit({ action: "payer.link", userId: u.id, userName: u.name, details: `${bin ?? ""}/${groupNumber ?? ""} → ${String(fd.get("pbmName") ?? "")}` });
      revalidatePath("/payers/performance");
      revalidatePath("/payers");
      revalidatePath("/claims");
      redirect(
        "/payers/performance?ok=" +
          encodeURIComponent(
            `${r.replaced ? "Corrected" : "Linked"}. ${applied.claims} claim${applied.claims === 1 ? "" : "s"} already held ${applied.claims === 1 ? "was" : "were"} attributed, and nothing searches the contracts for this again.`,
          ),
      );
    } catch (e) {
      if (e && typeof e === "object" && "digest" in e) throw e;
      redirect("/payers/performance?error=" + encodeURIComponent(e instanceof Error ? e.message : "Could not save that."));
    }
  }

  // The contract that mentions each unnamed BIN, offered as the candidate to confirm.
  const candidates = new Map<string, { fileName: string; snippet: string } | null>();
  for (const l of links) {
    if (l.gaps.length === 0 || !l.bin || l.link) continue;
    const hits = await searchContracts(l.bin, 1);
    candidates.set(l.bin, hits[0] ? { fileName: hits[0].fileName, snippet: hits[0].snippets[0] ?? "" } : null);
  }

  const ranked = scores.filter((s) => s.fills >= 1);
  const best = ranked.slice(0, 8);
  const worst = [...ranked].reverse().slice(0, 8);
  const spread = ndcs.filter((n) => n.spreadPerFillCents !== null && n.spreadPerFillCents > 0).sort((a, b) => (b.spreadPerFillCents ?? 0) - (a.spreadPerFillCents ?? 0));
  const unmapped = links.filter((l) => l.gaps.length > 0);

  return (
    <>
      <PageHeader
        back={{ href: "/payers", label: "Payers" }}
        title="Who pays best"
        subtitle="Every claim followed through to the money: BIN and group, to plan, to PBM, to the contract and the rate sheet behind it. Counted per dispensing, so a fill billed to two plans is one bottle."
        actions={
          <>
            <Link href="/claims/floor" className="btn">Kansas floor (SB 20)</Link>
            <Link href="/plans" className="btn">Classify plans</Link>
            <Link href="/claims" className="btn">Claims</Link>
          </>
        }
      />

      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {totals.fills === 0 ? (
        <Empty>No claims are held yet, so there is nothing to follow. Load a day&rsquo;s transaction report first.</Empty>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <Figure value={totals.fills.toLocaleString()} label="dispensings held" sub="Not transmissions — a fill billed twice is one" tone="muted" />
            <Figure value={formatCents(totals.revenueCents)} label="came in" sub="Plans and patients together" tone="muted" />
            <Figure value={formatCents(totals.marginCents)} label="over acquisition" sub="Before every cost but the drug" tone={totals.marginCents < 0 ? "crit" : "ok"} />
            <Figure
              value={`${totals.fills ? Math.round((totals.mappedFills / totals.fills) * 100) : 0}%`}
              label="followed all the way through"
              sub="Named, classified, contract and rates on file"
              tone={totals.mappedFills < totals.fills ? "warn" : "ok"}
            />
          </div>

          {/* ── Who pays best, and who does not ─────────────────────────── */}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card title="Paying best" subtitle="By what a single dispensing is worth, which is what decides whether a plan is worth being in. A big payer paying thinly is a different problem from a small one paying well.">
              <Table rows={best} />
            </Card>
            <Card tone={worst.some((w) => w.marginPerFillCents < 0) ? "crit" : "warn"} title="Paying worst" subtitle="Lowest first. A payer below the line is one every fill costs money on — worth an appeal, a network decision, or at least knowing about.">
              <Table rows={worst} />
            </Card>
          </div>

          {/* ── The drugs, and who pays best for each ───────────────────── */}
          <Card
            className="mt-4"
            title="What each drug is reimbursed"
            count={ndcs.length}
            subtitle="Per dispensing, against what the drug actually cost. Where the same drug has gone to more than one plan, the best and worst are named and the gap between them is what steering or appealing is worth."
          >
            {ndcs.length === 0 ? (
              <Empty>Nothing yet — this needs claims carrying an NDC and an acquisition cost.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Drug</th><th className="text-right">Fills</th>
                      <th className="text-right">Came in</th><th className="text-right">Cost</th><th className="text-right">Margin</th>
                      <th>Best payer</th><th>Worst payer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ndcs.slice(0, 40).map((n) => (
                      <tr key={n.ndc11}>
                        <td>
                          <span className="block text-sm">{n.name ?? "—"}</span>
                          <span className="font-mono text-[11px] text-ink-3">{n.ndc11}</span>
                        </td>
                        <td className="num text-sm">{n.fills}</td>
                        <td className="num text-sm">{formatCents(n.revenueCents)}</td>
                        <td className="num text-sm">{formatCents(n.costCents)}</td>
                        <td className={`num text-sm font-medium ${n.marginCents < 0 ? "text-crit" : "text-accent"}`}>{formatCents(n.marginCents)}</td>
                        <td className="text-xs">
                          {n.bestPayer ? (
                            <>
                              {n.bestPayer.name}
                              <span className="block text-ink-3">{formatCents(n.bestPayer.marginCents)} over {n.bestPayer.fills} fill{n.bestPayer.fills === 1 ? "" : "s"}</span>
                            </>
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </td>
                        <td className="text-xs">
                          {n.worstPayer ? (
                            <>
                              {n.worstPayer.name}
                              <span className="block text-ink-3">{formatCents(n.worstPayer.marginCents)} over {n.worstPayer.fills} fill{n.worstPayer.fills === 1 ? "" : "s"}</span>
                            </>
                          ) : (
                            <span className="text-ink-3">only one plan so far</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {spread.length > 0 && (
              <div className="mt-3 rounded-md border border-line bg-ground p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">The same drug, priced differently</p>
                <ul className="mt-1 space-y-1 text-sm">
                  {spread.slice(0, 5).map((n) => (
                    <li key={n.ndc11}>
                      <b>{n.name ?? n.ndc11}</b>: {n.bestPayer!.name} pays {formatCents(n.spreadPerFillCents!)} more per fill than{" "}
                      {n.worstPayer!.name}.
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-ink-3">
                  A gap is not by itself wrong — plans buy different things. It is where an appeal has something to point
                  at, and where a rate sheet is worth reading.
                </p>
              </div>
            )}
          </Card>

          {/* ── The hierarchy, as it actually is ───────────────────────── */}
          <Card
            className="mt-4"
            title="Company, BIN, group, contract"
            count={companies.length}
            subtitle="Four levels, and each answers a different question. Which company is worth negotiating with. Which processing route is underpaying. Which employer's plan is the problem — that is the level ERISA or Part D is decided at, never the BIN. And which contract priced the fill, which is what an appeal has to cite."
          >
            {unnamedRevenueCents > 0 && (
              <Notice kind="warn">
                {formatCents(unnamedRevenueCents)} of it comes through routes no company has been named for. Until one is,
                the money cannot be added up by who owes it.
              </Notice>
            )}
            <ul className="mt-2 space-y-2">
              {companies.map((c: CompanyNode) => (
                <li key={c.company} className="rounded-lg border border-line">
                  <details open={companies.length <= 3}>
                    <summary className="cursor-pointer px-3 py-2">
                      <span className="text-sm font-semibold">{c.company}</span>
                      {!c.named && <span className="badge badge-warn ml-2">not named</span>}
                      <span className="ml-2 text-xs text-ink-3">
                        {Math.round(c.fills)} fill{Math.round(c.fills) === 1 ? "" : "s"} · {formatCents(c.revenueCents)} in ·{" "}
                        <span className={c.marginPerFillCents < 0 ? "text-crit" : "text-accent"}>{formatCents(c.marginPerFillCents)} a fill</span>
                      </span>
                    </summary>
                    <div className="border-t border-line px-3 py-2">
                      {c.bins.map((b) => (
                        <div key={b.bin ?? "none"} className="mb-2 last:mb-0">
                          <p className="font-mono text-xs">
                            BIN {b.bin ?? "—"}
                            <span className="ml-2 font-sans text-ink-3">
                              {Math.round(b.fills)} fill{Math.round(b.fills) === 1 ? "" : "s"} · {formatCents(b.revenueCents)}
                            </span>
                            {b.mixedClassification && (
                              <span className="badge badge-muted ml-2 font-sans" title="This BIN carries plans of more than one kind, which is why the Kansas floor can never be decided at BIN level.">
                                more than one kind of plan
                              </span>
                            )}
                          </p>
                          <ul className="ml-4 mt-1 space-y-1">
                            {b.groups.map((g) => (
                              <li key={g.groupNumber ?? "none"} className="text-xs">
                                <span className="font-mono">group {g.groupNumber ?? "—"}</span>
                                {g.sponsorName && <span className="ml-1 text-ink-2">{g.sponsorName}</span>}
                                {g.classification && g.classification !== "unknown" ? (
                                  <span className="badge badge-muted ml-1">{g.classification.replace(/_/g, " ")}</span>
                                ) : (
                                  <Link href="/plans" className="badge badge-warn ml-1">not classified</Link>
                                )}
                                <span className="ml-1 text-ink-3">
                                  {formatCents(g.revenueCents)} in ·{" "}
                                  <span className={g.marginCents < 0 ? "text-crit" : "text-accent"}>{formatCents(g.marginCents)}</span>
                                </span>
                                <ul className="ml-4">
                                  {g.contracts.map((ct) => (
                                    <li key={ct.contractId ?? "none"} className="text-[11px] text-ink-3">
                                      contract {ct.contractId ?? "— none on the claim"}
                                      {ct.contractFileName ? (
                                        <span className="text-accent"> → {ct.contractFileName}</span>
                                      ) : (
                                        <span className="text-warn"> → no agreement linked</span>
                                      )}
                                      {" · "}{formatCents(ct.revenueCents)}
                                    </li>
                                  ))}
                                </ul>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-3">
              A BIN is a processing route, not a plan: the same BIN carries a fully-insured commercial plan the Kansas
              floor applies to and a self-funded ERISA plan it cannot touch. The group number separates them, and the
              contract id printed on the claim names the agreement that priced it.
            </p>
          </Card>

          {/* ── Where the line stops ────────────────────────────────────── */}
          <Card
            className="mt-4"
            tone={unmapped.length ? "warn" : "ok"}
            title="Where the chain breaks"
            count={`${links.length - unmapped.length} of ${links.length} complete`}
            subtitle="A gap is a job, and the kind of gap decides which job. Put in one bucket marked unknown, none of them gets done."
          >
            {unmapped.length === 0 ? (
              <Notice kind="ok">Every plan billed is named, classified, and has a contract and a rate sheet on file.</Notice>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr><th>BIN / group</th><th>Who</th><th className="text-right">Fills</th><th className="text-right">Came in</th><th>What is missing</th></tr>
                  </thead>
                  <tbody>
                    {unmapped.slice(0, 40).map((l) => (
                      <tr key={`${l.bin}|${l.groupNumber}`}>
                        <td className="font-mono text-xs">
                          {l.bin ?? "—"}
                          {l.groupNumber && <span className="block text-ink-3">{l.groupNumber}</span>}
                        </td>
                        <td className="text-sm">
                          {l.pbmName ?? (l.pbmNames.length > 1 ? <span className="text-warn">{l.pbmNames.join(" or ")}</span> : <span className="text-ink-3">not named</span>)}
                          {l.sponsorName && <span className="block text-xs text-ink-3">{l.sponsorName}</span>}
                        </td>
                        <td className="num text-sm">{Math.round(l.fills)}</td>
                        <td className="num text-sm">{formatCents(l.revenueCents)}</td>
                        <td className="text-xs">
                          {l.gaps.map((g: ChainGap) => (
                            <span key={g} className="badge badge-warn mr-1 mb-0.5 inline-block">{GAP_MEANS[g]}</span>
                          ))}
                          {/*
                            The candidate, and the press that turns it into a fact.

                            Searching found it; confirming remembers it. Without this the same
                            twenty PDFs are read again on the next page load and nobody's decision
                            is ever written down.
                          */}
                          {canManage && (
                            <form action={confirm} className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              <input type="hidden" name="bin" value={l.bin ?? ""} />
                              <input type="hidden" name="groupNumber" value={l.groupNumber ?? ""} />
                              <input
                                name="pbmName"
                                required
                                className="field w-40 py-1 text-[11px]"
                                defaultValue={l.pbmNames[0] ?? ""}
                                placeholder="Who is this?"
                              />
                              <input
                                name="contractFileName"
                                className="field w-48 py-1 text-[11px]"
                                defaultValue={l.bin ? (candidates.get(l.bin)?.fileName ?? "") : ""}
                                placeholder="contract file, if known"
                              />
                              <button className="btn btn-sm text-[11px]">Link it, once</button>
                              {l.bin && candidates.get(l.bin) && (
                                <span className="block w-full text-[11px] text-ink-3">
                                  found in {candidates.get(l.bin)!.fileName}: &hellip;{candidates.get(l.bin)!.snippet.slice(0, 140)}&hellip;
                                </span>
                              )}
                            </form>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs text-ink-3">
              Name a BIN on <Link href="/payers" className="text-accent underline">Payers</Link> — the contracts already on
              file are searched for it there. Classify a plan on{" "}
              <Link href="/plans" className="text-accent underline">Plans</Link>. Nothing here guesses: a BIN attributed to
              the wrong PBM is worse than an unnamed one, because an appeal then goes to the wrong place.
            </p>
          </Card>
        </>
      )}
    </>
  );
}

function Table({ rows }: { rows: import("@/lib/payer-map").PayerScore[] }) {
  if (rows.length === 0) return <Empty>Nothing to rank yet.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr><th>Payer</th><th className="text-right">Fills</th><th className="text-right">Per fill</th><th className="text-right">Margin</th><th className="text-right">%</th></tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.pbmName}>
              <td>
                <span className="block text-sm">{s.pbmName}</span>
                <span className="font-mono text-[11px] text-ink-3">
                  {s.bins.join(", ") || "no BIN"}
                  {s.fillsAtALoss > 0 && <span className="text-warn"> · {s.fillsAtALoss} at a loss</span>}
                  {!s.fullyMapped && <span className="text-ink-3"> · chain incomplete</span>}
                </span>
              </td>
              <td className="num text-sm">{s.fills}</td>
              <td className={`num text-sm font-medium ${s.marginPerFillCents < 0 ? "text-crit" : "text-accent"}`}>{formatCents(s.marginPerFillCents)}</td>
              <td className="num text-sm">{formatCents(s.marginCents)}</td>
              <td className="num text-sm">{s.marginPercent === null ? "—" : `${s.marginPercent}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
