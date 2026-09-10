import { familyTabs } from "@/lib/families";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireManager } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { hasMailPassword } from "@/lib/mailbox";
import { allSuppliers, addressesOf, type Supplier } from "@/lib/suppliers-registry";
import { PageHeader, Notice, Empty } from "@/components/ui";
import { isUnknownSenderInvoice, printedNameInReason } from "@/lib/autoroute";
import { CATEGORIES } from "@/lib/intake-recognise";
import { senderRules, describeRule, recogniseStored } from "@/lib/intake-recognise-store";
import type { Recognition } from "@/lib/intake-recognise";
import { sourceOf, storyOf, summarise } from "@/lib/inbox-line";
import { leftBehind, willWriteShort, isRemovable } from "@/lib/inbox-undo";
import { reRouteInboxItem, undoInboxItem, fileInboxItem, deleteInboxItem, sweepNow, rereadItem, sortInboxItem, attributeInboxItem, teachInboxItem, forgetIntakeRule, resortAll } from "./actions";


/**
 * What a person may tell the Inbox a document is.
 *
 * Every kind the loader can actually do something with, in the owner's words rather than the
 * recogniser's. "unrecognised" is not offered: it is what the site says when it does not know,
 * and there is nothing for a person to gain by asserting it.
 */
const ROUTE_CHOICES: { kind: string; label: string }[] = [
  { kind: "rx_transactions", label: "Daily claims — Rx Transaction Details" },
  { kind: "claims", label: "Claims export" },
  { kind: "on_hand", label: "Balance on hand / inventory count" },
  { kind: "pioneer_catalog", label: "Wholesaler catalogue (PioneerRx export)" },
  { kind: "supplier_catalog", label: "Wholesaler catalogue (supplier's own file)" },
  { kind: "nadac", label: "NADAC pricing file" },
  { kind: "rebate_report", label: "McKesson rebate breakdown" },
  { kind: "purchase_drilldown", label: "McKesson Purchase Drill Down" },
  { kind: "return_policy", label: "Returned goods policy" },
  { kind: "remittance_835", label: "835 remittance from a plan" },
  { kind: "copay_remit", label: "Copay-card voucher remittance (RedSail)" },
  { kind: "rxrescue_credit", label: "RxRescue credit memo" },
  { kind: "payer_payments", label: "Payer payments report" },
  { kind: "accrual_sales", label: "System sales summary" },
];

/** The four tones `storyOf` returns, in the site's colours. */
const TONE: Record<"ok" | "warn" | "crit" | "muted", string> = {
  ok: "text-ink",
  warn: "text-warn",
  crit: "text-crit",
  muted: "text-ink-3",
};

export const metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string; detail?: string; ok?: string; guess?: string; showDone?: string }> }) {
  await requireManager();
  const { saved, error, detail, ok, guess, showDone: showDoneParam } = await searchParams;
  const [s, configured, items, people, suppliers, rules] = await Promise.all([
    getSettings(),
    hasMailPassword(),
    db.select().from(schema.inboxItems).orderBy(desc(schema.inboxItems.receivedAt)).limit(200),
    db.query.people.findMany({ where: eq(schema.people.active, true), orderBy: (p, { asc }) => [asc(p.lastName)] }),
    allSuppliers(true),
    senderRules(),
  ]);

  /*
   * What the site makes of one line, worked out only where somebody asked about that line.
   *
   * Answering it means opening the stored file and reading it. The version before this did that
   * for the twenty most recent unplaced lines on every single view — twenty file reads and forty
   * queries to draw one page, on the thread that serves every other page, and this project has
   * twice found the site pinned at full CPU by work of exactly that shape. It is now done for the
   * one line the question was pressed on, and for no other.
   */
  const guesses = new Map<string, Recognition>();
  if (guess) {
    const r = await recogniseStored(guess, rules);
    if (r) guesses.set(guess, r);
  }

  /*
   * Two piles, because only one of them is work.
   *
   * The owner: "the inbox is very unclear, too wordy, to hard to try to make sure i see
   * everything I need to." Fifty-three arrivals were rendering as fifty-three four-line blocks,
   * every one carrying its full set of fix-it controls whether or not anything was wrong with it.
   * The six that needed him were somewhere in the middle of that.
   *
   * What needs him is anything the site could not place, refused, or is holding for confirmation.
   * Everything else is done and folds away behind a count — kept, because "what happened to that
   * file" is a real question, but not competing with the work.
   */
  const needsAttention = (i: (typeof items)[number]) => {
    const o = storyOf(i).outcome;
    return o === "not_recognised" || o === "rejected" || o === "held";
  };
  const needsYou = items.filter(needsAttention);
  const done = items.filter((i) => !needsAttention(i));
  const showDone = showDoneParam === "yes";
  const shown = showDone ? items : needsYou;

  return (
    <>
      <PageHeader
        tabs={familyTabs("arrivals", "/inbox")}
        title="Inbox"
        subtitle={`${summarise(items)}${s.mail_last_sweep ? ` Last checked ${s.mail_last_sweep.replace("T", " ").slice(0, 16)} UTC.` : ""}`}
        actions={
          <>
            <Link href="/settings/email" className="btn">Email settings</Link>
            {configured && <form action={sweepNow.bind(null, "inbox")}><button className="btn btn-primary">Check for new mail now</button></form>}
            {configured && needsYou.length > 0 && (
              <form action={resortAll}>
                <button className="btn">Sort {needsYou.length} again</button>
              </form>
            )}
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
      ) : shown.length === 0 ? (
        <Empty>Nothing has arrived yet. {s.mail_last_sweep ? `Last checked ${s.mail_last_sweep.replace("T", " ").slice(0, 16)} UTC.` : "Use “Check for new mail now” to look."}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="table">
            <thead>
              <tr><th>Arrived</th><th>Where from</th><th>File</th><th>What happened to it</th><th>Put it right</th></tr>
            </thead>
            <tbody>
              {shown.map((i) => (
                <tr key={i.id} id={i.id}>
                  <td className="whitespace-nowrap text-xs">{i.receivedAt.replace("T", " ").slice(0, 16)}</td>
                  <td className="text-xs">
                    <div className="text-ink-2">{sourceOf(i).label}</div>
                    <div className="font-mono text-ink-3">{i.fromAddress}</div>
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
                    {(() => {
                      /*
                        One story, told once.

                        This cell used to say the same thing three times over — a badge, the
                        loader's own sentence, and the sweep's reason — and the badge could
                        contradict the sentence beside it. Everything here comes off the row the
                        sweep already wrote: nothing is opened, parsed or recomputed to draw it.
                      */
                      const st = storyOf(i);
                      const from = supplierByAddress(suppliers, i.fromAddress);
                      const advice = whatToDo({ ...i, senderIsSupplier: Boolean(from), supplierName: from?.name ?? null });
                      const g = guesses.get(i.id);
                      return (
                        <>
                          <div className={`font-medium ${TONE[st.tone]}`}>{st.headline}</div>
                          {st.changed && <div className="mt-0.5 max-w-md text-xs text-ink-2">{st.changed}</div>}
                          {st.why && <div className="mt-0.5 max-w-md text-xs text-ink-3">{st.why}</div>}

                          {/*
                            A supplier invoice nobody could place. Loud, because the cost of missing
                            it is a purchase record that is short and looks complete — and, for a
                            controlled substance, an invoice filed outside the records
                            21 CFR 1304.04(h)(1) requires.
                          */}
                          {isUnknownSenderInvoice(i.reason) && (
                            <div className="mt-1"><span className="badge badge-crit">an invoice, sender unknown</span></div>
                          )}
                          {/* The sweep's own reason, only where the story has not already said it. */}
                          {i.reason && i.reason !== st.why && (
                            <div className="mt-1 max-w-md text-xs text-ink-2">{i.reason}</div>
                          )}
                          {i.status === "stored" && !i.scanned && (
                            <div className="mt-0.5 text-xs text-ink-3">Stored without a column check (not a text report).</div>
                          )}

                          {st.outcome === "not_recognised" && i.documentId && !g && (
                            <div className="mt-1">
                              <Link href={`/inbox?guess=${i.id}#${i.id}`} className="text-xs text-accent hover:underline">What does the site make of it?</Link>
                            </div>
                          )}
                          {g && (
                            <div className="mt-1 max-w-md rounded-md border border-line bg-paper-2 px-2 py-1.5 text-xs">
                              <div className="font-medium text-ink">{g.says}</div>
                              {g.best && (
                                <ul className="mt-1 list-disc pl-4 text-ink-3">
                                  {g.best.why.map((w, n) => <li key={n}>{w}</li>)}
                                </ul>
                              )}
                              {g.ranked.length > 1 && (
                                <div className="mt-1 text-ink-3">
                                  Also considered: {g.ranked.slice(1, 4).map((o) => `${o.label.toLowerCase()} (${o.sure})`).join(", ")}.
                                </div>
                              )}
                              {/* The one thing this must never do is act on a guess it is not sure of. */}
                              {!g.mayFile && <div className="mt-1 text-ink-3">Nothing was filed on this. Tell it what the document is and it will load it.</div>}
                            </div>
                          )}

                          {advice && (
                            <div className="mt-1 max-w-md rounded-md border border-warn bg-warn-soft px-2 py-1 text-xs text-warn">{advice}</div>
                          )}
                        </>
                      );
                    })()}
                  </td>
                  {/*
                    One control, and it is the one that fixes the thing for good.

                    This cell was a hundred and eighty-three lines per row: six stacked buttons, a
                    disclosure, and a paragraph telling him to go to Suppliers, add the address,
                    come back and press read again. Nine items ran to ten pages, and the sentence
                    describing the long way round was printed beside the button that does it in one.

                    Naming the supplier records the address against them and reads the file again,
                    so the next one places itself. Everything else is rarer and sits behind a fold.
                  */}
                  <td className="align-top">
                    {storyOf(i).outcome === "loaded" || storyOf(i).outcome === "filed_only" ? (
                      <span className="text-xs text-ink-3">—</span>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {i.documentId && (
                          <form action={attributeInboxItem} className="flex flex-wrap items-center gap-1">
                            <input type="hidden" name="itemId" value={i.id} />
                            <select name="supplierId" className="field h-7 py-0 text-xs" defaultValue="" aria-label="Which supplier is this from?">
                              <option value="">Who is it from?</option>
                              {suppliers.map((x) => (
                                <option key={x.id} value={x.id}>{x.name}</option>
                              ))}
                            </select>
                            <button className="btn btn-sm btn-primary">File it</button>
                          </form>
                        )}
                        <details className="text-xs">
                          <summary className="cursor-pointer text-ink-3">Other</summary>
                          <div className="mt-1 flex flex-col gap-1">
                            {i.documentId && (
                              <form action={rereadItem.bind(null, i.id)}>
                                <button className="btn btn-sm w-full">Read again with today’s rules</button>
                              </form>
                            )}
                            {i.documentId && (
                              <form action={sortInboxItem.bind(null, i.id)}>
                                <button className="btn btn-sm w-full">Send to the intake</button>
                              </form>
                            )}
                            {/*
                              Filing a document to a person: a licence, a CPR card, an immunisation
                              certificate. Compacting this cell removed it altogether and a test
                              caught that — it is rarer than an invoice and it is not optional, so
                              it belongs in the fold rather than gone.
                            */}
                            {i.documentId && people.length > 0 && (
                              <form action={fileInboxItem} className="grid gap-1 rounded border border-line p-1">
                                <input type="hidden" name="itemId" value={i.id} />
                                <select name="personId" className="field h-7 py-0 text-xs" defaultValue="">
                                  <option value="">File to a person…</option>
                                  {people.map((pp) => (
                                    <option key={pp.id} value={pp.id}>{pp.firstName} {pp.lastName}</option>
                                  ))}
                                </select>
                                <select name="category" defaultValue="cpr_card" className="field h-7 py-0 text-xs">
                                  <option value="cpr_card">CPR card</option>
                                  <option value="license">Licence or registration</option>
                                  <option value="immunization_training">Immunization training</option>
                                  <option value="immunization_protocol">Immunization protocol</option>
                                  <option value="other">Something else</option>
                                </select>
                                <input name="number" placeholder="Number (optional)" className="field h-7 py-0 text-xs" />
                                <label className="text-xs text-ink-3">Expires<input name="expiresOn" type="date" className="field h-7 py-0 text-xs" /></label>
                                <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="noExpiry" /> Does not expire</label>
                                <button className="btn btn-sm">File to them</button>
                              </form>
                            )}
                            <form action={deleteInboxItem.bind(null, i.id)}>
                              <button className="btn btn-sm w-full border-crit text-crit hover:bg-crit-soft">Not for us — clear it</button>
                            </form>
                          </div>
                        </details>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {done.length > 0 && (
            <p className="border-t border-line px-3 py-2 text-xs text-ink-3">
              {showDone ? (
                <>
                  Showing all {items.length}.{" "}
                  <Link href="/inbox" className="underline">Just the {needsYou.length} that need you</Link>
                </>
              ) : (
                <>
                  {done.length} more arrived and were handled.{" "}
                  <Link href="/inbox?showDone=yes" className="underline">Show them</Link>
                </>
              )}
            </p>
          )}
        </div>
      )}

      {/*
        What has been taught, in one place.

        A rule that cannot be seen is a rule that cannot be doubted, and the first time one of these
        files something wrong the only useful question is "what did I tell it?". So they are listed
        in the same words they were made in, with the owner's own note, and each can be removed.
      */}
      {rules.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-ink">What you have told it</h2>
          <p className="mt-0.5 text-xs text-ink-3">
            Each of these was made by correcting a line above. They are tried before the file&rsquo;s own columns
            only where they name a subject or a file name — a rule about a whole sender never overrules what a
            file plainly is.
          </p>
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line bg-surface">
            {rules.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 px-3 py-2 text-xs">
                <div>
                  <div className="text-ink">{describeRule(r)}</div>
                  {r.note && <div className="text-ink-3">&ldquo;{r.note}&rdquo;</div>}
                  <div className="text-ink-3">
                    {r.taughtAt.replace("T", " ").slice(0, 16)}
                    {r.wasGuessedAs ? ` — it had guessed ${r.wasGuessedAs.replace(/_/g, " ")}` : ""}
                  </div>
                </div>
                <form action={forgetIntakeRule.bind(null, r.id)}>
                  <button className="text-ink-3 hover:text-ink hover:underline" type="submit">Forget this</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
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

