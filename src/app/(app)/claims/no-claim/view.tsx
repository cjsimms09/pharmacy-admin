import type { UntiedLine, UntiedPayments } from "@/lib/untied-payments-store";
import { CAUSES, causeInfo, claimBesideSays, namesSays, needsSays, partnerSays, sourceSays, tallyByNeeds, type ClaimBeside } from "@/lib/untied-payments";
import { fmt } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { PageHeader, Card, Figure, Notice, Empty } from "@/components/ui";

const payments = (n: number) => `${n.toLocaleString("en-US")} payment${n === 1 ? "" : "s"}`;
/* A sum beside its count: "net" over more than one payment, because a take-back is a payment of less than nothing. */
const sum = (n: number, cents: number) => `${n === 1 ? "" : "net "}${formatCents(cents)}`;
const Money = ({ cents }: { cents: number }) => <span className={cents < 0 ? "text-crit" : ""}>{formatCents(cents)}</span>;

function Beside({ c }: { c: ClaimBeside }) {
  const s = claimBesideSays(c);
  return (
    <li>
      <span className="font-medium">{s.who}</span>
      <span className="text-ink-3"> · {s.rest}</span>
    </li>
  );
}

function Lines({ lines }: { lines: UntiedLine[] }) {
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="table">
        <thead>
          <tr>
            <th>Received</th>
            <th>Paid by</th>
            <th className="text-right">Amount</th>
            <th>Names</th>
            <th>Claims the site holds for the prescription</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="align-top">
              <td className="whitespace-nowrap">{l.receivedOn ? fmt(l.receivedOn) : "no date"}</td>
              <td>
                <div className="font-medium">{sourceSays(l.source)}</div>
                <div className="text-xs text-ink-3">{[l.payer ?? "no payer name", l.reference ?? "no reference"].join(" · ")}</div>
              </td>
              <td className="text-right tabular-nums">
                <Money cents={l.amountCents} />
              </td>
              <td>
                <div className="font-medium tabular-nums">Rx {l.rxNumber}</div>
                <div className="text-xs text-ink-3">{namesSays(l)}</div>
                {l.partner && <div className="mt-1 text-xs text-ink-2">{partnerSays(l, l.partner)}</div>}
              </td>
              <td>
                {l.claims.length === 0 ? (
                  <span className="text-ink-3">None: the site holds no claim for this prescription.</span>
                ) : (
                  <ul className="grid gap-1 text-sm">
                    {l.claims.map((c) => (
                      <Beside key={c.id} c={c} />
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Every payment received since the books begin that is tied to no claim, grouped by why, so that what needs a person stands apart
 * from what needs nothing. The reason is the matcher's own answer (untied-payments.ts), asked and not reached again.
 * Nothing on this page changes anything.
 */
export function PaymentsWithNoClaim({ r }: { r: UntiedPayments }) {
  const groups = tallyByNeeds(r.tally);
  const early = r.beforeFeed.reduce((t, b) => ({ count: t.count + b.count, cents: t.cents + b.cents }), { count: 0, cents: 0 });
  const figures = groups.length + (early.count > 0 ? 1 : 0);
  const cols = figures >= 5 ? "lg:grid-cols-5" : figures === 3 ? "lg:grid-cols-3" : "lg:grid-cols-4";
  const earlyInfo = causeInfo("before_feed", r.feedFrom);

  return (
    <>
      <PageHeader
        title="Payments with no claim"
        subtitle={`Money received since ${fmt(r.booksFrom)} that the site has not tied to a claim, and why. Nothing on this page changes anything.`}
        back={{ href: "/claims", label: "Claims" }}
      />

      {r.total.count === 0 ? (
        <Empty>{r.headline}</Empty>
      ) : (
        <>
          <Notice kind={groups.some((g) => g.needs === "decide") ? "warn" : "ok"}>{r.headline}</Notice>

          <div className={`mb-4 grid gap-3 sm:grid-cols-2 ${cols}`}>
            {groups.map((g) => (
              <Figure key={g.needs} label={needsSays(g.needs)} value={g.count.toLocaleString("en-US")} sub={sum(g.count, g.cents)} tone={g.needs === "decide" || g.needs === "look" ? "warn" : "muted"} />
            ))}
            {early.count > 0 && <Figure label="Fills from before the feed" value={early.count.toLocaleString("en-US")} sub={sum(early.count, early.cents)} tone="muted" />}
          </div>

          {CAUSES.filter((c) => c !== "before_feed").map((cause) => {
            const lines = r.lines.filter((l) => l.cause === cause);
            if (lines.length === 0) return null;
            const info = causeInfo(cause, r.feedFrom);
            const open = info.needs === "decide" || info.needs === "look";
            return (
              <Card key={cause} id={cause} title={info.label} count={`${payments(lines.length)} · ${sum(lines.length, lines.reduce((n, l) => n + l.amountCents, 0))}`} tone={info.needs === "decide" ? "warn" : undefined} className="mb-4">
                <p className="text-sm">
                  <b>{needsSays(info.needs)}.</b> {info.asks}
                </p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm font-semibold">Why the site has not tied {lines.length === 1 ? "it" : "them"} to a claim</summary>
                  <p className="mt-1 text-sm text-ink-2">{info.why}</p>
                </details>
                {open ? (
                  <Lines lines={lines} />
                ) : (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm font-semibold">Show the {payments(lines.length)}</summary>
                    <Lines lines={lines} />
                  </details>
                )}
              </Card>
            );
          })}

          {early.count > 0 && (
            <Card id="before_feed" title={earlyInfo.label} count={`${payments(early.count)} · ${sum(early.count, early.cents)}`} className="mb-4">
              <p className="text-sm text-ink-2">{earlyInfo.why}</p>
              <div className="mt-2 overflow-x-auto rounded-lg border border-line bg-surface">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Paid by</th>
                      <th className="text-right">Payments</th>
                      <th className="text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.beforeFeed.map((b) => (
                      <tr key={b.source}>
                        <td>{sourceSays(b.source)}</td>
                        <td className="text-right tabular-nums">{b.count.toLocaleString("en-US")}</td>
                        <td className="text-right tabular-nums">
                          <Money cents={b.cents} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <details className="text-sm text-ink-2">
            <summary className="cursor-pointer text-sm font-semibold">Where these numbers come from, and what this page cannot do</summary>
            <p className="mt-2 max-w-3xl">
              Each line is a payment the site read from a remittance, a Medicare Transaction Facilitator report, a copay-card statement or a credit memo and filed as money received. It is here
              when it was received on or after {fmt(r.booksFrom)} and is attached to no claim. The reason is the answer of the same matcher that attaches a payment to its claim each time
              claims are loaded; this page asks it and reaches no verdict of its own. Money received before {fmt(r.booksFrom)} is not tracked.
            </p>
            <p className="mt-2 max-w-3xl">
              This page only shows. The site cannot yet attach a payment to a claim by hand, and a payment is never attached to a claim it merely resembles.
            </p>
          </details>
        </>
      )}
    </>
  );
}
