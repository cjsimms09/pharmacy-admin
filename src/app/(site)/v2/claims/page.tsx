import Link from "next/link";
import { claimsView, type Leg } from "@/lib/engine/read";
import { todayIso } from "@/lib/dates";
import { decideClaim, undoDecision, tiePayment, aliasPayer } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Claims: where every claim leg in the books stands, as the engine last computed it (engine/claims.ts).
 *
 * Six numbers; a line per payer with the money aged and the plan groups' cycles; the scripts not paid, oldest
 * first, each with the decision a person can take; the ones paid short with the payer's own reasons; the payments
 * that found no claim; and what has been decided. Lookups only: the computing happened when the data arrived.
 */

const money = (c: number | null | undefined, signed = false) => (c === null || c === undefined ? "—" : `${signed && c < 0 ? "−" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const n = (x: number) => x.toLocaleString("en-US");

const TABS = [
  ["ar", "By payer"],
  ["unpaid", "Unpaid scripts"],
  ["short", "Short-paid"],
  ["unmatched", "Unmatched payments"],
  ["decided", "Decided"],
] as const;
type Tab = (typeof TABS)[number][0];

const STATE: Record<string, [string, string]> = {
  due: ["bg-warn-soft text-warn", "due"],
  unpaid: ["bg-ground text-ink-2", "inside cycle"],
  unmeasured: ["bg-ground text-ink-3", "never measured"],
  programme: ["bg-accent-soft text-accent-strong", "programme"],
  short: ["bg-crit-soft text-crit", "short"],
  over: ["bg-accent-soft text-accent-strong", "over"],
  paid: ["bg-accent-soft text-accent-strong", "paid"],
  none: ["bg-ground text-ink-3", "nothing to the plan"],
  cash: ["bg-ground text-ink-3", "cash"],
  fee: ["bg-ground text-ink-3", "fee"],
  reversed: ["bg-ground text-ink-3", "reversed"],
  reversed_paid: ["bg-crit-soft text-crit", "reversed, paid"],
};
const DECISION_WORD: Record<string, string> = { chase: "chase", wait: "wait", paid_elsewhere: "paid elsewhere", write_off: "written off", rebill: "re-bill", settled: "settled", not_ours: "not ours" };

const th = "py-2 text-left text-[11px] font-medium uppercase tracking-wide text-ink-3";
const thr = `${th} text-right`;
const td = "border-t border-line py-1.5 text-[13px] text-ink align-top";
const tdr = `${td} text-right tabular-nums`;

function Chip({ state }: { state: string }) {
  const [cls, word] = STATE[state] ?? ["bg-ground text-ink-3", state];
  return <span className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{word}</span>;
}

function Figure({ label, value, sub, href }: { label: string; value: string; sub?: string; href?: string }) {
  const body = (
    <>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{value}</div>
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

function Decide({ leg, tab, payer }: { leg: Leg; tab: string; payer: string | null }) {
  return (
    <form action={decideClaim} className="flex flex-wrap items-center gap-1.5 text-[12px]">
      <input type="hidden" name="tab" value={tab} />
      <input type="hidden" name="payer" value={payer ?? ""} />
      <input type="hidden" name="legKey" value={leg.legKey} />
      <input type="hidden" name="rxNumber" value={leg.rxNumber} />
      <input type="hidden" name="fillNumber" value={leg.fillNumber ?? ""} />
      <input type="hidden" name="dateFilled" value={leg.dateFilled} />
      <input type="hidden" name="bin" value={leg.bin ?? ""} />
      <select name="decision" className="rounded-md border border-line bg-surface px-1.5 py-1" defaultValue={leg.state === "short" ? "rebill" : "chase"}>
        <option value="chase">Chase the payer</option>
        <option value="wait">They pay later; ask again on…</option>
        <option value="rebill">Re-bill it</option>
        <option value="paid_elsewhere">Paid elsewhere</option>
        <option value="settled">Settled</option>
        <option value="write_off">Write it off</option>
        <option value="not_ours">Not ours</option>
      </select>
      <input type="date" name="revisitOn" className="rounded-md border border-line bg-surface px-1.5 py-1" />
      <input name="note" placeholder="why, in a few words" className="w-40 rounded-md border border-line bg-surface px-1.5 py-1" />
      <button type="submit" className="rounded-md bg-accent px-2 py-1 font-medium text-white hover:bg-accent-strong">
        Decide
      </button>
    </form>
  );
}

function LegCells({ l }: { l: Leg }) {
  return (
    <>
      <td className={`${td} tabular-nums text-ink-3`}>{l.dateFilled}</td>
      <td className={`${td} tabular-nums`}>{l.rxNumber}{l.fillNumber !== null ? `-${l.fillNumber}` : ""}</td>
      <td className={td}>{(l.itemName ?? "").slice(0, 34)}</td>
      <td className={td}>
        {l.payer}
        <span className="block text-[11px] text-ink-3">{[l.pcn, l.bin].filter(Boolean).join(" / ")}</span>
      </td>
    </>
  );
}

export default async function ClaimsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const today = todayIso();
  const tab = (TABS.some(([k]) => k === sp.tab) ? sp.tab : "ar") as Tab;
  const payer = typeof sp.payer === "string" && sp.payer.trim() ? sp.payer.trim() : null;
  const state = typeof sp.state === "string" ? sp.state : null;
  const error = typeof sp.error === "string" ? sp.error : null;
  const v = await claimsView(today, { payer });
  const f = v.figures;
  const q = (t: Tab, extra = "") => `/v2/claims?tab=${t}${payer ? `&payer=${encodeURIComponent(payer)}` : ""}${extra}`;
  const unpaid = state ? v.unpaid.filter((l) => l.state === state) : v.unpaid;
  const SHOW = 300;

  /* Open money by plan group, for the payer in view. */
  const groups = new Map<string, { legs: number; cents: number; due: number; cycle: number | null }>();
  if (payer) {
    for (const l of [...v.unpaid, ...v.short]) {
      const k = `${l.pcn ?? "—"} / ${l.bin ?? "—"}`;
      const g = groups.get(k) ?? { legs: 0, cents: 0, due: 0, cycle: l.cycleDays };
      g.legs++;
      g.cents += l.shortCents;
      if (l.state === "due") g.due += l.shortCents;
      groups.set(k, g);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[18px] font-semibold text-ink">Claims{payer ? ` · ${payer}` : ""}</h1>
        {payer ? (
          <Link href={`/v2/claims?tab=${tab}`} className="text-[13px] text-ink-2 hover:text-ink">
            all payers
          </Link>
        ) : null}
        <span className="ml-auto text-[12px] text-ink-3">{v.computedAt ? `as the engine left it, ${v.computedAt.slice(0, 16).replace("T", " ")} UTC` : "not computed yet"}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Figure label="Owed" value={money(f.owedCents)} sub={`${n(f.owedLegs)} scripts not paid`} href={q("unpaid")} />
        <Figure label="Due now" value={money(f.dueCents)} sub={`${n(f.dueLegs)} past their plan's cycle`} href={q("unpaid", "&state=due")} />
        <Figure label="Paid this month" value={money(f.paidThisMonthCents)} sub="received on claims in the books" />
        <Figure label="Short-paid" value={money(f.shortCents)} sub={`${n(f.shortLegs)} scripts`} href={q("short")} />
        <Figure label="Unmatched" value={money(f.unmatchedCents)} sub={`${n(f.unmatchedLegs)} payments, no claim`} href={q("unmatched")} />
        <Figure label="Reversed after paid" value={money(f.reversedPaidCents)} sub={`${n(f.reversedPaidLegs)} to give back`} />
      </div>

      <nav className="flex items-center gap-1 border-b border-line text-[14px]">
        {TABS.map(([key, label]) => (
          <Link key={key} href={q(key)} className={`-mb-px border-b-2 px-3 py-2 ${tab === key ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}>
            {label}
          </Link>
        ))}
        <span className="ml-auto flex items-center gap-2 text-[13px] text-ink-3">
          <Link href="/claims/appeals" className="hover:text-ink">Appeals</Link>·<Link href="/claims/floor" className="hover:text-ink">Floor</Link>·<Link href="/plans" className="hover:text-ink">Plans</Link>
        </span>
      </nav>

      {error ? <p className="rounded-md bg-crit-soft px-3 py-2 text-[13px] text-crit">{error}</p> : null}

      {tab === "ar" ? (
        <section className="space-y-3">
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            {v.byPayer.length === 0 ? (
              <p className="py-4 text-[14px] text-ink-2">No claim legs in the books yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className={th}>Payer</th>
                      <th className={thr}>Not paid</th>
                      <th className={thr}>Owed</th>
                      <th className={thr}>0–7 d</th>
                      <th className={thr}>8–14</th>
                      <th className={thr}>15–30</th>
                      <th className={thr}>31–60</th>
                      <th className={thr}>60+</th>
                      <th className={thr}>Due</th>
                      <th className={th}>Cycle</th>
                      <th className={th}>Paid through</th>
                      <th className={thr}>Paid</th>
                      <th className={thr}>Short</th>
                      <th className={th}>Last paid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.byPayer.map((p) => (
                      <tr key={p.payer}>
                        <td className={td}>
                          <Link href={`/v2/claims?tab=ar&payer=${encodeURIComponent(p.payer)}`} className="hover:underline">
                            {p.payer}
                          </Link>
                          {p.programme ? <span className="ml-1 rounded bg-accent-soft px-1 py-0.5 text-[10px] text-accent-strong">programme</span> : null}
                        </td>
                        <td className={tdr}>{p.openLegs || ""}</td>
                        <td className={tdr}>{p.owedCents ? money(p.owedCents) : ""}</td>
                        {p.bands.map((b, i) => (
                          <td key={i} className={`${tdr} text-ink-2`}>{b ? money(b) : ""}</td>
                        ))}
                        <td className={`${tdr} ${p.dueCents ? "font-medium text-warn" : ""}`}>{p.dueCents ? money(p.dueCents) : ""}</td>
                        <td className={`${td} text-ink-2`}>{p.cycle}</td>
                        <td className={`${td} text-[12px] text-ink-2`}>{p.routes ?? "nothing yet"}</td>
                        <td className={tdr}>{p.paidLegs ? `${money(p.paidCents)} (${p.paidLegs})` : ""}</td>
                        <td className={`${tdr} ${p.shortCents ? "text-crit" : ""}`}>{p.shortCents ? `${money(p.shortCents)} (${p.shortLegs})` : ""}</td>
                        <td className={`${td} tabular-nums text-ink-3`}>{p.lastPaidOn ?? "never"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {payer && groups.size ? (
            <div className="rounded-lg border border-line bg-surface px-4 py-2">
              <h3 className="py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">Open money by plan group (PCN / BIN)</h3>
              <table className="w-full">
                <tbody>
                  {[...groups].sort((a, b) => b[1].cents - a[1].cents).map(([k, g]) => (
                    <tr key={k}>
                      <td className={`${td} tabular-nums`}>{k}</td>
                      <td className={tdr}>{g.legs}</td>
                      <td className={tdr}>{money(g.cents)}</td>
                      <td className={`${tdr} ${g.due ? "text-warn" : ""}`}>{g.due ? `${money(g.due)} due` : ""}</td>
                      <td className={`${td} text-ink-2`}>{g.cycle !== null ? `${g.cycle}-day cycle` : "not measured"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {payer ? (
            <form action={aliasPayer} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
              <input type="hidden" name="tab" value="ar" />
              <input type="hidden" name="aliasOf" value={payer} />
              <span className="text-ink-2">Show this payer as</span>
              <input name="canonical" placeholder="the name to group it under" className="w-64 rounded-md border border-line bg-surface px-2 py-1" />
              <button type="submit" className="rounded-md bg-accent px-3 py-1 font-medium text-white hover:bg-accent-strong">
                Save
              </button>
              <span className="text-[12px] text-ink-3">A spelling that belongs to another payer: merged everywhere from the next engine pass.</span>
            </form>
          ) : null}
          <p className="text-[12.5px] text-ink-3">Owed is what the plans adjudicated on fills since 1 September and have not paid, aged from the fill. Due is the part older than its plan group&apos;s own slowest-in-ten payment, measured on this pharmacy&apos;s tied payments; a payer with fewer than 25 tied payments is never called late. A programme pays on its own terms and is never a plan&apos;s late money.</p>
        </section>
      ) : null}

      {tab === "unpaid" ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
            <span>
              {n(unpaid.length)} scripts, {money(unpaid.reduce((s, l) => s + l.shortCents, 0))}
              {unpaid.length > SHOW ? `; the oldest ${SHOW} shown` : ""}
            </span>
            {["due", "unpaid", "unmeasured", "programme"].map((s) => (
              <Link key={s} href={q("unpaid", s === state ? "" : `&state=${s}`)} className={`rounded px-1.5 py-0.5 text-[11px] ${s === state ? "bg-ink text-surface" : "bg-ground text-ink-2 hover:text-ink"}`}>
                {STATE[s][1]}
              </Link>
            ))}
          </div>
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            {unpaid.length === 0 ? (
              <p className="py-4 text-[14px] text-ink-2">Nothing. Every script in view is paid.</p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Filled</th>
                    <th className={th}>Rx</th>
                    <th className={th}>Drug</th>
                    <th className={th}>Payer</th>
                    <th className={thr}>Expected</th>
                    <th className={thr}>Age</th>
                    <th className={th}>Due</th>
                    <th className={th}>State</th>
                    <th className={th}>Decide</th>
                  </tr>
                </thead>
                <tbody>
                  {unpaid.slice(0, SHOW).map((l) => (
                    <tr key={l.claimId}>
                      <LegCells l={l} />
                      <td className={tdr}>{money(l.expectedCents)}</td>
                      <td className={tdr}>{l.ageDays} d</td>
                      <td className={`${td} tabular-nums text-ink-2`}>{l.dueOn ?? (l.programme ? "on its terms" : "unknown")}</td>
                      <td className={td}>
                        <Chip state={l.state} />
                        {l.decision ? <span className="block text-[11px] text-ink-3">{DECISION_WORD[l.decision] ?? l.decision}{l.decisionNote ? ` · ${l.decisionNote}` : ""}</span> : null}
                        {!l.soldOn ? <span className="block text-[11px] text-ink-3">not picked up</span> : null}
                      </td>
                      <td className={td}>
                        <Decide leg={l} tab={tab} payer={payer} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      ) : null}

      {tab === "short" ? (
        <section className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-line bg-surface px-4 py-2">
              <h3 className="py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">By the payer&apos;s reason</h3>
              {v.shortByReason.length === 0 ? (
                <p className="py-3 text-[13px] text-ink-2">No short payments.</p>
              ) : (
                <table className="w-full">
                  <tbody>
                    {v.shortByReason.map((r) => (
                      <tr key={r.reason}>
                        <td className={td}>{r.reason}</td>
                        <td className={`${td} text-[12px] text-ink-3`}>{r.legs}</td>
                        <td className={tdr}>{money(r.cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[12.5px] text-ink-2">
              The reason is the payer&apos;s own CAS code from its 835: CO is a contractual adjustment, PI payer-initiated, OA other; PR is the patient&apos;s share and is not a shortfall. A short payment with no reasons on file came from a document that carries none, or from an 835 read before the reasons were kept (1 October 2026). Appeals for MAC shortfalls over the floor are prepared on <Link href="/claims/appeals" className="underline">Appeals</Link>.
            </div>
          </div>
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            {v.short.length === 0 ? (
              <p className="py-4 text-[14px] text-ink-2">No script in view was paid short.</p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Filled</th>
                    <th className={th}>Rx</th>
                    <th className={th}>Drug</th>
                    <th className={th}>Payer</th>
                    <th className={thr}>Expected</th>
                    <th className={thr}>Paid</th>
                    <th className={thr}>Short</th>
                    <th className={th}>Reasons</th>
                    <th className={th}>Decide</th>
                  </tr>
                </thead>
                <tbody>
                  {v.short.map((l) => (
                    <tr key={l.claimId}>
                      <LegCells l={l} />
                      <td className={tdr}>{money(l.expectedCents)}</td>
                      <td className={tdr}>{money(l.paidCents)}</td>
                      <td className={`${tdr} text-crit`}>{money(l.shortCents)}</td>
                      <td className={`${td} text-[12px] text-ink-2`}>
                        {l.reasons.length ? l.reasons.map((r) => `${r.group}-${r.reason} ${money(r.cents)}`).join(" · ") : "no reasons on file"}
                        {l.decision ? <span className="block text-[11px] text-ink-3">{DECISION_WORD[l.decision] ?? l.decision}{l.decisionNote ? ` · ${l.decisionNote}` : ""}</span> : null}
                      </td>
                      <td className={td}>
                        <Decide leg={l} tab={tab} payer={payer} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      ) : null}

      {tab === "unmatched" ? (
        <section className="space-y-3">
          <p className="text-[13px] text-ink-2">
            {n(v.unmatched.length)} payments for fills inside the books that no claim here accounts for, {money(f.unmatchedCents)}.
            {v.preBooks.payments ? ` ${n(v.preBooks.payments)} more (${money(v.preBooks.cents)}) are for fills before the books and are not shown: cash, not receivable.` : ""}
          </p>
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            {v.unmatched.length === 0 ? (
              <p className="py-4 text-[14px] text-ink-2">Every payment for a fill inside the books is tied to its claim.</p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Received</th>
                    <th className={th}>Through</th>
                    <th className={thr}>Amount</th>
                    <th className={th}>Rx</th>
                    <th className={th}>Filled</th>
                    <th className={th}>Reference</th>
                    <th className={th}>What the site knows</th>
                    <th className={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {v.unmatched.map((u) => (
                    <tr key={u.id}>
                      <td className={`${td} tabular-nums text-ink-3`}>{u.receivedOn ?? "—"}</td>
                      <td className={td}>
                        {u.payer ?? "—"}
                        <span className="block text-[11px] text-ink-3">{u.source}</span>
                      </td>
                      <td className={tdr}>{money(u.amountCents, true)}</td>
                      <td className={`${td} tabular-nums`}>{u.rxNumber}{u.fillNumber !== null ? `-${u.fillNumber}` : ""}</td>
                      <td className={`${td} tabular-nums text-ink-2`}>{u.dateFilled ?? "none named"}</td>
                      <td className={`${td} text-[11px] text-ink-3`}>{(u.reference ?? "").slice(0, 28)}</td>
                      <td className={`${td} text-[12px] text-ink-2`}>
                        {u.onRxAndDate === 1 ? "one claim on that prescription and day, with another fill number" : u.onRxAndDate > 1 ? `${u.onRxAndDate} claims on that prescription and day; not guessed between` : u.onRx > 0 ? "the prescription is known, on other days" : "the prescription is not in the claims file"}
                      </td>
                      <td className={td}>
                        {u.onRxAndDate === 1 ? (
                          <form action={tiePayment}>
                            <input type="hidden" name="tab" value={tab} />
                            <input type="hidden" name="payer" value={payer ?? ""} />
                            <input type="hidden" name="paymentId" value={u.id} />
                            <button type="submit" className="rounded-md border border-line bg-surface px-2 py-1 text-[12px] hover:border-accent">
                              Tie it
                            </button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="text-[12.5px] text-ink-3">A payment ties itself to a claim where the prescription, fill, day and drug agree, loosening one step at a time and refusing to guess between two. Tie by hand only where the site names one claim; the next engine pass recomputes the standing.</p>
        </section>
      ) : null}

      {tab === "decided" ? (
        <section className="space-y-3">
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            {v.decided.length === 0 ? (
              <p className="py-4 text-[14px] text-ink-2">Nothing decided yet.</p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Filled</th>
                    <th className={th}>Rx</th>
                    <th className={th}>Drug</th>
                    <th className={th}>Payer</th>
                    <th className={thr}>Expected</th>
                    <th className={thr}>Paid</th>
                    <th className={th}>State</th>
                    <th className={th}>Decision</th>
                    <th className={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {v.decided.map((l) => (
                    <tr key={l.claimId}>
                      <LegCells l={l} />
                      <td className={tdr}>{money(l.expectedCents)}</td>
                      <td className={tdr}>{money(l.paidCents)}</td>
                      <td className={td}>
                        <Chip state={l.state} />
                      </td>
                      <td className={`${td} text-[12px]`}>
                        <span className="font-medium">{DECISION_WORD[l.decision ?? ""] ?? l.decision}</span>
                        {l.decisionNote ? <span className="block text-ink-3">{l.decisionNote}</span> : null}
                      </td>
                      <td className={td}>
                        <form action={undoDecision}>
                          <input type="hidden" name="tab" value={tab} />
                          <input type="hidden" name="payer" value={payer ?? ""} />
                          <input type="hidden" name="legKey" value={l.legKey} />
                          <button type="submit" className="rounded-md border border-line bg-surface px-2 py-1 text-[12px] hover:border-accent">
                            Undo
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
