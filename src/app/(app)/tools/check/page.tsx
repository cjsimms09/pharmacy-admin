import Link from "next/link";
import { requireManager } from "@/lib/auth";
import { dailyCheck } from "@/lib/daily-check-store";
import { getSettings } from "@/lib/settings";
import { PageHeader, Card, Notice } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "The morning check" };

/**
 * What the site checks about itself every morning, and what each answer means.
 *
 * One page, one table, no controls. The dashboard shows only the failures and only when there are
 * any; this is where the whole list lives, so that "all clear" is somewhere a person can go and
 * read rather than something they have to be told every day on a page that is already too busy.
 *
 * Each row prints the rule before the reading. That order matters: the rule is what makes the
 * number mean something, and a number without one is the thing this whole page exists to replace.
 */
export default async function CheckPage() {
  await requireManager();
  const [r, settings] = await Promise.all([dailyCheck(), getSettings()]);
  const last = settings.daily_check_result ?? null;

  return (
    <>
      <PageHeader
        title="The morning check"
        subtitle="What has to be true about this site's own data, checked every day. Read now, not from a stored result."
        actions={<Link href="/" className="btn">Today</Link>}
      />

      {r.failing === 0 ? (
        <Notice kind="ok">
          All {r.checks.length} checks pass. Nothing below needs you.
        </Notice>
      ) : (
        <Notice kind="warn">
          {r.failing} of {r.checks.length} failing. Each one says what it expected and what it found.
        </Notice>
      )}

      <div className="mt-4 space-y-3">
        {[...r.checks].sort((a, b) => Number(a.ok) - Number(b.ok)).map((c) => (
          <Card
            key={c.what}
            tone={c.ok ? undefined : c.kind === "money" ? "crit" : "warn"}
            title={c.what}
          >
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]">
              <dt className="text-xs uppercase tracking-wide text-ink-3">Should be</dt>
              <dd className="text-ink-2">{c.shouldBe}</dd>
              <dt className="text-xs uppercase tracking-wide text-ink-3">Is</dt>
              <dd className={c.ok ? "text-ink-1" : "font-medium"}>{c.observed}</dd>
              {c.difference && (
                <>
                  <dt className="text-xs uppercase tracking-wide text-ink-3">Difference</dt>
                  <dd className="text-ink-1">{c.difference}</dd>
                </>
              )}
            </dl>
          </Card>
        ))}
      </div>

      {last && <p className="mt-4 text-xs text-ink-3">Last recorded by the nightly pass — {last}</p>}
    </>
  );
}
