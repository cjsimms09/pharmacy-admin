import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { setupNow } from "@/lib/setup-store";
import type { SetupItem } from "@/lib/setup-checklist";
import { PageHeader, Card, Figure, Notice } from "@/components/ui";

export const metadata = { title: "Finish setting up" };
export const dynamic = "force-dynamic";

/**
 * One list of what the site still needs, so nobody has to hold forty screens in their head.
 *
 * The owner: "I'm getting overwhelmed about what I need to do to get the site complete and
 * accurate." Every page already says what it is missing, which is exactly the problem. This is the
 * one place that answers it: what is left, what breaks while it is left, how long it takes, and the
 * button that goes there. Ranked by what it costs to leave undone, quickest first inside each rank,
 * so a spare ten minutes can always be spent on the most useful ten minutes available.
 *
 * Nothing here is ticked by hand. An item is done because a table, a setting or a feed says so, and
 * it un-ticks itself if that stops being true.
 */

const AREA_WORDS: Record<SetupItem["area"], string> = {
  connections: "Connections",
  buying: "Buying",
  claims: "Getting paid",
  money: "Money",
  compliance: "Compliance",
};

const RANK_WORDS: Record<SetupItem["rank"], { label: string; tone: "crit" | "warn" | "muted" }> = {
  stops: { label: "something is wrong until this is done", tone: "crit" },
  sharpens: { label: "works, but is an estimate until this is done", tone: "warn" },
  later: { label: "worth having, nothing waits on it", tone: "muted" },
};

function Row({ item }: { item: SetupItem }) {
  const rank = RANK_WORDS[item.rank];
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line py-3 last:border-b-0">
      <div className="min-w-[18rem] flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-base font-semibold text-ink">{item.title}</span>
          <span className={`badge ${item.rank === "stops" ? "badge-crit" : item.rank === "sharpens" ? "badge-warn" : "badge-muted"}`}>{AREA_WORDS[item.area]}</span>
          <span className="text-xs text-ink-3">about {item.minutes} min</span>
        </div>
        <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-2">{item.why}</p>
        {item.detail && <p className="mt-0.5 text-xs text-ink-3">{item.detail} — {rank.label}.</p>}
      </div>
      <Link href={item.href} className="btn btn-primary shrink-0">{item.action}</Link>
    </li>
  );
}

export default async function SetupPage() {
  await requireUser();
  const { left, done, minutesLeft, progress, stops } = await setupNow();
  const hours = Math.round((minutesLeft / 60) * 10) / 10;

  return (
    <>
      <PageHeader
        title="Finish setting up"
        subtitle="Everything the site still needs from you, in the order that costs the most to leave undone. Nothing here is ticked by hand: an item is done because the site can see it is done."
        actions={<Link href="/" className="btn">Today</Link>}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure size="sm" value={`${Math.round(progress * 100)}%`} label="Set up" sub={`${done.length} of ${done.length + left.length} done`} tone={progress >= 1 ? "ok" : "muted"} />
        <Figure size="sm" value={stops} label="Things something waits on" sub={stops ? "a figure is wrong or missing until each is done" : "nothing is blocked"} tone={stops ? "crit" : "ok"} />
        <Figure size="sm" value={left.length - stops} label="Things that would sharpen a figure" sub="works today, but on an estimate" tone={left.length - stops > 0 ? "warn" : "ok"} />
        <Figure size="sm" value={hours < 1 ? `${minutesLeft} min` : `${hours} hr`} label="To do it all" sub="at a rough minute a field" tone="muted" />
      </div>

      {left.length === 0 ? (
        <Notice kind="ok">
          <b>Everything the site can check is in place.</b> It has every feed, every figure and every document it knows how to ask for. What is left is the work itself.
        </Notice>
      ) : (
        <Card
          className="my-4"
          title="What is left"
          count={`${left.length} · ${hours < 1 ? `${minutesLeft} min` : `${hours} hr`}`}
          subtitle="Quickest first inside each rank, so ten spare minutes are always worth spending."
        >
          <ol className="-my-1">
            {left.map((i) => (
              <Row key={i.key} item={i} />
            ))}
          </ol>
        </Card>
      )}

      {done.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-semibold">{done.length} already done</summary>
          <ul className="mt-2 space-y-1 text-sm text-ink-2">
            {done.map((i) => (
              <li key={i.key} className="flex flex-wrap items-baseline gap-2">
                <span className="badge badge-ok">done</span>
                <span className="font-medium text-ink">{i.title}</span>
                <span className="text-xs text-ink-3">{i.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="mt-6 max-w-prose text-xs text-ink-3">
        This list is built from the site&rsquo;s own checks, not from a plan somebody wrote down: the mailbox is connected or it is not, the count was uploaded or it was not, the plan register is complete or it is not. If something here is wrong, the page it points at is where the truth is.
      </p>
    </>
  );
}
