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
import { reRouteInboxItem, undoInboxItem, fileInboxItem, deleteInboxItem, sweepNow, rereadItem, sortInboxItem, attributeInboxItem, teachInboxItem, forgetIntakeRule } from "./actions";


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

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string; detail?: string; ok?: string; guess?: string }> }) {
  await requireManager();
  const { saved, error, detail, ok, guess } = await searchParams;
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
              <tr><th>Arrived</th><th>Where from</th><th>File</th><th>What happened to it</th><th>Put it right</th></tr>
            </thead>
            <tbody>
              {items.map((i) => (
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
                  <td>
                    {/*
                      Overruling the recogniser, which is the fix the owner asked for first.
                      Asked which of the things that can go wrong worries him most, he chose a
                      document filed as the wrong kind — and until now that was a dead end: the
                      line explained what it had decided and there was nothing to press.

                      Every kind the loader can actually handle is offered, the one it chose
                      included, so "it is right, load it again" is as available as "it is wrong".
                    */}
                    {i.documentId && (
                      <details className="mb-2">
                        <summary className="cursor-pointer text-xs text-accent hover:underline">
                          {i.routedAs && i.routedAs !== "unrecognised" ? "Wrong? Re-route it" : "Tell it what this is"}
                        </summary>
                        <form action={reRouteInboxItem} className="mt-2 grid gap-2">
                          <input type="hidden" name="itemId" value={i.id} />
                          <select name="kind" defaultValue="" className="field text-xs">
                            <option value="">What is this document?</option>
                            {ROUTE_CHOICES.map((c) => (
                              <option key={c.kind} value={c.kind}>{c.label} — {willWriteShort(c.kind) ?? "…"}</option>
                            ))}
                          </select>
                          <button className="btn btn-primary text-xs" type="submit">Load it as this</button>
                          {/*
                            What the reading being overruled actually left behind, for this kind
                            rather than for all of them. The sentence here used to be one vague line
                            shown for all fourteen — which reads as reassurance on a remittance that
                            banked money and as alarm on a catalogue that gets repriced by morning.
                          */}
                          <p className="text-[11px] leading-snug text-ink-3">
                            Runs the same loader the sweep runs, told the answer. {leftBehind(i.routedAs)}
                          </p>
                        </form>
                      </details>
                    )}
                    {/*
                      Taking a remittance back out. Offered on the two kinds where a wrong reading
                      moved money and the rows can be identified — every payment and deposit those
                      two readers write carries the id of the document it came from — and on no
                      others, because an undo that deletes on a guess is worse than none.
                    */}
                    {isRemovable(i.routedAs) && i.documentId && (
                      <details className="mb-2">
                        <summary className="cursor-pointer text-xs text-crit hover:underline">Take the money back out</summary>
                        <form action={undoInboxItem} className="mt-2 grid gap-2">
                          <input type="hidden" name="itemId" value={i.id} />
                          <p className="text-[11px] leading-snug text-ink-3">
                            Deletes every payment and bank deposit recorded from this document, and nothing else.
                            Use it where this was not a remittance at all, or was somebody else&rsquo;s. Payments loaded
                            before the site began recording which document they came from cannot be reached, and it
                            will say so rather than delete the wrong ones.
                          </p>
                          <button className="btn text-xs" type="submit">Remove what this loaded</button>
                        </form>
                      </details>
                    )}
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
                      <form action={sortInboxItem.bind(null, i.id)} className="mb-2">
                        <button className="btn btn-sm btn-primary">Sort it: read and file where the money goes</button>
                      </form>
                    )}
                    {/*
                      Whose file this is, answered where the problem is.

                      A file from an address the register does not know is refused rather than
                      guessed at — loading ParMed's prices under McKesson would send orders to the
                      wrong place. But the only way out used to be leaving here, finding Suppliers,
                      adding the supplier, remembering to type the address it sends from, coming
                      back, and pressing read again. Now: name them once, the address is recorded
                      against them, and the file is read on the spot.
                    */}
                    {i.documentId && i.fromAddress && !supplierByAddress(suppliers, i.fromAddress) && (
                      <form action={attributeInboxItem} className="mb-2 rounded border border-line bg-paper-2 p-2">
                        <input type="hidden" name="itemId" value={i.id} />
                        <p className="mb-1.5 text-xs text-ink-2">
                          {isUnknownSenderInvoice(i.reason)
                            ? <>This reads as a supplier invoice, but nothing on the register sends from <span className="font-mono">{i.fromAddress}</span>. Whose is it? Naming them files it with their invoices.</>
                            : <>Nothing on the register sends from <span className="font-mono">{i.fromAddress}</span>, so this could not be placed. Who is it?</>}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <select name="supplierId" className="py-1 text-sm" defaultValue="">
                            <option value="">A supplier already on the register…</option>
                            {suppliers.map((sup) => <option key={sup.id} value={sup.id}>{sup.name}</option>)}
                          </select>
                          <span className="text-xs text-ink-3">or</span>
                          <input name="newSupplier" placeholder={printedNameInReason(i.reason) ?? "a new one, by name"} defaultValue="" className="py-1 text-sm" />
                          <button className="btn btn-sm btn-primary">Remember and read it</button>
                        </div>
                        <p className="mt-1 text-[11px] text-ink-3">
                          Everything from that address will place itself from now on. Ask again only if they change it.
                        </p>
                      </form>
                    )}
                    {/*
                      Saying what it actually is.
                      
                      On every line with a file behind it, not only the ones that failed: a document
                      that loaded as the wrong thing is exactly the case worth correcting, and it is
                      the case where nothing on the screen suggests anything is wrong. What is kept
                      is a rule about the sender, so this is asked once and not every Sunday.
                    */}
                    {i.documentId && i.fromAddress && (
                      <details className="mb-2">
                        <summary className="cursor-pointer text-xs text-accent hover:underline">
                          {guesses.get(i.id)?.needsOwner ? "Tell it what this is" : "That is not what this is"}
                        </summary>
                        <form action={teachInboxItem} className="mt-2 grid gap-2 rounded border border-line bg-paper-2 p-2">
                          <input type="hidden" name="itemId" value={i.id} />
                          <select name="category" className="field text-xs" defaultValue="">
                            <option value="">What is it?</option>
                            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                          </select>
                          <input name="note" placeholder="Why, in your words (optional)" className="field text-xs" />
                          <button className="btn btn-sm btn-primary" type="submit">Remember and read it</button>
                          <p className="text-[11px] text-ink-3">
                            Kept as a rule about <span className="font-mono">{i.fromAddress}</span>, so the next one places itself.
                            Where the file&rsquo;s own columns say something different, the rule is narrowed to files named like this one.
                          </p>
                        </form>
                      </details>
                    )}
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

