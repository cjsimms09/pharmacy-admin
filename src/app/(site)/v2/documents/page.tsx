import Link from "next/link";
import { documentsView } from "@/lib/engine/read";
import { todayIso, atLocal } from "@/lib/dates";
import { rereadArrival, teachArrival, undoArrival, sweepNow, addDocument } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Documents: what arrived and what the site did with it; what still needs a person; a document added by hand;
 * search across everything; the forms the manual's appendix produces; and the retention clock over every document
 * on file — what may now go, what must never, and what is awaiting the owner's word.
 */

const TABS = [
  ["arrived", "Arrived"],
  ["held", "Held"],
  ["add", "Add"],
  ["search", "Search"],
  ["forms", "Forms"],
  ["retention", "Retention"],
] as const;
type Tab = (typeof TABS)[number][0];

const CATEGORIES = ["supplier_catalog", "supplier_invoice", "expense_invoice", "claims_export", "rx_transactions", "payer_payments", "remittance", "nadac", "contract", "compliance_document", "era_enrollment", "appeal", "rebate_report", "purchase_report", "supplier_statement", "credit_memo", "sales_summary", "inventory_count", "bank_statement", "return_policy"];
const DOC_CATEGORIES = ["policy", "insurance", "agreement", "license", "pharmacy_registration", "dea_registration", "controlled_substance_poa", "cqi_summary", "training_record", "immunization_training", "cpr_card", "supplier_agreement", "bank_statement", "other"];

const th = "py-2 text-left text-[11px] font-medium uppercase tracking-wide text-ink-3";
const td = "border-t border-line py-1.5 text-[13px] text-ink align-top";

function Chip({ tone, children }: { tone: "ok" | "warn" | "crit" | "muted"; children: React.ReactNode }) {
  const cls = { ok: "bg-accent-soft text-accent-strong", warn: "bg-warn-soft text-warn", crit: "bg-crit-soft text-crit", muted: "bg-ground text-ink-3" }[tone];
  return <span className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>;
}

function Figure({ label, value, sub, href, tone }: { label: string; value: string; sub?: string; href?: string; tone?: "warn" | "crit" }) {
  const body = (
    <>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
      <div className={`mt-1 text-[22px] font-semibold tabular-nums ${tone === "crit" ? "text-crit" : tone === "warn" ? "text-warn" : "text-ink"}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[12px] text-ink-3">{sub}</div> : null}
    </>
  );
  return href ? (
    <Link href={href} className="block rounded-lg border border-line bg-surface px-4 py-3 hover:border-accent">
      {body}
    </Link>
  ) : (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">{body}</div>
  );
}

function ArrivalRow({ a, tab }: { a: Awaited<ReturnType<typeof documentsView>>["arrived"][number]; tab: string }) {
  return (
    <tr>
      <td className={`${td} tabular-nums text-ink-3`}>{atLocal(a.receivedAt)}</td>
      <td className={td}>
        <span className="text-ink-2">{a.source}</span>
        <span className="block text-[11px] text-ink-3">{a.from ?? ""}</span>
      </td>
      <td className={td}>
        {a.documentId ? (
          <Link href={`/files/${a.documentId}`} className="hover:underline">{(a.fileName ?? a.subject ?? "file").slice(0, 48)}</Link>
        ) : (
          <span>{(a.fileName ?? a.subject ?? "").slice(0, 48)}</span>
        )}
        {a.subject && a.fileName ? <span className="block text-[11px] text-ink-3">{a.subject.slice(0, 60)}</span> : null}
      </td>
      <td className={td}>
        <Chip tone={a.story.tone}>{a.story.headline.slice(0, 60)}</Chip>
        {a.story.changed ? <span className="block text-[12px] text-ink-2">{a.story.changed}</span> : null}
        {a.story.why ? <span className="block text-[11px] text-ink-3">{a.story.why}</span> : null}
        {a.settledBy ? <span className="block text-[11px] text-ink-3">since taken up by {a.settledBy}</span> : null}
      </td>
      <td className={td}>
        {a.needsAttention || a.story.invitesRerouting ? (
          <div className="flex flex-col gap-1 text-[12px]">
            <form action={rereadArrival}>
              <input type="hidden" name="tab" value={tab} />
              <input type="hidden" name="itemId" value={a.id} />
              <button type="submit" className="rounded-md border border-line bg-surface px-2 py-0.5 hover:border-accent">Read it again</button>
            </form>
            <form action={teachArrival} className="flex items-center gap-1">
              <input type="hidden" name="tab" value={tab} />
              <input type="hidden" name="itemId" value={a.id} />
              <select name="category" className="rounded-md border border-line bg-surface px-1 py-0.5" defaultValue="">
                <option value="">this sender&apos;s files are…</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
                ))}
              </select>
              <button type="submit" className="rounded-md border border-line bg-surface px-2 py-0.5 hover:border-accent">Teach</button>
            </form>
            {a.documentId ? (
              <form action={undoArrival}>
                <input type="hidden" name="tab" value={tab} />
                <input type="hidden" name="itemId" value={a.id} />
                <button type="submit" className="rounded-md border border-line bg-surface px-2 py-0.5 text-ink-2 hover:border-crit hover:text-crit">Take it back out</button>
              </form>
            ) : null}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const today = todayIso();
  const tab = (TABS.some(([k]) => k === sp.tab) ? sp.tab : "arrived") as Tab;
  const error = typeof sp.error === "string" ? sp.error : null;
  const ok = typeof sp.ok === "string" ? sp.ok : null;
  const query = typeof sp.q === "string" ? sp.q.trim() : "";
  const v = await documentsView(today);
  const found = tab === "search" && query ? await (await import("@/lib/find")).findAnything(query) : [];
  const q = (t: Tab) => `/v2/documents?tab=${t}`;
  const held = v.arrived.filter((a) => a.needsAttention);
  const mayDestroy = v.retention.kinds.reduce((n, k) => n + k.mayDestroy, 0);
  const awaiting = v.retention.awaiting.reduce((n, a) => n + a.documents, 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[18px] font-semibold text-ink">Documents</h1>
        <form action={sweepNow} className="ml-auto">
          <input type="hidden" name="tab" value={tab} />
          <button type="submit" className="rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-ink-2 hover:border-accent hover:text-ink">Sweep the mailbox now</button>
        </form>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Figure label="Arrived" value={String(v.arrived.length)} sub="latest 200 arrivals" href={q("arrived")} />
        <Figure label="Need you" value={String(held.length)} sub="not recognised, refused, or held" href={q("held")} tone={held.length ? "warn" : undefined} />
        <Figure label="On file" value={String(v.counts.documents)} sub={`${v.counts.categories} kinds · ${v.counts.last30} in the last 30 days`} href={q("search")} />
        <Figure label="May be destroyed" value={String(mayDestroy)} sub="past their retention period" href={q("retention")} />
        <Figure label="Awaiting your word" value={String(awaiting)} sub="no retention rule yet, or undated" href={q("retention")} tone={awaiting ? "warn" : undefined} />
        <Figure label="Forms" value={String(v.forms.length)} sub={v.appendixVersion ? `appendix ${v.appendixVersion}` : "the manual's appendix"} href={q("forms")} />
      </div>

      <nav className="flex items-center gap-1 border-b border-line text-[14px]">
        {TABS.map(([key, label]) => (
          <Link key={key} href={q(key)} className={`-mb-px border-b-2 px-3 py-2 ${tab === key ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}>
            {label}
          </Link>
        ))}
        <span className="ml-auto flex items-center gap-2 text-[13px] text-ink-3">
          <Link href="/inbox" className="hover:text-ink">Mail settings</Link>·<Link href="/intake" className="hover:text-ink">Intake</Link>·<Link href="/audit" className="hover:text-ink">Audit log</Link>
        </span>
      </nav>

      {error ? <p className="rounded-md bg-crit-soft px-3 py-2 text-[13px] text-crit">{error}</p> : null}
      {ok ? <p className="rounded-md bg-accent-soft px-3 py-2 text-[13px] text-accent-strong">{ok}</p> : null}

      {tab === "arrived" || tab === "held" ? (
        <section className="space-y-3">
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            {(tab === "held" ? held : v.arrived).length === 0 ? (
              <p className="py-4 text-[14px] text-ink-2">{tab === "held" ? "Nothing needs you. Every arrival was recognised and taken up." : "Nothing has arrived yet."}</p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Arrived</th>
                    <th className={th}>Where from</th>
                    <th className={th}>File</th>
                    <th className={th}>What happened to it</th>
                    <th className={th}>Put it right</th>
                  </tr>
                </thead>
                <tbody>
                  {(tab === "held" ? held : v.arrived).map((a) => (
                    <ArrivalRow key={a.id} a={a} tab={tab} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="text-[12.5px] text-ink-3">An arrival is read by the reader its shape names, its arithmetic checked, and loaded; one nothing recognises is stored and shown here until a person says what it is, which becomes a rule for that sender. Taking one back out reverses what it loaded.</p>
        </section>
      ) : null}

      {tab === "add" ? (
        <section className="space-y-3">
          <form action={addDocument} className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px]" encType="multipart/form-data">
            <input type="hidden" name="tab" value="add" />
            <div className="flex flex-wrap items-center gap-2">
              <input type="file" name="file" className="text-[12px]" required />
              <select name="category" className="rounded-md border border-line bg-surface px-2 py-1" defaultValue="other">
                {DOC_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
                ))}
              </select>
              <input name="title" placeholder="title" className="w-56 rounded-md border border-line bg-surface px-2 py-1" />
              <label className="flex items-center gap-1 text-ink-2">
                dated <input type="date" name="effectiveOn" className="rounded-md border border-line bg-surface px-1.5 py-1" />
              </label>
              <label className="flex items-center gap-1 text-ink-2">
                expires <input type="date" name="expiresOn" className="rounded-md border border-line bg-surface px-1.5 py-1" />
              </label>
              <label className="flex items-center gap-1 text-ink-2">
                <input type="checkbox" name="noExpiry" value="on" /> no expiry
              </label>
              <button type="submit" className="rounded-md bg-accent px-3 py-1 font-medium text-white hover:bg-accent-strong">File it</button>
            </div>
            <p className="mt-2 text-[12px] text-ink-3">A card, a licence or a protocol filed here records the credential as well. Anything that arrives by mail is read on its own; a dropped file that needs reading (an invoice, a report) goes through <Link href="/intake" className="underline">Intake</Link>, which recognises it first.</p>
          </form>
        </section>
      ) : null}

      {tab === "search" ? (
        <section className="space-y-3">
          <form method="get" action="/v2/documents" className="flex items-center gap-2 text-[13px]">
            <input type="hidden" name="tab" value="search" />
            <input name="q" defaultValue={query} placeholder="a person, a form, a policy, a document, an invoice number, a page" className="w-96 rounded-md border border-line bg-surface px-2 py-1" />
            <button type="submit" className="rounded-md bg-accent px-3 py-1 font-medium text-white hover:bg-accent-strong">Find</button>
          </form>
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            {!query ? (
              <p className="py-3 text-[13px] text-ink-2">Searches the pages, the forms, people, the pharmacy&apos;s credentials, the manual&apos;s sections, the documents and the invoices.</p>
            ) : found.length === 0 ? (
              <p className="py-3 text-[13px] text-ink-2">Nothing found for &ldquo;{query}&rdquo;.</p>
            ) : (
              <table className="w-full">
                <tbody>
                  {found.map((r, i) => (
                    <tr key={`${r.href}|${i}`}>
                      <td className={`${td} text-[11px] uppercase text-ink-3`}>{r.kind}</td>
                      <td className={td}>
                        <Link href={r.href} className="hover:underline">{r.title}</Link>
                        <span className="block text-[12px] text-ink-2">{r.detail}</span>
                      </td>
                      <td className={`${td} text-[12px] text-ink-3`}>{r.where}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      ) : null}

      {tab === "forms" ? (
        <section className="space-y-3">
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Form</th>
                  <th className={th}>Purpose</th>
                  <th className={th}>When</th>
                  <th className={th}>Where it lives</th>
                  <th className={th}>Authority</th>
                </tr>
              </thead>
              <tbody>
                {v.forms.map((fm) => (
                  <tr key={fm.name}>
                    <td className={td}>
                      <Link href={fm.href} className="hover:underline">{fm.name}</Link>
                    </td>
                    <td className={`${td} text-[12px] text-ink-2`}>{fm.purpose}</td>
                    <td className={`${td} text-[12px] text-ink-2`}>{fm.cadence}</td>
                    <td className={`${td} text-[12px] text-ink-2`}>{fm.where}</td>
                    <td className={`${td} text-[11px] text-ink-3`}>{fm.authority}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[12.5px] text-ink-3">These and the manual&apos;s Appendix A.2 are one list read twice{v.appendixVersion ? `, version ${v.appendixVersion}` : ""}.</p>
        </section>
      ) : null}

      {tab === "retention" ? (
        <section className="space-y-3">
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Kind of record</th>
                  <th className={`${th} text-right`}>On file</th>
                  <th className={`${th} text-right`}>Keep</th>
                  <th className={`${th} text-right`}>May go</th>
                  <th className={`${th} text-right`}>Never</th>
                  <th className={th}>The rule</th>
                </tr>
              </thead>
              <tbody>
                {v.retention.kinds.map((k) => (
                  <tr key={k.kind}>
                    <td className={td}>{k.kind.replace(/_/g, " ")}</td>
                    <td className={`${td} text-right tabular-nums`}>{k.documents}</td>
                    <td className={`${td} text-right tabular-nums`}>{k.keep || ""}</td>
                    <td className={`${td} text-right tabular-nums`}>{k.mayDestroy || ""}</td>
                    <td className={`${td} text-right tabular-nums`}>{k.never || ""}</td>
                    <td className={`${td} text-[12px] text-ink-2`}>{k.rule ?? "awaiting your decision"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {v.retention.awaiting.length ? (
            <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Awaiting your word</h3>
              <ul className="mt-1 space-y-1">
                {v.retention.awaiting.map((a) => (
                  <li key={a.question} className="text-ink-2">
                    {a.question} <span className="text-ink-3">({a.documents} documents: {a.categories.map((c) => c.replace(/_/g, " ")).join(", ")})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {v.retention.mayDestroy.length ? (
            <div className="rounded-lg border border-line bg-surface px-4 py-2">
              <h3 className="py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">Past their period</h3>
              <table className="w-full">
                <tbody>
                  {v.retention.mayDestroy.slice(0, 100).map((d) => (
                    <tr key={d.id}>
                      <td className={td}>
                        <Link href={`/files/${d.id}`} className="hover:underline">{d.title ?? d.category ?? d.id}</Link>
                      </td>
                      <td className={`${td} tabular-nums text-ink-3`}>{d.from}</td>
                      <td className={`${td} text-[12px] text-ink-2`}>free to destroy since {d.since} · {d.rule}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="text-[12.5px] text-ink-3">The clock starts at the record&apos;s own date, else the day it was filed; where Kansas and a federal rule both apply the longer wins. Nothing here destroys anything: the clock says what may go and what must stay, and a kind of record it is not sure of is a question, not a period.</p>
        </section>
      ) : null}
    </div>
  );
}
