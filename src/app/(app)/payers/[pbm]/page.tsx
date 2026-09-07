import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { pbmProfile } from "@/lib/reference";
import { requireReimbursement } from "@/lib/features";
import { parseTerms } from "@/lib/contract-extract";
import { counterpartyFile, clocksDue, type CounterpartyFile } from "@/lib/contract-file";
import { todayIso, fmt } from "@/lib/dates";
import { PageHeader, Empty, Card, Figure } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * One counterparty's file: everything its documents said, organised the way it is used.
 *
 * The first screen is what a claim needs — the rates in force, how an appeal reaches them, where
 * the money comes from. Below it is everything else the documents carry and no table holds: the
 * chain of documents, what is taken back after a claim pays, the clocks, the reports owed, the
 * fees, the measures that move DIR, the definitions the money rests on, and what the documents
 * could not answer. Every line names its document and carries the document's own sentence, so a
 * figure here is never further than one hover from the words it came from.
 */
export default async function PayerPage({ params }: { params: Promise<{ pbm: string }> }) {
  await requireReimbursement();
  await requireUser();
  const { pbm } = await params;
  const name = decodeURIComponent(pbm);
  const p = await pbmProfile(name);

  const nothing = !p.bins.length && !p.rates.length && !p.appeals.length && !p.routing.length && !p.contacts.length && !p.docs.length;
  if (nothing) notFound();

  const today = todayIso();
  const file = counterpartyFile(
    name,
    p.docs.map((d) => ({ id: d.id, name: d.documentName, terms: d.extractionState === "done" ? parseTerms(d.extractionJson) : null, state: d.extractionState, fileName: d.fileName, pages: d.pages ?? null })),
  );
  const routing = p.routing[0];
  const appeal = p.appeals[0];
  const inForce = p.rates.filter((r) => r.status !== "superseded" && (!r.effectiveTo || r.effectiveTo >= today));
  const past = p.rates.filter((r) => !inForce.includes(r));
  const read = file.documents.filter((d) => d.state === "done").length;
  const soon = clocksDue(file, today, 90);
  const nextClock = file.clocks.find((c) => c.on && c.on >= today) ?? null;

  return (
    <>
      <PageHeader
        title={name}
        subtitle={[p.bins.length ? `${p.bins.length} BIN${p.bins.length === 1 ? "" : "s"} on the listing` : "Not on the BIN listing", `${p.docs.length} document${p.docs.length === 1 ? "" : "s"} on file, ${read} read`].join(" · ")}
        back={{ href: "/payers", label: "Payers" }}
        actions={
          <>
            <Link href={`/claims?payer=${encodeURIComponent(name)}`} className="btn">Claims</Link>
            <Link href="/claims/appeals" className="btn">Appeals</Link>
            <Link href="/payers/contracts" className="btn btn-primary">The contracts</Link>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Figure value={inForce.length} label="rates in force" sub={inForce.length ? [...new Set(inForce.map((r) => r.lineOfBusiness))].join(", ") : "nothing priced yet"} tone={inForce.length ? "ok" : "warn"} href="#rates" />
        <Figure value={appeal?.appealWindowDays ?? "—"} label="days to appeal" sub={appeal ? `from ${appeal.windowBasis?.replace(/_/g, " ") ?? "the date the contract names"}` : "no appeal terms on file"} tone={appeal ? "ok" : "warn"} href="#appeal" />
        <Figure value={routing?.paymentCycle ?? "—"} label="payment cycle" sub={routing ? `${routing.paymentMethod ?? "method not stated"} · ${routing.remittanceSource ?? "835 not stated"}` : "no payment path on file"} tone={routing ? "muted" : "warn"} href="#money" />
        <Figure value={file.takenBack.length} label="taken back after paying" sub={file.takenBack.length ? "DIR, fees and offsets the documents name" : "none named by the documents"} tone={file.takenBack.length ? "warn" : "muted"} href="#takenback" />
        <Figure value={nextClock ? fmt(nextClock.on) : "—"} label="next deadline" sub={nextClock ? nextClock.what : `${file.clocks.length} clock${file.clocks.length === 1 ? "" : "s"}, none with a date`} tone={soon.length ? "crit" : "muted"} href="#clocks" />
      </div>

      {/* ── The two things a short-paid claim needs ── */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card id="appeal" title="How a MAC appeal reaches them">
          {appeal ? (
            <dl className="space-y-1.5 text-sm">
              <Row k="Route">{appeal.submissionChannel ?? "Not stated"}</Row>
              <Row k="Send to">{appeal.submissionTarget ?? "Not stated"}</Row>
              <Row k="Window">{appeal.appealWindowDays ? `${appeal.appealWindowDays} days${appeal.windowBasis ? ` from ${appeal.windowBasis.replace(/_/g, " ")}` : ""}` : "Not stated"}</Row>
              <Row k="Must carry">{appeal.requiredFields ?? "Not stated"}</Row>
              <Row k="Invoice">{appeal.invoiceRequired ?? "Not stated"}</Row>
              <Row k="They answer in">{appeal.responseSlaDays ? `${appeal.responseSlaDays} days` : "Not stated"}</Row>
              <Row k="Retroactive">{appeal.adjustmentRetroactive ?? "Not stated"}</Row>
              <Row k="Escalation">{appeal.escalationContact ?? "—"}</Row>
              {appeal.notes && <div className="border-t border-line pt-2 text-xs text-ink-3">{appeal.notes}</div>}
            </dl>
          ) : (
            <Empty>No appeal route on file for this payer.</Empty>
          )}
        </Card>

        <Card id="money" title="Where the money comes from">
          {routing ? (
            <dl className="space-y-1.5 text-sm">
              <Row k="Pays via">{routing.paysVia ?? "—"}</Row>
              <Row k="Method">{routing.paymentMethod ?? "—"}</Row>
              <Row k="Remittance">{routing.remittanceSource ?? "—"}</Row>
              <Row k="Cycle">{routing.paymentCycle ?? "—"}</Row>
              {routing.notes && <div className="border-t border-line pt-2 text-xs text-ink-3">{routing.notes}</div>}
            </dl>
          ) : (
            <Empty>No payment path on file for this payer.</Empty>
          )}
          <p className="mt-3 text-xs text-ink-3">
            To have the 835 sent to the site: <Link href="/payers/routing" className="underline">835 routing</Link>.
          </p>
        </Card>
      </div>

      {/* ── Rates ── */}
      <Card id="rates" className="mt-4" title="Rates in force" count={inForce.length} subtitle="The contracted formulas, each from the document that carries it, with the guarantee that sits over the line kept apart. A claim is checked against these and against the NADAC floor.">
        {inForce.length === 0 ? (
          <Empty>No rate in force. Read the documents under Payers → The contracts, then apply what is certain.</Empty>
        ) : (
          <RateTable rows={inForce} />
        )}
        {past.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-ink-3 hover:text-accent">{past.length} superseded or ended, kept for the claims of their day</summary>
            <div className="mt-2"><RateTable rows={past} /></div>
          </details>
        )}
      </Card>

      {/* ── The chain ── */}
      <Card className="mt-4" title="The documents, in their chain" count={file.documents.length} subtitle="Base agreement first, then what amends it, then the exhibits and rate sheets, each saying what it replaces.">
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr><th>Document</th><th>Role</th><th>Effective</th><th>Ends</th><th>Replaces</th><th>Lines of business</th><th className="num">Rates</th><th>Read</th></tr>
            </thead>
            <tbody>
              {file.documents.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link href={`/payers/contracts/${d.id}`} className="font-medium hover:underline">{d.name}</Link>
                    {d.title && d.title !== d.name && <span className="block text-xs text-ink-3">{d.title}</span>}
                    {d.parent && <span className="block text-xs text-ink-3">attaches to {d.parent}</span>}
                  </td>
                  <td><span className="badge badge-muted">{d.role.replace(/_/g, " ")}</span></td>
                  <td className="whitespace-nowrap text-xs">{d.effective ?? "—"}</td>
                  <td className="whitespace-nowrap text-xs">{d.ends ?? "—"}</td>
                  <td className="text-xs text-ink-2">{d.supersedes.join("; ") || "—"}</td>
                  <td className="text-xs text-ink-2">{d.linesOfBusiness.join(", ") || "—"}</td>
                  <td className="num">{d.rates}</td>
                  <td className="whitespace-nowrap text-xs">
                    {d.state === "done" ? <span className="badge badge-ok">read{d.confidence != null ? ` · ${Math.round(d.confidence * 100)}%` : ""}</span> : d.state === "queued" ? <span className="badge badge-muted">reading</span> : d.state === "failed" ? <span className="badge badge-crit">refused</span> : <span className="badge badge-muted">unread</span>}
                    {d.caveats.length > 0 && <span className="ml-1 text-ink-3">{d.caveats.length} caveat{d.caveats.length === 1 ? "" : "s"}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(file.identifiers.bins.length > 0 || file.identifiers.pcns.length > 0 || file.identifiers.networkIds.length > 0) && (
          <p className="mt-3 text-xs text-ink-2">
            <b>Printed in the documents:</b>{" "}
            {[
              file.identifiers.bins.length && `BIN ${file.identifiers.bins.join(", ")}`,
              file.identifiers.pcns.length && `PCN ${file.identifiers.pcns.join(", ")}`,
              file.identifiers.groups.length && `group ${file.identifiers.groups.join(", ")}`,
              file.identifiers.chainCodes.length && `chain code ${file.identifiers.chainCodes.join(", ")}`,
              file.identifiers.networkIds.length && `network id ${file.identifiers.networkIds.join(", ")}`,
              file.identifiers.networks.length && `networks ${file.identifiers.networks.join(", ")}`,
            ].filter(Boolean).join(" · ")}
          </p>
        )}
      </Card>

      {/* ── What is taken back ── */}
      <Card id="takenback" className="mt-4" title="What is taken back after a claim pays" count={file.takenBack.length} tone={file.takenBack.length ? "warn" : undefined} subtitle="DIR by whatever name the contract gives it. Money withheld from a later cycle is why remittances do not reconcile to what was adjudicated.">
        {file.takenBack.length === 0 ? (
          <p className="text-sm text-ink-3">The documents name nothing taken back after the claim pays.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>What</th><th>Triggered by</th><th>How much</th><th>Collected</th><th>How often</th><th>Says</th></tr></thead>
              <tbody>
                {file.takenBack.map((t, i) => (
                  <tr key={i}>
                    <td className="font-medium">{t.name ?? "—"}{t.vendor && <span className="block text-xs text-ink-3">{t.vendor}</span>}</td>
                    <td className="text-xs">{t.trigger ?? "—"}</td>
                    <td className="text-xs">{t.calculation ?? "—"}</td>
                    <td className="text-xs">{t.collection ?? "—"}</td>
                    <td className="text-xs">{t.frequency ?? "—"}</td>
                    <td><Says from={t.from} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Clocks ── */}
      <Card id="clocks" className="mt-4" title="The clocks" count={file.clocks.length} tone={soon.length ? "crit" : undefined} subtitle="Every deadline the documents set. A dated one is a day on the calendar; the rest run from an event on each claim.">
        {file.clocks.length === 0 ? (
          <p className="text-sm text-ink-3">The documents set no deadline the reader could find.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>What</th><th>When</th><th>Rule</th><th>If missed</th><th>Says</th></tr></thead>
              <tbody>
                {file.clocks.map((c, i) => (
                  <tr key={i}>
                    <td className="font-medium">{c.what}</td>
                    <td className="whitespace-nowrap">{c.on ? <span className={`badge ${c.on < today ? "badge-muted" : soon.includes(c) ? "badge-crit" : "badge-ok"}`}>{fmt(c.on)}</span> : <span className="text-xs text-ink-3">per claim</span>}</td>
                    <td className="text-xs">{c.rule}</td>
                    <td className="text-xs text-ink-2">{c.consequence ?? "—"}</td>
                    <td><Says from={c.from} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Reports they owe" count={file.reportsOwed.length} subtitle="A report the counterparty must produce. One not arriving is itself a finding.">
          {file.reportsOwed.length === 0 ? <p className="text-sm text-ink-3">None named.</p> : (
            <ul className="rows">
              {file.reportsOwed.map((r, i) => (
                <li key={i} className="row">
                  <span className="min-w-0">
                    <span className="row-title">{r.name}</span>
                    <span className="row-why block">{[r.owedBy && `owed by ${r.owedBy}`, r.dueBy && `due ${r.dueBy}`, r.granularity].filter(Boolean).join(" · ")}</span>
                  </span>
                  <Says from={r.from} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Fees and the measures that move money" count={file.fees.length + file.measures.length} subtitle="Per-claim fees the counterparty charges, and the performance measures with their thresholds and what missing one does.">
          {file.fees.length + file.measures.length === 0 ? <p className="text-sm text-ink-3">None named.</p> : (
            <ul className="rows">
              {file.fees.map((f, i) => (
                <li key={`f${i}`} className="row">
                  <span className="min-w-0"><span className="row-title">{f.name}</span><span className="row-why block">{[f.amount, f.appliesTo].filter(Boolean).join(" · ")}</span></span>
                  <Says from={f.from} />
                </li>
              ))}
              {file.measures.map((m, i) => (
                <li key={`m${i}`} className="row">
                  <span className="min-w-0"><span className="row-title">{m.measure}</span><span className="row-why block">{[m.threshold && `threshold ${m.threshold}`, m.effect, m.period].filter(Boolean).join(" · ")}</span></span>
                  <Says from={m.from} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="The rules the money rests on" count={file.moneyRules.length + file.guarantees.length} subtitle="Which AWP prices the formula and as of when, where the MAC list lives, DAW penalties, recoupment, and the effective-rate guarantees the payer reconciles yearly.">
          {file.moneyRules.length + file.guarantees.length === 0 ? <p className="text-sm text-ink-3">None named.</p> : (
            <ul className="rows">
              {file.moneyRules.map((r, i) => (
                <li key={`r${i}`} className="row">
                  <span className="min-w-0"><span className="row-title">{r.what}</span><span className="row-why block">{r.value}</span></span>
                  <Says from={r.from} />
                </li>
              ))}
              {file.guarantees.map((g, i) => (
                <li key={`g${i}`} className="row">
                  <span className="min-w-0">
                    <span className="row-title">Effective-rate guarantee{g.network ? ` · ${g.network}` : ""}{g.vendor ? ` · ${g.vendor}` : ""}</span>
                    <span className="row-why block">{[g.brand && `brand ${g.brand}`, g.generic && `generic ${g.generic}`, g.basis, g.reconciledBy && `reconciled by ${g.reconciledBy}`].filter(Boolean).join(" · ")} — an aggregate, never a claim's price.</span>
                  </span>
                  <Says from={g.from} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Definitions, as this counterparty writes them" count={file.definitions.length} subtitle="Brand, generic, AWP, MAC and U&amp;C mean what the contract says they mean, and two contracts do not agree.">
          {file.definitions.length === 0 ? <p className="text-sm text-ink-3">None read.</p> : (
            <ul className="rows">
              {file.definitions.map((d, i) => (
                <li key={i} className="row">
                  <span className="min-w-0"><span className="row-title">{d.term}</span><span className="row-why block">{d.definition}</span></span>
                  <Says from={d.from} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {file.ladder && (
        <Card className="mt-4" title="The rebate ladder, as the agreement reads" subtitle="A wholesaler's compliance ladder read from its supply agreement. The one the buying actually earns against is typed on the supplier's terms page; compare them.">
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th className="num">From</th><th className="num">To</th><th className="num">Rebate</th><th>Says</th></tr></thead>
              <tbody>
                {file.ladder.tiers.map((t, i) => (
                  <tr key={i}><td className="num">{t.minPercent ?? "—"}%</td><td className="num">{t.maxPercent ?? "—"}%</td><td className="num">{t.rebatePercent ?? "—"}%</td><td><Says from={t.from} /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-ink-2">
            {[file.ladder.definition && `Ratio: ${file.ladder.definition}`, file.ladder.primaryRequirementPercent != null && `Primary requirement ${file.ladder.primaryRequirementPercent}%`, file.ladder.paymentTerms && `Paid ${file.ladder.paymentTerms}`].filter(Boolean).join(" · ")}{" "}
            <Link href="/suppliers" className="underline">Suppliers and rebates</Link>
          </p>
        </Card>
      )}

      {/* ── People and BINs ── */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="People" count={p.contacts.length}>
          {p.contacts.length === 0 ? <Empty>No contacts recorded.</Empty> : (
            <ul className="rows">
              {p.contacts.map((c) => (
                <li key={c.id} className="row">
                  <span className="min-w-0">
                    <span className="row-title capitalize">{c.contactType.replace(/_/g, " ")}</span>
                    <span className="row-why block">
                      {c.phone && <span className="mr-3">{c.phone}</span>}
                      {c.email && <a href={`mailto:${c.email}`} className="mr-3 underline">{c.email}</a>}
                      {c.portalUrl && <a href={c.portalUrl} className="underline" target="_blank" rel="noreferrer">portal</a>}
                      {c.notes && <span className="block text-ink-3">{c.notes}</span>}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="BINs on the listing" count={p.bins.length}>
          {p.bins.length === 0 ? <Empty>This payer has no BINs on the listing.</Empty> : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>BIN</th><th>Sub-network</th><th>Lines of business</th></tr></thead>
                <tbody>
                  {p.bins.map((b) => (
                    <tr key={b.id}>
                      <td className="font-mono tabular-nums">{b.bin}{b.collides && <span className="badge badge-warn ml-2">shared</span>}</td>
                      <td>{b.subNetwork ?? "—"}</td>
                      <td className="text-xs text-ink-3">{b.linesOfBusiness ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {file.unanswered.length > 0 && (
        <Card className="mt-4" title="What the documents could not answer" count={file.unanswered.length} tone="warn" subtitle="What the reader could not find or the document delegates elsewhere. Each is a document to ask the PSAO for, or a page to look at by eye.">
          <ul className="rows">
            {file.unanswered.map((u, i) => (
              <li key={i} className="row">
                <span className="min-w-0"><span className="row-title">{u.what}</span><span className="row-why block">{u.doc}</span></span>
                <Link href={`/payers/contracts/${u.docId}`} className="btn btn-sm">Open</Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {p.communications.length > 0 && (
        <Card className="mt-4" title="Recent notices" count={p.communications.length}>
          <ul className="rows">
            {p.communications.map((c) => (
              <li key={c.id} className="row">
                <span className="min-w-0">
                  <span className="row-title">{c.url ? <a href={c.url} target="_blank" rel="noreferrer" className="underline">{c.subject}</a> : c.subject}</span>
                  <span className="row-why block">{c.publishedDate}{c.type ? ` · ${c.type}` : ""}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function RateTable({ rows }: { rows: Awaited<ReturnType<typeof pbmProfile>>["rates"] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr><th>Line of business</th><th>Network</th><th>Days</th><th>Brand</th><th>Generic</th><th>In force</th><th>Guarantee over it</th><th>From</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="align-top">
              <td>{r.lineOfBusiness}</td>
              <td>{r.network}{r.status === "superseded" && <span className="badge badge-muted ml-2">superseded</span>}</td>
              <td className="whitespace-nowrap">{r.daysSupply ?? "—"}</td>
              <td>{r.brandRate ?? "—"}</td>
              <td>{r.genericRate ?? "—"}</td>
              <td className="whitespace-nowrap text-xs text-ink-3">{r.effectiveDate ?? "—"}{r.effectiveTo ? ` → ${r.effectiveTo}` : ""}</td>
              <td className="text-xs text-ink-3">{[r.berGuardrail && `BER ${r.berGuardrail}`, r.gerGuardrail && `GER ${r.gerGuardrail}`].filter(Boolean).join(" · ") || "—"}</td>
              <td className="text-xs text-ink-3">{r.sourceLabel ?? "—"}{r.notes && <span className="block max-w-[22rem] truncate" title={r.notes}>{r.notes}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The document a line came from, and its sentence, one hover away. */
function Says({ from }: { from: CounterpartyFile["clocks"][number]["from"] }) {
  return (
    <span className="block max-w-[18rem] text-xs text-ink-3" title={from.quote ? `“${from.quote}”${from.page ? ` — p.${from.page}` : ""}${from.section ? ` ${from.section}` : ""}` : undefined}>
      <Link href={`/payers/contracts/${from.docId}`} className="hover:underline">{from.doc}</Link>
      {from.quote && <span className="block truncate italic">“{from.quote}”</span>}
    </span>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2">
      <dt className="text-xs text-ink-3">{k}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
