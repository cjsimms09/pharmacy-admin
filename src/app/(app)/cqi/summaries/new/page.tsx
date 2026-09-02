import { requireManager } from "@/lib/auth";
import { cqiPeriods, fmt, nextCqiPeriod, todayIso } from "@/lib/dates";
import { PageHeader, BackLink, Notice, Field } from "@/components/ui";
import { createSummary } from "../../actions";

export const metadata = { title: "New CQI summary" };

export default async function NewSummaryPage({ searchParams }: { searchParams: Promise<{ due?: string; error?: string }> }) {
  await requireManager();
  const { due, error } = await searchParams;
  const today = todayIso();
  const y = Number(today.slice(0, 4));
  const options = cqiPeriods(y - 1, y).filter((p) => p.periodEnd <= today).reverse();
  const def = due ?? nextCqiPeriod(today).dueOn;
  return (
    <>
      <BackLink href="/cqi">CQI program</BackLink>
      <PageHeader title="Start a bimonthly summary" subtitle="The draft pulls in every incident whose report was created in the two-month period, and lists corrective action plans due for their first or second effectiveness review." />
      {error && <Notice kind="crit">{error}</Notice>}
      <form action={createSummary} className="card max-w-lg space-y-4">
        <Field label="Summary period">
          <select name="dueOn" className="field" defaultValue={def}>
            {options.map((p) => <option key={p.dueOn} value={p.dueOn}>{p.label} — due {fmt(p.dueOn)}</option>)}
          </select>
        </Field>
        <button className="btn btn-primary">Create draft</button>
      </form>
    </>
  );
}
