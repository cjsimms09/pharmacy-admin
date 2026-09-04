import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { hasMailPassword } from "@/lib/mailbox";
import { PageHeader, Notice, Empty } from "@/components/ui";
import { fileInboxItem, deleteInboxItem, sweepNow } from "./actions";

export const metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string; detail?: string }> }) {
  await requireManager();
  const { saved, error, detail } = await searchParams;
  const [s, configured, items, people] = await Promise.all([
    getSettings(),
    hasMailPassword(),
    db.select().from(schema.inboxItems).orderBy(desc(schema.inboxItems.receivedAt)).limit(200),
    db.query.people.findMany({ where: eq(schema.people.active, true), orderBy: (p, { asc }) => [asc(p.lastName)] }),
  ]);

  return (
    <>
      <PageHeader
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
                        <span className="badge badge-ok">loaded as {i.routedAs.replace(/_/g, " ")}</span>
                        {i.routeResult && <div className="mt-0.5 max-w-md text-ink-2">{i.routeResult}</div>}
                      </div>
                    )}
                    {i.routedAs === "unrecognised" && (
                      <div className="mt-1 max-w-md text-xs text-ink-3">Filed only — {i.routeResult}</div>
                    )}
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
                    <form action={deleteInboxItem.bind(null, i.id)}>
                      <button className="text-xs text-crit hover:underline" type="submit">Delete</button>
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
