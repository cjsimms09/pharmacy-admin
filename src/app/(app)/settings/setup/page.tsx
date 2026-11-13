import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, requireManager } from "@/lib/auth";
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
 *
 * And it takes a third answer, which it did not before. The owner, 16 September, pasting
 * forty-five rows of it: "these are all irrelevant, i dont have them or they arent relevant, need
 * system to leave me alone about them". Every row ended "something is wrong until this is done",
 * which is true of a missing order minimum and false of an order minimum for a wholesaler he has
 * never bought from — and there was no way to say the second. So they can be set aside, in one
 * press for as many as he likes, with the reason kept and every one of them one press from coming
 * back. Set aside is not done, and the two are never counted together.
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

function Row({ item, canManage }: { item: SetupItem; canManage: boolean }) {
  const rank = RANK_WORDS[item.rank];
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line py-3 last:border-b-0">
      <div className="flex min-w-[18rem] flex-1 items-start gap-2">
        {canManage && (
          <input
            type="checkbox"
            name="pick"
            value={item.key}
            className="mt-1.5 shrink-0"
            aria-label={`Set aside: ${item.title}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-base font-semibold text-ink">{item.title}</span>
            <span className={`badge ${item.rank === "stops" ? "badge-crit" : item.rank === "sharpens" ? "badge-warn" : "badge-muted"}`}>{AREA_WORDS[item.area]}</span>
            <span className="text-xs text-ink-3">about {item.minutes} min</span>
          </div>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-2">{item.why}</p>
          {item.detail && <p className="mt-0.5 text-xs text-ink-3">{item.detail} — {rank.label}.</p>}
        </div>
      </div>
      <Link href={item.href} className="btn btn-primary shrink-0">{item.action}</Link>
    </li>
  );
}

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  const { ok } = await searchParams;
  /* The same two roles `requireManager` lets through, so the control is never offered to somebody the action will refuse. */
  const canManage = user.role === "owner" || user.role === "pic";
  const { left, done, notApplicable, minutesLeft, progress, stops } = await setupNow();
  const hours = Math.round((minutesLeft / 60) * 10) / 10;

  /**
   * Sets the ticked items aside.
   *
   * Takes a list because the complaint was a list: eleven order minimums, fourteen rebate ladders
   * and eighteen price files, mostly the same three questions about the same wholesalers. A control
   * that made him answer forty-five times would be answering the letter of what he asked and none
   * of it.
   */
  async function setAside(fd: FormData) {
    "use server";
    const u = await requireManager();
    const keys = fd.getAll("pick").map(String).filter(Boolean);
    const reason = String(fd.get("reason") ?? "");
    if (keys.length === 0) {
      redirect("/settings/setup?ok=" + encodeURIComponent("Nothing was ticked, so nothing changed."));
    }
    const { dismiss } = await import("@/lib/setup-dismissals");
    const { set } = await dismiss(keys, reason, u);
    revalidatePath("/settings/setup");
    revalidatePath("/");
    redirect(
      "/settings/setup?ok=" +
        encodeURIComponent(
          `${set} item${set === 1 ? "" : "s"} set aside. ${set === 1 ? "It is" : "They are"} at the bottom of this page and can be put back at any time.`,
        ),
    );
  }

  /** Puts them back. The undo half, without which the above should not have been built. */
  async function putBack(fd: FormData) {
    "use server";
    const u = await requireManager();
    const keys = fd.getAll("key").map(String).filter(Boolean);
    const { restore } = await import("@/lib/setup-dismissals");
    const { restored } = await restore(keys, u);
    revalidatePath("/settings/setup");
    revalidatePath("/");
    redirect(
      "/settings/setup?ok=" + encodeURIComponent(`${restored} item${restored === 1 ? "" : "s"} back on the list.`),
    );
  }

  return (
    <>
      <PageHeader
        title="Finish setting up"
        subtitle="Everything the site still needs from you, in the order that costs the most to leave undone. Nothing here is ticked by hand: an item is done because the site can see it is done."
        actions={<Link href="/" className="btn">Today</Link>}
      />

      {ok && <Notice kind="ok">{ok}</Notice>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          size="sm"
          value={`${Math.round(progress * 100)}%`}
          label="Set up"
          sub={`${done.length} of ${done.length + left.length + notApplicable.length} done${notApplicable.length ? `, ${notApplicable.length} set aside` : ""}`}
          tone={progress >= 1 ? "ok" : "muted"}
        />
        <Figure size="sm" value={stops} label="Things something waits on" sub={stops ? "a figure is wrong or missing until each is done" : "nothing is blocked"} tone={stops ? "crit" : "ok"} />
        <Figure size="sm" value={left.length - stops} label="Things that would sharpen a figure" sub="works today, but on an estimate" tone={left.length - stops > 0 ? "warn" : "ok"} />
        <Figure size="sm" value={hours < 1 ? `${minutesLeft} min` : `${hours} hr`} label="To do it all" sub="at a rough minute a field" tone="muted" />
      </div>

      {left.length === 0 ? (
        <Notice kind="ok">
          <b>Everything the site can check is in place.</b> It has every feed, every figure and every document it knows how to ask for. What is left is the work itself.
        </Notice>
      ) : (
        <form action={setAside}>
          <Card
            className="my-4"
            title="What is left"
            count={`${left.length} · ${hours < 1 ? `${minutesLeft} min` : `${hours} hr`}`}
            subtitle="Quickest first inside each rank, so ten spare minutes are always worth spending."
          >
            <ol className="-my-1">
              {left.map((i) => (
                <Row key={i.key} item={i} canManage={canManage} />
              ))}
            </ol>

            {/*
              The third answer, at the bottom of the list it applies to.

              Not a button per row: the complaint was forty-five rows, and a remedy that costs one
              press each is the same complaint with extra steps. Tick what does not apply, say why
              once, and they go together.
            */}
            {canManage && (
              <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-line bg-ground p-2">
                <label className="text-xs text-ink-2">
                  <span className="block">Why they do not apply (optional, kept with them)</span>
                  <input
                    name="reason"
                    className="field mt-1 w-72 py-1 text-xs"
                    placeholder="we do not buy from them"
                  />
                </label>
                <button className="btn btn-sm">These do not apply to us</button>
                <span className="text-[11px] text-ink-3">
                  Tick anything above that is not relevant. It leaves the list, keeps its reason, and can be put back
                  whenever you like — nothing is deleted and nothing is marked done.
                </span>
              </div>
            )}
          </Card>
        </form>
      )}

      {/*
        Shown, never hidden.

        An item set aside is a decision, and a decision nobody can see is one nobody can revisit.
        It sits behind its own count with the reason it was given and the press that undoes it.
      */}
      {notApplicable.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-semibold">
            {notApplicable.length} set aside as not applicable
          </summary>
          <ul className="mt-2 space-y-1 text-sm text-ink-2">
            {notApplicable.map((i) => (
              <li key={i.key} className="flex flex-wrap items-baseline gap-2 border-b border-line py-1.5 last:border-b-0">
                <span className="badge badge-muted">not applicable</span>
                <span className="font-medium text-ink">{i.title}</span>
                {i.notApplicable?.reason && <span className="text-xs text-ink-2">&ldquo;{i.notApplicable.reason}&rdquo;</span>}
                <span className="text-xs text-ink-3">
                  {i.notApplicable?.by ? `${i.notApplicable.by}` : ""}
                </span>
                {canManage && (
                  <form action={putBack} className="ml-auto">
                    <input type="hidden" name="key" value={i.key} />
                    <button className="btn btn-sm">Put it back</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {canManage && notApplicable.length > 1 && (
            <form action={putBack} className="mt-2">
              {notApplicable.map((i) => (
                <input key={i.key} type="hidden" name="key" value={i.key} />
              ))}
              <button className="btn btn-sm">Put all {notApplicable.length} back on the list</button>
            </form>
          )}
        </details>
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
