import Link from "next/link";
import { requireManager } from "@/lib/auth";
import { feedsNow, type Feed } from "@/lib/feeds";
import { agoWords } from "@/lib/feed-rules";
import { familyTabs } from "@/lib/families";
import { PageHeader, Notice, BackLink, Card, Figure } from "@/components/ui";

export const metadata = { title: "Is everything arriving?" };
export const dynamic = "force-dynamic";

/**
 * Every feed the site runs on, with when it last arrived and whether that is soon enough.
 *
 * The owner's question: "how can we verify each of these are working — NADAC current, MTF
 * payments being found — is there a better way to verify all this?" The answer is three checks
 * of increasing strength, and this page runs all three: the newest row in each table against the
 * feed's cadence (always); a live probe of the outside service (on request, because it takes
 * seconds); and a proof that what arrived covers what it should — claims on every open day, an
 * 835 line behind fills old enough to be paid — because a feed can be arriving and still be short.
 */
export default async function FeedsPage({ searchParams }: { searchParams: Promise<{ check?: string }> }) {
  await requireManager();
  const { check } = await searchParams;
  const probing = check === "1";
  const now = new Date();
  const { feeds, late } = await feedsNow({ probe: probing, now });
  const arriving = feeds.filter((f) => f.group === "arriving");
  const services = feeds.filter((f) => f.group === "services");
  const onTime = feeds.filter((f) => f.state === "on_time").length;
  const off = feeds.filter((f) => f.state === "off").length;

  return (
    <>
      <BackLink href="/settings">Settings</BackLink>
      <PageHeader
        tabs={familyTabs("connections", "/settings/feeds")}
        title="Is everything arriving?"
        subtitle="Every feed the site runs on: how often it should arrive, when it last did, and whether that is soon enough. Judged from the data itself, never from a job saying it ran."
        actions={
          probing ? (
            <Link href="/settings/feeds" className="btn">Done checking</Link>
          ) : (
            <Link href="/settings/feeds?check=1" className="btn btn-primary">Check the outside services now</Link>
          )
        }
      />

      {late.length > 0 ? (
        <Notice kind="crit">
          <b>{late.length === 1 ? "One feed has stopped" : `${late.length} feeds have stopped`}:</b> {late.map((f) => f.label).join(", ")}. Every figure downstream of {late.length === 1 ? "it" : "them"} is quietly going stale while continuing to look right.
        </Notice>
      ) : (
        <Notice kind="ok">Nothing that should have arrived is missing.</Notice>
      )}
      {probing && <Notice>Live checks ran against CMS, the mailbox, Claude and the facilitator&rsquo;s tool. What each said is on its row.</Notice>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure size="sm" value={onTime} label="Arriving on time" sub={`of ${feeds.length - off} switched on`} tone={late.length ? "warn" : "ok"} />
        <Figure size="sm" value={late.length} label="Stopped or broken" sub={late.length ? late.map((f) => f.label).slice(0, 3).join(", ") : "none"} tone={late.length ? "crit" : "ok"} />
        <Figure size="sm" value={feeds.filter((f) => f.state === "never").length} label="Never arrived" sub="switched on, nothing yet" tone="muted" />
        <Figure size="sm" value={off} label="Switched off" sub="not expected, so not late" tone="muted" />
      </div>

      <FeedTable title="Reports and files" subtitle="What lands in the tables, in the order it should worry you." feeds={arriving} now={now} />
      <FeedTable title="Outside services" subtitle="The things the site talks to. A stored key is not a working connection; the live check is." feeds={services} now={now} />

      <Card title="How to know, and what to do" className="mt-6 text-sm">
        <ol className="list-decimal space-y-2 pl-5 text-ink-2">
          <li>
            <b>Cadence</b> — the newest row in the table the feed fills, against how often it should arrive. A daily report gets two days and a bit so a closed Sunday is not an alarm; a Monday file gets nine days for a bank holiday; a monthly statement gets forty days. Late here means the report stopped, not that it is slow.
          </li>
          <li>
            <b>Live check</b> — the button above asks CMS for its newest NADAC date and compares it to the one held, logs into the mailbox, asks Claude to answer, and runs the facilitator&rsquo;s tool. A stored key that no longer works fails here and nowhere else.
          </li>
          <li>
            <b>Proof</b> — arriving is not the same as complete. Claims are checked for a day with no fills; 835s for the share of fills two to ten weeks old that have a paid line behind them, and for payers that have gone quiet; invoices for suppliers with nothing in three weeks; a price file for a size that says it is a partial export.
          </li>
        </ol>
        <p className="mt-3 text-xs text-ink-3">
          When a feed is late: a PioneerRx report that stopped is usually a schedule somebody deleted or an address that bounced — open the report in PioneerRx and check its schedule and recipient. A payer with no 835 in thirty days is either paying you by paper or has lost the enrolment; the Claims page says which. The facilitator&rsquo;s key expires every ninety days and the row above says when.
        </p>
      </Card>
    </>
  );
}

function FeedTable({ title, subtitle, feeds, now }: { title: string; subtitle: string; feeds: Feed[]; now: Date }) {
  return (
    <Card title={title} subtitle={subtitle} className="mt-4">
      <div className="overflow-x-auto">
        <table className="table text-sm">
          <thead>
            <tr>
              <th>Feed</th>
              <th>Should arrive</th>
              <th>Last arrived</th>
              <th>State</th>
              <th>What is held, and the proof</th>
            </tr>
          </thead>
          <tbody>
            {feeds.map((f) => (
              <tr key={f.key} className={f.state === "off" ? "text-ink-3" : ""}>
                <td className="whitespace-nowrap"><Link href={f.href} className="font-medium hover:text-accent hover:underline">{f.label}</Link></td>
                <td className="text-xs text-ink-2">{f.cadence}</td>
                <td className="whitespace-nowrap text-xs">{f.lastAt ? <>{agoWords(f.lastAt, now)} <span className="text-ink-3">· {f.lastAt.slice(0, 10)}</span></> : "—"}</td>
                <td><StateBadge state={f.state} /></td>
                <td className="text-xs text-ink-2">
                  <span className="block">{f.detail}</span>
                  {f.proof && <span className="block text-ink-3">{f.proof}</span>}
                  {f.probe && (
                    <span className={`mt-1 block ${f.probe.ok ? "text-accent" : "text-crit"}`}>
                      <b>Live check:</b> {f.probe.says}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function StateBadge({ state }: { state: Feed["state"] }) {
  const cls =
    state === "on_time" ? "badge-ok" : state === "late" || state === "broken" ? "badge-crit" : state === "never" || state === "unproven" ? "badge-warn" : "badge-muted";
  const word =
    state === "on_time" ? "on time" : state === "late" ? "stopped" : state === "broken" ? "broken" : state === "never" ? "never arrived" : state === "unproven" ? "not proved" : "off";
  return <span className={`badge whitespace-nowrap ${cls}`}>{word}</span>;
}
