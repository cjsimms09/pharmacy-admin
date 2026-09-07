import { familyTabs } from "@/lib/families";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { hasMailPassword } from "@/lib/mailbox";
import { allSuppliers, addressesOf, type Supplier } from "@/lib/suppliers-registry";
import { PageHeader, Notice, Empty } from "@/components/ui";
import { fileInboxItem, deleteInboxItem, sweepNow, rereadItem } from "./actions";

export const metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string; detail?: string; ok?: string }> }) {
  await requireManager();
  const { saved, error, detail, ok } = await searchParams;
  const [s, configured, items, people, suppliers] = await Promise.all([
    getSettings(),
    hasMailPassword(),
    db.select().from(schema.inboxItems).orderBy(desc(schema.inboxItems.receivedAt)).limit(200),
    db.query.people.findMany({ where: eq(schema.people.active, true), orderBy: (p, { asc }) => [asc(p.lastName)] }),
    allSuppliers(true),
  ]);

  return (
    <>
      <PageHeader
        tabs={familyTabs("arrivals", "/inbox")}
        title="Inbox"
        subtitle="Reports that arrived by email, and anything that was refused."
        actions={
          <>
            <Link href="/settings/email" className="btn">Email settings</Link>
            {configured && <form action={sweepNow.bind(null, "inbox")}><button className="btn btn-primary">Check for new mail now</button></form>}
          </>
        }
      />
      {saved && <Notice>{detail || "Done."}</Notice>}
      {ok && <Notice>{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {!configured ? (
        <Empty>
          No mailbox connected yet. <Link href="/settings/email" className="text-accent underline">Set one up</Link> so scheduled reports land here on their own.
        </Empty>
      ) : items.length === 0 ? (
        <Empty>Nothing has arrived yet. {s.mail_last_sweep ? `Last checked ${s.mail_last_sweep.replace("T", " ").slice(0, 16)} UTC.` : "Use “Check for new mail now” to look."}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="table">
            <thead>
              <tr><th>Received</th><th>From</th><th>Attachment</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td className="whitespace-nowrap text-xs">{i.receivedAt.replace("T", " ").slice(0, 16)}</td>
                  <td className="text-xs">
                    <div className="font-mono">{i.fromAddress}</div>
                    {i.subject && <div className="text-ink-3">{i.subject}</div>}
                  </td>
                  <td className="text-xs">
                    {i.documentId ? (
                      <a href={`/files/${i.documentId}`} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">{i.fileName}</a>
                    ) : (
                      <span className="text-ink-3">{i.fileName ?? "—"}</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${i.status === "stored" ? "badge-ok" : i.status === "rejected" ? "badge-crit" : "badge-muted"}`}>{i.status}</span>
                    {i.reason && <div className="mt-1 max-w-md text-xs text-ink-2">{i.reason}</div>}
                    {i.status === "stored" && !i.scanned && <div className="text-xs text-ink-3">Stored without a column check (not a text report).</div>}
                    {i.routedAs && i.routedAs !== "unrecognised" && (
                      <div className="mt-1 text-xs">
                        {/* Recognised is not loaded. A catalogue refused for naming the wrong supplier was
                            recognised perfectly well, and a green badge on it would say the opposite. */}
                        {/could not be loaded|nothing could be loaded/i.test(i.routeResult ?? "") ? (
                          <span className="badge badge-crit">recognised as {i.routedAs.replace(/_/g, " ")}, not loaded</span>
                        ) : (
                          <span className="badge badge-ok">loaded as {i.routedAs.replace(/_/g, " ")}</span>
                        )}
                        {i.routeResult && <div className="mt-0.5 max-w-md text-ink-2">{i.routeResult}</div>}
                      </div>
                    )}
                    {i.routedAs === "unrecognised" && (
                      <div className="mt-1 max-w-md text-xs text-ink-3">Filed only — {i.routeResult}</div>
                    )}
                    {!i.routedAs && i.routeResult && <div className="mt-1 max-w-md text-xs text-ink-3">{i.routeResult}</div>}
                    {(() => {
                      const from = supplierByAddress(suppliers, i.fromAddress);
                      const advice = whatToDo({ ...i, senderIsSupplier: Boolean(from), supplierName: from?.name ?? null });
                      return advice ? (
                        <div className="mt-1 max-w-md rounded-md border border-warn bg-warn-soft px-2 py-1 text-xs text-warn">{advice}</div>
                      ) : null;
                    })()}
                  </td>
                  <td>
                    {/* An emailed CPR card is useless sitting here. This is where it becomes a
                        record: whose it is, what it is, and when it expires are all known to the
                        person reading the email and to nobody else. */}
                    {i.documentId && people.length > 0 && (
                      <details className="mb-2">
                        <summary className="cursor-pointer text-xs text-accent hover:underline">File to a person</summary>
                        <form action={fileInboxItem} className="mt-2 grid gap-2">
                          <input type="hidden" name="itemId" value={i.id} />
                          <select name="personId" className="field text-xs">
                            <option value="">Whose is it?</option>
                            {people.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
                          </select>
                          <select name="category" defaultValue="cpr_card" className="field text-xs">
                            <option value="cpr_card">CPR card</option>
                            <option value="license">Licence or registration</option>
                            <option value="immunization_training">Immunization training</option>
                            <option value="immunization_protocol">Immunization protocol</option>
                            <option value="other">Something else</option>
                          </select>
                          <input name="number" placeholder="Number (optional)" className="field text-xs" />
                          <label className="text-xs text-ink-3">Issued<input name="issuedOn" type="date" className="field text-xs" /></label>
                          <label className="text-xs text-ink-3">Expires<input name="expiresOn" type="date" className="field text-xs" /></label>
                          <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="noExpiry" /> Does not expire</label>
                          <button className="btn btn-primary text-xs" type="submit">File it</button>
                        </form>
                      </details>
                    )}
                    {/*
                      "Delete" used to mean "destroy the document this was filed as, and its file".
                      It now means what somebody clearing an inbox thinks it means, and the label
                      says which — because the difference is a supplier invoice the pharmacy has to
                      keep for five years.
                    */}
                    {/*
                      The second reading. A report or invoice that was not recognised on arrival —
                      because the supplier's address was not on the register yet, or automatic
                      loading was off — is read again here with today's rules, by the same path the
                      sweep takes. The sweep itself never touches a message twice, so this is the
                      only way a stored file gets a second chance.
                    */}
                    {i.documentId && i.routedAs !== "invoice" && (
                      <form action={rereadItem.bind(null, i.id)} className="mb-2">
                        <button className="text-xs text-accent hover:underline" type="submit" title="Read this file again with the rules as they are now — after adding a supplier's address, or turning automatic loading on.">
                          Read again with today&rsquo;s rules
                        </button>
                      </form>
                    )}
                    <form action={deleteInboxItem.bind(null, i.id)}>
                      <button
                        className="text-xs text-ink-3 hover:text-ink hover:underline"
                        type="submit"
                        title={
                          i.documentId
                            ? "Takes this line off the list. The stored document is kept and stays filed wherever it was filed."
                            : "Takes this line off the list. Nothing was stored for it."
                        }
                      >
                        Clear from list
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * The fix, in a sentence, for a line that did not end in a loaded report.
 *
 * The line above it says what happened; this says what to change so it does not happen next
 * Sunday. Derived from the recorded reason rather than stored, so a wording change here reaches
 * old lines too.
 */
function whatToDo(i: {
  status: string;
  reason: string | null;
  routedAs: string | null;
  routeResult: string | null;
  fileName: string | null;
  subject: string | null;
  /** Whether the address it came from is already against a supplier on the register. */
  senderIsSupplier: boolean;
  supplierName: string | null;
}): string | null {
  const text = `${i.reason ?? ""} ${i.routeResult ?? ""}`;
  if (/not on the allowed list/i.test(text)) return "Add this sender's address under Settings → Email → accepted senders, then press “Check for new mail now”.";
  if (/type this reads|no file extension/i.test(text)) return "Have the report emailed as a plain text or CSV attachment (not zipped, not in the body of the email).";
  if (/larger than 20 MB/i.test(text)) return "Schedule the report per supplier rather than all suppliers in one file, so each stays under the size limit.";
  if (/automatic loading is switched off/i.test(text)) return "Turn on “Load recognised reports automatically” under Settings → Email, then press “Read again with today's rules” on this line.";
  /*
   * A PDF from somewhere the site does not know what to do with.
   *
   * The advice used to be "add the sender's address under Suppliers" whatever the case, which was
   * wrong and infuriating for the commonest case of all: the address *is* already there, and the
   * document simply is not an invoice. A monthly statement is the example — it summarises invoices
   * rather than being one, and filing it under the controlled-substance invoice rules would be
   * wrong anyway. So the advice now depends on whether the sender is known.
   */
  if (i.routedAs === "unrecognised" && /\.pdf$/i.test(i.fileName ?? "")) {
    if (!i.senderIsSupplier) {
      return "If this is a supplier invoice, add the sender's address to that supplier under Suppliers, then press “Read again with today's rules” on this line.";
    }
    if (/statement/i.test(`${i.subject ?? ""} ${i.fileName ?? ""}`)) {
      return `Filed as a document from ${i.supplierName ?? "that supplier"}. A statement summarises invoices rather than being one, so it is not filed with them — the invoices it covers are already here on their own.`;
    }
    return `${i.supplierName ?? "That supplier"} is on the register, so this was filed as a document from them. It is not an invoice, a catalogue, a claims report or a rebate breakdown — nothing more is needed unless you expected it to load.`;
  }
  if (/named for .* but names/i.test(text)) return "The schedule that produces this file exports a different supplier's catalogue than its name says. Fix either the name or the supplier in the PioneerRx schedule.";
  if (/columns have changed/i.test(text)) return "The Daily report's columns were changed in PioneerRx. Put them back to the list shown on Reports, or send the file to be looked at; nothing from it was loaded.";
  if (/split across lines but .* price lines/i.test(text)) return "The report's layout changed. Send the file to be looked at; nothing from that supplier was replaced.";
  if (/nothing could be loaded/i.test(text)) return "The file was recognised as a catalogue but held no readable prices. Open it and check that it is the full Supplier Catalog Item Search Results export.";
  if (i.routedAs === "unrecognised" && /catalog/i.test(text)) return "The file was not recognised as the PioneerRx catalogue export. It must begin with its own title line, “Supplier Catalog Item Search Results”.";
  return null;
}

/** The supplier a message came from, where its address is on the register. */
function supplierByAddress(suppliers: Supplier[], from: string): Supplier | null {
  const f = (from ?? "").toLowerCase();
  if (!f) return null;
  let best: { s: Supplier; len: number } | null = null;
  for (const s of suppliers) {
    for (const a of addressesOf(s)) {
      // Longest match wins, so a full address beats a domain several suppliers share.
      if (f.includes(a) && (!best || a.length > best.len)) best = { s, len: a.length };
    }
  }
  return best?.s ?? null;
}

