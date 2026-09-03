import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { pbmProfile } from "@/lib/reference";
import { PageHeader, BackLink, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function PayerPage({ params }: { params: Promise<{ pbm: string }> }) {
  await requireUser();
  const { pbm } = await params;
  const name = decodeURIComponent(pbm);
  const p = await pbmProfile(name);

  const nothing = !p.bins.length && !p.rates.length && !p.appeals.length && !p.routing.length && !p.contacts.length && !p.docs.length;
  if (nothing) notFound();

  const routing = p.routing[0];
  const appeal = p.appeals[0];

  return (
    <>
      <BackLink href="/payers">Payers</BackLink>
      <PageHeader title={name} subtitle={p.bins.length ? `${p.bins.length} BIN${p.bins.length === 1 ? "" : "s"} on the HMA listing` : "Not on the HMA BIN listing"} />

      {/* ── The two things you need when a claim underpays ── */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="How a MAC appeal reaches them">
          {appeal ? (
            <dl className="space-y-2 text-sm">
              <Row k="Route">{appeal.submissionChannel ?? "Not published"}</Row>
              <Row k="Send to">{appeal.submissionTarget ?? "Not published"}</Row>
              <Row k="Their window">
                {appeal.appealWindowDays ? `${appeal.appealWindowDays} days${appeal.windowBasis ? ` from ${appeal.windowBasis}` : ""}` : "Not published"}
              </Row>
              <Row k="Retroactive?">{appeal.adjustmentRetroactive ?? "Not published"}</Row>
              <Row k="Escalation">{appeal.escalationContact ?? "—"}</Row>
              {appeal.notes && <div className="border-t border-line pt-2 text-xs text-ink-3">{appeal.notes}</div>}
            </dl>
          ) : (
            <Empty>No appeal route recorded for this payer.</Empty>
          )}
        </Card>

        <Card title="Where the money comes from">
          {routing ? (
            <dl className="space-y-2 text-sm">
              <Row k="Pays via">{routing.paysVia ?? "—"}</Row>
              <Row k="Method">{routing.paymentMethod ?? "—"}</Row>
              <Row k="Remittance">{routing.remittanceSource ?? "—"}</Row>
              <Row k="Cycle">{routing.paymentCycle ?? "—"}</Row>
              {routing.notes && <div className="border-t border-line pt-2 text-xs text-ink-3">{routing.notes}</div>}
            </dl>
          ) : (
            <Empty>No payment route recorded for this payer.</Empty>
          )}
        </Card>
      </div>

      {/* ── Rates ── */}
      <h2 className="mt-8 text-sm font-semibold">Network rates</h2>
      <p className="mb-2 text-xs text-ink-3">
        As published by Health Mart Atlas. These are the contracted formulas, not what was actually paid — a claim is
        checked by comparing the remittance against these and against the NADAC floor.
      </p>
      {p.rates.length === 0 ? (
        <Empty>No published rates for this payer.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
              <tr>
                <th className="px-3 py-2">Line of business</th>
                <th className="px-3 py-2">Network</th>
                <th className="px-3 py-2">Days</th>
                <th className="px-3 py-2">Brand</th>
                <th className="px-3 py-2">Generic</th>
                <th className="px-3 py-2">Effective</th>
              </tr>
            </thead>
            <tbody>
              {p.rates.map((r) => (
                <tr key={r.id} className="border-t border-line align-top">
                  <td className="px-3 py-2">{r.lineOfBusiness}</td>
                  <td className="px-3 py-2">{r.network}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.daysSupply ?? "—"}</td>
                  <td className="px-3 py-2">{r.brandRate ?? "—"}</td>
                  <td className="px-3 py-2">{r.genericRate ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-ink-3">{r.effectiveDate ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── BINs ── */}
      <h2 className="mt-8 text-sm font-semibold">BINs</h2>
      {p.bins.length === 0 ? (
        <Empty>This payer has no BINs on the HMA listing.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-ground text-left text-xs uppercase tracking-wide text-ink-3">
              <tr>
                <th className="px-3 py-2">BIN</th>
                <th className="px-3 py-2">Sub-network</th>
                <th className="px-3 py-2">Lines of business</th>
              </tr>
            </thead>
            <tbody>
              {p.bins.map((b) => (
                <tr key={b.id} className="border-t border-line align-top">
                  <td className="px-3 py-2 font-mono tabular-nums">
                    {b.bin}
                    {b.collides && <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-900">shared</span>}
                  </td>
                  <td className="px-3 py-2">{b.subNetwork ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-ink-3">{b.linesOfBusiness ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Contacts ── */}
      <h2 className="mt-8 text-sm font-semibold">Contacts</h2>
      {p.contacts.length === 0 ? (
        <Empty>No contacts recorded.</Empty>
      ) : (
        <ul className="space-y-2">
          {p.contacts.map((c) => (
            <li key={c.id} className="rounded-md border border-line bg-surface p-3 text-sm">
              <div className="font-medium capitalize">{c.contactType.replace(/_/g, " ")}</div>
              <div className="mt-1 space-x-3 text-ink-2">
                {c.phone && <span>{c.phone}</span>}
                {c.email && <a href={`mailto:${c.email}`} className="underline">{c.email}</a>}
                {c.portalUrl && <a href={c.portalUrl} className="underline" target="_blank" rel="noreferrer">portal</a>}
              </div>
              {c.notes && <div className="mt-1 text-xs text-ink-3">{c.notes}</div>}
            </li>
          ))}
        </ul>
      )}

      {/* ── Contracts ── */}
      <h2 className="mt-8 text-sm font-semibold">Contract documents</h2>
      {p.docs.length === 0 ? (
        <Empty>No documents catalogued for this payer.</Empty>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface text-sm">
          {p.docs.map((d) => (
            <li key={d.id} className="flex items-start justify-between gap-3 px-3 py-2">
              <div>
                <div>{d.documentName}</div>
                <div className="text-xs text-ink-3">
                  {[d.documentType, d.effectiveYear].filter(Boolean).join(" · ") || "—"}
                  {d.priority && <span className="ml-2 rounded bg-ink px-1 text-white">priority</span>}
                </div>
              </div>
              <div className="whitespace-nowrap text-xs">
                {d.fileName ? <span className="text-emerald-700">on file</span> : <span className="text-ink-3">not downloaded</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* ── Notices ── */}
      {p.communications.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-semibold">Recent notices</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface text-sm">
            {p.communications.map((c) => (
              <li key={c.id} className="px-3 py-2">
                <div className="text-xs text-ink-3">{c.publishedDate}{c.type ? ` · ${c.type}` : ""}</div>
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer" className="underline">{c.subject}</a>
                ) : (
                  c.subject
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="mt-8 text-xs text-ink-3">
        Everything on this page came from the Health Mart Atlas PBM Contract Resources portal. Each source row carries
        its own URL in the database, so any figure here can be traced back to the page it was read from.{" "}
        <Link href="/payers" className="underline">Back to payers</Link>
      </p>
    </>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
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
