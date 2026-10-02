import Link from "next/link";
import { complianceView } from "@/lib/engine/read";
import { todayIso, atLocal } from "@/lib/dates";
import { attestDuty, answerDuty, explainReading, signOffMonth, logDiscrepancy, resolveDiscrepancy } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Compliance: every duty the site tracks, as the libraries that judge them say it. Six figures; the register's
 * periods with the attestation that closes each; renewals and training; the temperature months; the CQI period and
 * its incidents; the controlled-substance inventory, the discrepancy log and the perpetual Schedule II count; the
 * staff matrix; the manual's standing; the inspection report. The detailed forms (an incident, a summary, the
 * self-inspection walk, a person's file, the manual) stay on their own pages, linked from here.
 */

const TABS = [
  ["register", "Register"],
  ["temps", "Temps"],
  ["cqi", "CQI"],
  ["controlled", "Controlled"],
  ["staff", "Staff"],
  ["manual", "Manual"],
  ["inspection", "Inspection"],
] as const;
type Tab = (typeof TABS)[number][0];

const th = "py-2 text-left text-[11px] font-medium uppercase tracking-wide text-ink-3";
const thr = `${th} text-right`;
const td = "border-t border-line py-1.5 text-[13px] text-ink align-top";
const tdr = `${td} text-right tabular-nums`;
const f1 = (tenths: number) => `${(tenths / 10).toFixed(1)}°F`;

function Chip({ tone, children }: { tone: "ok" | "warn" | "crit" | "muted" | "accent"; children: React.ReactNode }) {
  const cls = { ok: "bg-accent-soft text-accent-strong", warn: "bg-warn-soft text-warn", crit: "bg-crit-soft text-crit", muted: "bg-ground text-ink-3", accent: "bg-accent-soft text-accent-strong" }[tone];
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

export default async function CompliancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const today = todayIso();
  const tab = (TABS.some(([k]) => k === sp.tab) ? sp.tab : "register") as Tab;
  const error = typeof sp.error === "string" ? sp.error : null;
  const v = await complianceView(today);
  const f = v.figures;
  const q = (t: Tab) => `/v2/compliance?tab=${t}`;
  const stateTone = (s: string): "ok" | "warn" | "crit" | "muted" => (s === "missed" || s === "overdue" || s === "late" || s === "missing" ? "crit" : s === "partial" || s === "due_soon" || s === "soon" || s === "no_date" ? "warn" : s === "ok" || s === "satisfied" ? "ok" : "muted");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[18px] font-semibold text-ink">Compliance</h1>
        <span className="ml-auto text-[12px] text-ink-3">as the registers stand on {today}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Figure label="Missed duties" value={String(f.missed)} sub={f.partial ? `${f.partial} partly done` : "periods with nothing filed"} href={q("register")} tone={f.missed ? "crit" : undefined} />
        <Figure label="Renewals and training" value={String(f.dueSoon)} sub="overdue, due soon, or never dated" href={q("staff")} tone={f.dueSoon ? "warn" : undefined} />
        <Figure label="Temp months unsigned" value={String(f.unsignedMonths)} sub="sensor-months awaiting sign-off" href={q("temps")} tone={f.unsignedMonths ? "warn" : undefined} />
        <Figure label="CQI summary" value={f.cqiDays === null ? "—" : f.cqiDays < 0 ? `${-f.cqiDays} d late` : `${f.cqiDays} d`} sub={v.cqi.snapshot.label} href={q("cqi")} tone={f.cqiDays !== null && f.cqiDays < 0 ? "crit" : f.cqiDays !== null && f.cqiDays <= 7 ? "warn" : undefined} />
        <Figure label="CS inventory" value={f.csDays === null ? "never" : f.csDays < 0 ? `${-f.csDays} d late` : `${f.csDays} d`} sub={v.controlled.inventory.last ? `last taken ${v.controlled.inventory.last}` : "no inventory on file"} href={q("controlled")} tone={f.csDays === null || f.csDays < 0 ? "crit" : f.csDays <= 30 ? "warn" : undefined} />
        <Figure label="Staff gaps" value={String(f.staffGaps)} sub={`${v.staff.covered} of ${v.staff.rows.length} people fully covered`} href={q("staff")} tone={f.staffGaps ? "warn" : undefined} />
      </div>

      <nav className="flex items-center gap-1 border-b border-line text-[14px]">
        {TABS.map(([key, label]) => (
          <Link key={key} href={q(key)} className={`-mb-px border-b-2 px-3 py-2 ${tab === key ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}>
            {label}
          </Link>
        ))}
        <span className="ml-auto flex items-center gap-2 text-[13px] text-ink-3">
          <Link href="/compliance/register" className="hover:text-ink">Inspector grid</Link>·<Link href="/compliance/attestations" className="hover:text-ink">Attestations</Link>·<Link href="/licenses" className="hover:text-ink">Licences</Link>
        </span>
      </nav>

      {error ? <p className="rounded-md bg-crit-soft px-3 py-2 text-[13px] text-crit">{error}</p> : null}

      {tab === "register" ? (
        <section className="space-y-3">
          {[...v.register.missed, ...v.register.partial].length === 0 ? (
            <p className="rounded-lg border border-line bg-surface px-4 py-4 text-[14px] text-ink-2">Nothing missed and nothing partly done. {v.register.openNow.length} duties are open in their current period.</p>
          ) : null}
          {[...v.register.missed, ...v.register.partial, ...v.register.openNow].map((o) => (
            <div key={`${o.obligationId}|${o.periodKey}`} className="rounded-lg border border-line bg-surface px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <Chip tone={stateTone(o.state)}>{o.state}</Chip>
                <span className="text-[14px] font-medium text-ink">{o.title}</span>
                <span className="text-[12px] text-ink-3">{o.periodLabel} · due {o.dueOn}{o.daysLate > 0 ? ` · ${o.daysLate} days late` : ""}</span>
                {o.href ? (
                  <Link href={o.href} className="ml-auto text-[12px] text-ink-2 hover:text-ink">
                    where it is done
                  </Link>
                ) : null}
              </div>
              <p className="mt-1 text-[12.5px] text-ink-2">{o.detail} <span className="text-ink-3">{o.citation}</span></p>
              {o.missing ? <p className="mt-1 text-[12.5px] text-warn">{o.missing}</p> : null}
              {o.kind === "attest" ? (
                <form action={attestDuty} className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
                  <input type="hidden" name="tab" value="register" />
                  <input type="hidden" name="obligationId" value={o.obligationId} />
                  <input type="hidden" name="periodKey" value={o.periodKey} />
                  <input type="hidden" name="statement" value={o.statement ?? ""} />
                  <span className="max-w-xl text-ink-2">{o.statement}</span>
                  <input name="typedName" placeholder="type your name to sign" className="w-44 rounded-md border border-line bg-surface px-1.5 py-1" />
                  <button type="submit" className="rounded-md bg-accent px-2 py-1 font-medium text-white hover:bg-accent-strong">
                    Attest{o.minutes ? ` · ~${o.minutes} min` : ""}
                  </button>
                </form>
              ) : o.kind === "evidence" ? (
                <p className="mt-1 text-[12px] text-ink-3">Closed by a document ({o.have} of {o.expected} filed): add it on <Link href="/v2/documents?tab=add" className="underline">Documents</Link>.</p>
              ) : o.kind === "witnessed" ? (
                <p className="mt-1 text-[12px] text-ink-3">Closes itself once the record it watches is complete.</p>
              ) : (
                <p className="mt-1 text-[12px] text-ink-3">A renewal: the printed expiry is the deadline.</p>
              )}
            </div>
          ))}
          {v.register.unanswered.length ? (
            <div className="rounded-lg border border-line bg-surface px-4 py-3">
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Does this apply here?</h3>
              {v.register.unanswered.map((u) => (
                <form key={u.obligationId} action={answerDuty} className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
                  <input type="hidden" name="tab" value="register" />
                  <input type="hidden" name="obligationId" value={u.obligationId} />
                  <span className="text-ink">{u.title}</span>
                  <span className="text-[12px] text-ink-3">{u.citation}</span>
                  <button name="applies" value="yes" className="rounded-md border border-line px-2 py-0.5 hover:border-accent">Yes, track it</button>
                  <button name="applies" value="no" className="rounded-md border border-line px-2 py-0.5 hover:border-accent">No, not here</button>
                </form>
              ))}
            </div>
          ) : null}
          <p className="text-[12.5px] text-ink-3">{v.register.minutesOutstanding ? `About ${v.register.minutesOutstanding} minutes of attestations outstanding.` : ""} The inspector&apos;s grid, period by period, and the record of every signed statement are on their own pages (links above).</p>
        </section>
      ) : null}

      {tab === "temps" ? (
        <section className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-line bg-surface px-4 py-2">
              <h3 className="py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">Sensors · {v.temps.readingsLast24h} readings in the last day · {v.temps.readingsLast24h > 0 || v.temps.connected ? "receiving from iMonnit" : "nothing received from iMonnit in a day"}</h3>
              <table className="w-full">
                <tbody>
                  {v.temps.sensors.map((s) => (
                    <tr key={s.id}>
                      <td className={td}>
                        {s.name} <span className="text-[11px] text-ink-3">{s.kind}{s.tracked ? "" : " · not logged"}</span>
                      </td>
                      <td className={`${td} tabular-nums text-ink-2`}>{f1(s.minTenthsF)}–{f1(s.maxTenthsF)}</td>
                      <td className={`${td} tabular-nums text-ink-3`}>{s.lastReadingAt ? atLocal(s.lastReadingAt) : "never"}</td>
                      <td className={td}>
                        <Chip tone={s.calibration.state === "current" ? "ok" : s.calibration.state === "expiring" ? "warn" : s.calibration.state === "no_expiry" ? "muted" : "crit"}>calibration {s.calibration.state.replace("_", " ")}</Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rounded-lg border border-line bg-surface px-4 py-2">
              <h3 className="py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">Months awaiting sign-off</h3>
              {v.temps.awaiting.length === 0 ? (
                <p className="py-2 text-[13px] text-ink-2">Every finished month is signed.</p>
              ) : (
                v.temps.awaiting.map((m) => (
                  <form key={`${m.sensorId}|${m.periodKey}`} action={signOffMonth} className="flex flex-wrap items-center gap-2 border-t border-line py-2 text-[13px]">
                    <input type="hidden" name="tab" value="temps" />
                    <input type="hidden" name="sensorId" value={m.sensorId} />
                    <input type="hidden" name="periodKey" value={m.periodKey} />
                    <span className="text-ink">{m.sensorName} · {m.periodKey}</span>
                    <span className="text-[12px] text-ink-3">{m.readings} readings{m.unexplained ? `, ${m.unexplained} out of range unexplained` : ""}</span>
                    <Link href={`/temps/${m.sensorId}/${m.periodKey}`} className="text-[12px] text-ink-2 hover:text-ink">the log</Link>
                    <button type="submit" disabled={m.unexplained > 0} className="ml-auto rounded-md bg-accent px-2 py-1 text-[12px] font-medium text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40">
                      Sign off
                    </button>
                  </form>
                ))
              )}
            </div>
          </div>
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            <h3 className="py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">Out of range, unexplained</h3>
            {v.temps.unexplained.length === 0 ? (
              <p className="py-2 text-[13px] text-ink-2">None.</p>
            ) : (
              <table className="w-full">
                <tbody>
                  {v.temps.unexplained.map((r) => (
                    <tr key={r.id}>
                      <td className={`${td} tabular-nums text-ink-3`}>{atLocal(r.takenAt)}</td>
                      <td className={td}>{r.sensorName}</td>
                      <td className={`${tdr} text-crit`}>{f1(r.valueTenthsF)}</td>
                      <td className={`${td} text-[12px] text-ink-3`}>{f1(r.rangeMin)}–{f1(r.rangeMax)}</td>
                      <td className={td}>
                        <form action={explainReading} className="flex items-center gap-1.5 text-[12px]">
                          <input type="hidden" name="tab" value="temps" />
                          <input type="hidden" name="readingId" value={r.id} />
                          <input name="note" placeholder="what happened, what was done" className="w-72 rounded-md border border-line bg-surface px-1.5 py-1" />
                          <button type="submit" className="rounded-md bg-accent px-2 py-1 font-medium text-white hover:bg-accent-strong">Explain</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="text-[12.5px] text-ink-3">Readings arrive from iMonnit only; a person writes explanations and the month&apos;s sign-off. A month signs off only once every out-of-range reading in it has a note. Sensor set-up, calibration certificates and the printable logs are on <Link href="/temps" className="underline">the temperatures page</Link>.</p>
        </section>
      ) : null}

      {tab === "cqi" ? (
        <section className="space-y-3">
          <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="font-medium text-ink">{v.cqi.snapshot.label}</span>
              <span className="text-ink-2">due {v.cqi.snapshot.dueOn ?? "—"}</span>
              <Chip tone={v.cqi.snapshot.status === "final" ? "ok" : f.cqiDays !== null && f.cqiDays < 0 ? "crit" : "muted"}>{v.cqi.snapshot.status ?? "not started"}</Chip>
              <span className="text-ink-2">{v.cqi.snapshot.incidentCount} incidents this period · {v.cqi.snapshot.needingYou} need you · {v.cqi.snapshot.drafting} drafting</span>
              <span className="ml-auto flex gap-3 text-[12px]">
                {v.cqi.snapshot.summaryId ? <Link href={`/cqi/summaries/${v.cqi.snapshot.summaryId}`} className="text-ink-2 hover:text-ink">the summary (C-550)</Link> : null}
                <Link href="/cqi/incidents/new" className="text-ink-2 hover:text-ink">log an incident</Link>
                <Link href="/cqi" className="text-ink-2 hover:text-ink">the program</Link>
              </span>
            </div>
            {v.cqi.carried.any ? (
              <p className="mt-2 text-[12.5px] text-warn">
                Carried forward: {[v.cqi.carried.openReviews ? `${v.cqi.carried.openReviews} open reviews` : null, v.cqi.carried.thin ? `${v.cqi.carried.thin} thin analyses` : null, v.cqi.carried.ineffective ? `${v.cqi.carried.ineffective} plans found ineffective` : null, v.cqi.carried.capMissing ? `${v.cqi.carried.capMissing} without a plan` : null].filter(Boolean).join(", ")}.
              </p>
            ) : null}
          </div>
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            {v.cqi.stages.length === 0 ? (
              <p className="py-3 text-[13px] text-ink-2">No incidents on file.</p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Incident</th>
                    <th className={th}>Reported</th>
                    <th className={th}>Type</th>
                    <th className={th}>Stage</th>
                    <th className={th}>Next</th>
                    <th className={th}>By</th>
                  </tr>
                </thead>
                <tbody>
                  {v.cqi.stages.map((s) => (
                    <tr key={s.id}>
                      <td className={td}>
                        <Link href={`/cqi/incidents/${s.id}`} className="hover:underline">{s.incidentNumber}</Link>
                      </td>
                      <td className={`${td} tabular-nums text-ink-3`}>{s.reportCreatedOn}</td>
                      <td className={`${td} text-ink-2`}>{s.type.replace(/_/g, " ")}</td>
                      <td className={td}>
                        <Chip tone={s.stage.level === "crit" ? "crit" : s.stage.level === "warn" ? "warn" : s.stage.key === "closed" ? "ok" : "muted"}>{s.stage.label}</Chip>
                        {s.stage.automatic ? <span className="ml-1 text-[11px] text-ink-3">automatic</span> : null}
                      </td>
                      <td className={`${td} text-[12px] text-ink-2`}>{s.stage.next}</td>
                      <td className={`${td} tabular-nums text-ink-3`}>{s.stage.dueOn ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="text-[12.5px] text-ink-3">The review opens within seven days of the report and completes within thirty (K.A.R. 68-19-1); the summary is due on the 15th after the period ends. The site opens reviews and assembles the period itself; the analysis and the plan are the pharmacist&apos;s words.</p>
        </section>
      ) : null}

      {tab === "controlled" ? (
        <section className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">The inventory</h3>
              <p className="mt-1 text-ink">
                {v.controlled.inventory.last ? `Last taken ${v.controlled.inventory.last}; the next is due ${v.controlled.inventory.dueOn} (Kansas: every year; DEA: every two).` : "No inventory on file. Kansas wants one every year, the DEA every two, and the signed hard copy is the record."}
              </p>
              <p className="mt-1 text-[12px] text-ink-3">
                {v.controlled.inventory.count} on file · <Link href="/inventory" className="underline">record one, print C-250</Link> · <Link href="/inventory/power-of-attorney" className="underline">the DEA power of attorney</Link> · <Link href="/inventory/pharmacist-log" className="underline">the daily pharmacist log</Link>
              </p>
              <h3 className="mt-3 text-[11px] font-medium uppercase tracking-wide text-ink-3">What the records must show</h3>
              <ul className="mt-1 space-y-0.5 text-[12.5px]">
                {v.controlled.requirements.map((r) => (
                  <li key={r.key} className="flex items-start gap-2">
                    <Chip tone={r.state === "ok" ? "ok" : "warn"}>{r.state === "ok" ? "satisfied" : "needs attention"}</Chip>
                    <span className="text-ink-2">{r.title}: {r.says}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Perpetual Schedule II count</h3>
              {v.controlled.perpetual ? (
                <>
                  <p className="mt-1 text-ink">{v.controlled.perpetual.says}</p>
                  {v.controlled.perpetual.off.length || v.controlled.perpetual.moving.length ? (
                    <table className="mt-2 w-full">
                      <thead>
                        <tr>
                          <th className={th}>Item</th>
                          <th className={thr}>Start</th>
                          <th className={thr}>+ In</th>
                          <th className={thr}>− Filled</th>
                          <th className={thr}>+ Back</th>
                          <th className={thr}>Expected</th>
                          <th className={thr}>On hand</th>
                          <th className={thr}>Off by</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...v.controlled.perpetual.off, ...v.controlled.perpetual.moving].slice(0, 30).flatMap((p) => [
                          <tr key={p.key}>
                            <td className={td}>
                              <span className="font-medium">{(p.name ?? p.ndcs[0]?.name ?? p.key).slice(0, 40)}</span>
                              <span className="block text-[11px] text-ink-3">{p.ndcs.length} NDC{p.ndcs.length === 1 ? "" : "s"}{p.stable ? "" : " · moved on the last day only"}</span>
                            </td>
                            <td className={tdr}>{p.ndcs.reduce((n, m) => n + m.open, 0)}</td>
                            <td className={tdr}>{p.ndcs.reduce((n, m) => n + m.received, 0) || ""}</td>
                            <td className={tdr}>{p.ndcs.reduce((n, m) => n + m.filled, 0) || ""}</td>
                            <td className={tdr}>{p.ndcs.reduce((n, m) => n + m.returned, 0) || ""}</td>
                            <td className={tdr}>{p.ndcs.reduce((n, m) => n + m.expected, 0)}</td>
                            <td className={tdr}>{p.ndcs.reduce((n, m) => n + m.close, 0)}</td>
                            <td className={`${tdr} font-medium ${!p.stable ? "text-ink-3" : p.variance < 0 ? "text-crit" : "text-warn"}`}>{p.variance > 0 ? "+" : ""}{p.variance}</td>
                          </tr>,
                          ...(p.ndcs.length > 1
                            ? p.ndcs.map((m) => (
                                <tr key={`${p.key}|${m.ndc11}`} className="text-[12px] text-ink-3">
                                  <td className={`${td} pl-4 text-[12px] text-ink-3`}>{(m.name ?? "").slice(0, 32)} <span className="tabular-nums">{m.ndc11}</span> · {m.from} to {m.to}</td>
                                  <td className={`${tdr} text-ink-3`}>{m.open}</td>
                                  <td className={`${tdr} text-ink-3`}>{m.received || ""}</td>
                                  <td className={`${tdr} text-ink-3`}>{m.filled || ""}</td>
                                  <td className={`${tdr} text-ink-3`}>{m.returned || ""}</td>
                                  <td className={`${tdr} text-ink-3`}>{m.expected}</td>
                                  <td className={`${tdr} text-ink-3`}>{m.close}</td>
                                  <td className={`${tdr} text-ink-3`}>{m.variance > 0 ? "+" : ""}{m.variance}</td>
                                </tr>
                              ))
                            : []),
                        ])}
                      </tbody>
                    </table>
                  ) : null}
                  <p className="mt-2 text-[12px] text-ink-3">{v.controlled.perpetual.notSeen}</p>
                  <details className="mt-1 text-[12px] text-ink-3">
                    <summary className="cursor-pointer">How this is reconciled</summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {v.controlled.perpetual.assumptions.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  </details>
                </>
              ) : (
                <p className="mt-1 text-ink-2">Not computed: PioneerRx&apos;s on-hand files have not been read yet.</p>
              )}
            </div>
          </div>
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            <h3 className="py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">Discrepancy log</h3>
            {v.controlled.discrepancies.length === 0 ? <p className="py-2 text-[13px] text-ink-2">Nothing logged.</p> : null}
            {v.controlled.discrepancies.map((d) => (
              <div key={d.id} className="border-t border-line py-2 text-[13px]">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Chip tone={d.resolvedOn ? "ok" : "crit"}>{d.resolvedOn ? `resolved ${d.resolvedOn}` : "open"}</Chip>
                  <span className="text-ink">{d.discoveredOn} · {d.drugName} · {d.schedule}</span>
                  {d.expectedThousandths !== null || d.countedThousandths !== null ? (
                    <span className="tabular-nums text-ink-2">
                      expected {d.expectedThousandths !== null ? d.expectedThousandths / 1000 : "?"}, counted {d.countedThousandths !== null ? d.countedThousandths / 1000 : "?"} {d.unit ?? ""}
                    </span>
                  ) : null}
                  {d.reportedToDea ? <Chip tone="muted">DEA told</Chip> : null}
                </div>
                {d.resolution ? <p className="mt-0.5 text-[12.5px] text-ink-2">{d.resolution}</p> : null}
                {!d.resolvedOn ? (
                  <form action={resolveDiscrepancy} className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px]">
                    <input type="hidden" name="tab" value="controlled" />
                    <input type="hidden" name="id" value={d.id} />
                    <input name="resolution" placeholder="how it was resolved" className="w-72 rounded-md border border-line bg-surface px-1.5 py-1" />
                    <label className="flex items-center gap-1 text-ink-2">
                      <input type="checkbox" name="reportedToDea" value="yes" /> reported to the DEA (Form 106)
                    </label>
                    <button type="submit" className="rounded-md bg-accent px-2 py-1 font-medium text-white hover:bg-accent-strong">Resolve</button>
                  </form>
                ) : null}
              </div>
            ))}
            <form action={logDiscrepancy} className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-3 text-[12px]">
              <input type="hidden" name="tab" value="controlled" />
              <input type="date" name="discoveredOn" defaultValue={today} className="rounded-md border border-line bg-surface px-1.5 py-1" />
              <input name="drugName" placeholder="drug and strength" className="w-48 rounded-md border border-line bg-surface px-1.5 py-1" />
              <select name="schedule" className="rounded-md border border-line bg-surface px-1.5 py-1" defaultValue="CII">
                {["CII", "CIII", "CIV", "CV", "non_controlled", "unknown"].map((s) => (
                  <option key={s} value={s}>{s.replace("_", " ")}</option>
                ))}
              </select>
              <input name="expected" placeholder="expected" className="w-20 rounded-md border border-line bg-surface px-1.5 py-1" />
              <input name="counted" placeholder="counted" className="w-20 rounded-md border border-line bg-surface px-1.5 py-1" />
              <input name="unit" placeholder="unit" className="w-14 rounded-md border border-line bg-surface px-1.5 py-1" />
              <input name="narrative" placeholder="what was found, and how" className="w-72 rounded-md border border-line bg-surface px-1.5 py-1" />
              <button type="submit" className="rounded-md bg-accent px-2 py-1 font-medium text-white hover:bg-accent-strong">Log it</button>
            </form>
          </div>
          <p className="text-[12.5px] text-ink-3">A significant loss or theft is reported to the DEA on Form 106 within one business day of discovery (21 CFR 1301.76(b)); the log records that it was, it does not file it. Invoices by schedule, with the Schedule II records kept apart, are on <Link href="/inventory/invoices" className="underline">the invoices page</Link>.</p>
        </section>
      ) : null}

      {tab === "staff" ? (
        <section className="space-y-3">
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Person</th>
                    {v.staff.columns.map((c) => (
                      <th key={c.key} className={th} title={c.label}>{c.short}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {v.staff.rows.map((r) => (
                    <tr key={r.id}>
                      <td className={td}>
                        <Link href={`/staff/${r.id}`} className="hover:underline">{r.name}</Link>
                        <span className="block text-[11px] text-ink-3">{r.role.replace(/_/g, " ")}{r.isPic ? " · PIC" : ""}</span>
                      </td>
                      {v.staff.columns.map((c) => {
                        const cell = r.cells[c.key];
                        return (
                          <td key={c.key} className={`${td} text-[12px]`}>
                            {cell && cell.state !== "na" ? <Chip tone={stateTone(cell.state)}>{cell.label}</Chip> : <span className="text-ink-3">—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            <h3 className="py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">Renewals and training, ninety days out</h3>
            {v.due.length === 0 ? (
              <p className="py-2 text-[13px] text-ink-2">Nothing due in the next ninety days.</p>
            ) : (
              <table className="w-full">
                <tbody>
                  {v.due.map((d) => (
                    <tr key={d.id}>
                      <td className={td}>
                        <Chip tone={stateTone(d.severity)}>{d.severity.replace("_", " ")}</Chip>
                      </td>
                      <td className={td}>
                        <Link href={d.href} className="hover:underline">{d.title}</Link>
                        <span className="block text-[11px] text-ink-3">{d.personName}{d.citation ? ` · ${d.citation}` : ""}</span>
                      </td>
                      <td className={`${td} tabular-nums text-ink-2`}>{d.dueOn ?? "no date"}</td>
                      <td className={`${td} text-[12px] text-ink-2`}>{d.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="text-[12.5px] text-ink-3">A required credential with no record, a training never completed, and a record with no expiry date are each shown as their own state, never as satisfied. Sending and recording training, the new-hire pack, rotations and the technician list (C-900) are on <Link href="/compliance/training" className="underline">Training</Link> and <Link href="/staff" className="underline">Staff</Link>.</p>
        </section>
      ) : null}

      {tab === "manual" ? (
        <section className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <Figure label="Sections" value={String(v.manual.standing.ownSections)} sub={`${v.manual.standing.managedElsewhere} managed elsewhere · ${v.manual.standing.emptyHeadings} empty headings`} />
            <Figure label="Never reviewed" value={String(v.manual.standing.neverReviewed)} sub={v.manual.standing.oldestReviewedOn ? `oldest review ${v.manual.standing.oldestReviewedOn}` : "no review on record"} tone={v.manual.standing.neverReviewed ? "warn" : undefined} />
            <Figure label="Acknowledgements" value={String(v.manual.ack.missing + v.manual.ack.superseded)} sub={`${v.manual.ack.missing} missing · ${v.manual.ack.superseded} on an old revision${v.manual.ack.changedOn ? ` · changed ${v.manual.ack.changedOn}` : ""}`} tone={v.manual.ack.missing + v.manual.ack.superseded ? "warn" : undefined} />
          </div>
          <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-ink-2">
            <p>
              Audit against the requirements: {v.manual.audit.current} of {v.manual.audit.total} sections read within the year, {v.manual.audit.due} due, {v.manual.audit.open} findings open{v.manual.audit.blocking ? ` (${v.manual.audit.blocking} blocking)` : ""}. {v.manual.audit.lastRunAt ? `Last run ${atLocal(v.manual.audit.lastRunAt)}: ${v.manual.audit.lastResult ?? ""}` : "Never run."} {v.manual.decisionsOutstanding ? `${v.manual.decisionsOutstanding} practice decisions still unanswered.` : ""}
            </p>
            <p className="mt-2 text-[12px]">
              <Link href="/manual" className="underline">The manual</Link> · <Link href="/manual/decisions" className="underline">practice decisions</Link> · <Link href="/manual/print" className="underline">print</Link> · <Link href="/documents/manual" className="underline">the appendix</Link> · revision {v.manual.standing.revision.fingerprint.slice(0, 8)}
            </p>
          </div>
        </section>
      ) : null}

      {tab === "inspection" ? (
        <section className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <Figure label="Would be a finding" value={String(v.inspection.report.blocking)} tone={v.inspection.report.blocking ? "crit" : undefined} />
            <Figure label="Weaker than it should be" value={String(v.inspection.report.gaps)} tone={v.inspection.report.gaps ? "warn" : undefined} />
            <Figure label="Ready to hand over" value={String(v.inspection.report.ready)} sub={v.inspection.report.verdict} />
          </div>
          <div className="rounded-lg border border-line bg-surface px-4 py-2">
            <table className="w-full">
              <tbody>
                {v.inspection.report.checks.map((c) => (
                  <tr key={c.key}>
                    <td className={td}>
                      <Chip tone={c.state === "ready" ? "ok" : c.state === "gap" ? "warn" : "crit"}>{c.state}</Chip>
                    </td>
                    <td className={`${td} text-[11px] uppercase text-ink-3`}>{c.who}</td>
                    <td className={td}>
                      <span className="text-ink">&ldquo;{c.asks}&rdquo;</span>
                      <span className="block text-[12px] text-ink-2">{c.answer}</span>
                      <span className="block text-[11px] text-ink-3">{c.authority}</span>
                    </td>
                    <td className={`${td} text-[12px]`}>
                      {c.href ? <Link href={c.href} className="text-ink-2 hover:text-ink">where</Link> : null}
                      {c.printHref ? <Link href={c.printHref} className="ml-2 text-ink-2 hover:text-ink">print</Link> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-ink-2">
            <p>
              Self-inspection: {v.inspection.progress ? `a walk is open, started ${v.inspection.progress.startedOn}, ${v.inspection.progress.answered} of ${v.inspection.progress.total} answered, ${v.inspection.progress.findings} findings.` : v.inspection.lastCompleted ? `last completed ${v.inspection.lastCompleted}.` : "never completed."} {v.inspection.findings.length ? `${v.inspection.findings.length} findings still open.` : ""} Business associates: {v.inspection.baas.summary}
            </p>
            <p className="mt-2 text-[12px]">
              <Link href="/inspection/walk" className="underline">{v.inspection.progress ? "continue the walk" : "start a self-inspection"}</Link> · <Link href="/inspection/print" className="underline">the inspection pack</Link> · <Link href="/agreements" className="underline">business associate register</Link>
            </p>
          </div>
        </section>
      ) : null}
    </div>
  );
}
