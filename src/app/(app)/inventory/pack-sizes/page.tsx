import { revalidatePath } from "next/cache";
import { requireUser, requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fmt } from "@/lib/dates";
import { reasonWords } from "@/lib/pack-fixes";
import { packQuestions, packFixSummary, applyFdaCorrections, settlePack, unsettlePack } from "@/lib/pack-fixes-store";
import { PageHeader, Card, Figure, Notice, Empty } from "@/components/ui";

/**
 * Settling what a package holds, where the FDA cannot settle it alone.
 *
 * The owner: "We need to fix correctly all the package sizes that we can. For those we can't, I
 * need a way to lookup and correct. These corrections need to stick."
 *
 * A pack size is a divisor — every per-unit cost is the pack cost over the units in the pack — so
 * this page is not housekeeping. A package wrong by a factor of six makes a drug look six times
 * cheaper than it is and the buy list recommends it.
 *
 * The design point is the money column. Nobody can be asked which of two numbers is the better
 * description of a box; everybody can answer "this costs $2.41 a tablet under one reading and
 * $0.40 under the other, and I know which one I pay". So every reading is priced, and the
 * pharmacist decides against a figure he recognises rather than against an abstraction.
 */

export const dynamic = "force-dynamic";

const money = (cents: number | null) =>
  cents === null ? "—" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A per-unit cost is fractions of a cent on a tablet, so it needs more places than money does. */
const perUnit = (micros: number | null) =>
  micros === null ? "—" : `$${(micros / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;

export default async function PackSizesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; settled?: string }>;
}) {
  const sp = await searchParams;
  const user = await requireUser();
  const canFix = user.role !== "staff";
  const showSettled = sp.settled === "1";

  async function runFda() {
    "use server";
    const u = await requireManager();
    const r = await applyFdaCorrections(u);
    await audit({
      action: "pack-size.fda-pass",
      userId: u.id,
      userName: u.name,
      details: `${r.corrected} corrected, ${r.alreadyRight} already right, ${r.needsPerson} need a person, ${r.settledByPerson} already settled by hand`,
    });
    revalidatePath("/inventory/pack-sizes");
  }

  async function settle(fd: FormData) {
    "use server";
    const u = await requireManager();
    const ndc11 = String(fd.get("ndc11") ?? "");
    const packSize = String(fd.get("packSize") ?? "");
    const note = String(fd.get("note") ?? "");
    await settlePack(ndc11, { packSize, note }, u);
    await audit({
      action: "pack-size.settled",
      userId: u.id,
      userName: u.name,
      entity: "ndc",
      entityId: ndc11,
      details: `${ndc11} settled at ${packSize}${note ? ` — ${note}` : ""}`,
    });
    revalidatePath("/inventory/pack-sizes");
  }

  async function undo(fd: FormData) {
    "use server";
    const u = await requireManager();
    const ndc11 = String(fd.get("ndc11") ?? "");
    await unsettlePack(ndc11);
    await audit({ action: "pack-size.unsettled", userId: u.id, userName: u.name, entity: "ndc", entityId: ndc11, details: ndc11 });
    revalidatePath("/inventory/pack-sizes");
  }

  const [summary, { questions, total }] = await Promise.all([
    packFixSummary(),
    packQuestions({ text: sp.q, includeSettled: showSettled, limit: 100 }),
  ]);

  return (
    <>
      <PageHeader
        title="Pack sizes"
        subtitle="What a package actually holds, where the wholesalers and the FDA do not agree."
        help={
          <>
            <p>
              A pack size is a divisor. Every per-unit cost on this site is the pack cost over the units in the pack, so
              a package recorded wrong by a factor of six makes a drug look six times cheaper than it is — and the buy
              list recommends it on that basis.
            </p>
            <p>
              The FDA&rsquo;s package file settles most of it on its own, and the button below writes those. It is
              deliberately narrow: it acts only where both sides count the same kind of unit and one is a whole number of
              the other, which is the case where a wholesaler quoted an inner pack. It never touches a package you have
              settled yourself, and it refuses the two cases that have already gone wrong here — a box of patches the
              FDA describes in hours, and an inhaler it counts in actuations where every wholesaler prices the grams.
            </p>
            <p>
              What is left is on this page because arithmetic cannot decide it. You have the bottle and the file does
              not, so your answer outranks everything and sticks — through every future import, for every supplier,
              including ones the pharmacy has never bought from.
            </p>
          </>
        }
        actions={
          canFix ? (
            <form action={runFda}>
              <button className="btn" type="submit">Apply what the FDA settles</button>
            </form>
          ) : undefined
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Figure value={summary.settledByPerson.toLocaleString("en-US")} label="Settled by the pharmacy" sub="Your answer, on every import" />
        <Figure value={summary.settledByFda.toLocaleString("en-US")} label="Settled from the FDA file" sub="Whole-factor corrections" />
        <Figure
          value={summary.needsPerson.toLocaleString("en-US")}
          label="Need a person"
          sub={summary.needsPerson ? "Arithmetic cannot decide these" : "Nothing outstanding"}
          tone={summary.needsPerson ? "warn" : "ok"}
        />
      </div>

      {/*
        The two counts differ and the difference is not an error, so it is said rather than left to
        be discovered: the figure the button reports is what that run judged, and this one is every
        open question including packages the run never reached.
      */}
      <p className="mb-4 text-xs text-ink-3">
        &ldquo;Need a person&rdquo; counts every open question in the catalogue. The number reported after a run counts
        only the packages that run judged, so the two differ and neither is wrong. The list below is ordered by what the
        pharmacy actually dispenses, then by what it spends — a package somebody has held can be settled from memory,
        and one nobody has bought can wait.
      </p>

      <Card className="mb-4" title="Find a package">
        <form className="flex flex-wrap items-end gap-2">
          <label className="grow">
            <span className="mb-1 block text-xs text-ink-3">NDC or drug name</span>
            <input name="q" defaultValue={sp.q ?? ""} className="field" placeholder="00093007301, or omeprazole" />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="settled" value="1" defaultChecked={showSettled} />
            Include ones already settled
          </label>
          <button className="btn" type="submit">Search</button>
        </form>
      </Card>

      {questions.length === 0 ? (
        <Empty>
          {sp.q
            ? "No package matches that, among the ones needing a decision."
            : "Every package the catalogue carries is either agreed with the FDA or settled. Nothing is waiting."}
        </Empty>
      ) : (
        <>
          {total > questions.length && (
            <Notice kind="warn">
              Showing {questions.length} of {total.toLocaleString("en-US")}. Search by NDC or name to reach a particular
              one; the list leads with unit disagreements, which are the ones a per-unit cost gets most wrong.
            </Notice>
          )}
          {questions.map((q) => (
            <Card
              key={q.ndc11}
              className="mb-4"
              tone={q.settled ? "ok" : q.reason === "unit-differs" ? "crit" : "warn"}
              title={q.description ?? q.ndc11}
              subtitle={
                `${q.ndc11} · ${reasonWords(q.reason)}` +
                // Why this one is near the top: the queue is ordered by what the pharmacy actually
                // deals in, so the reason it is in front of somebody has to be visible.
                (q.fills > 0 ? ` · ${q.fills} fill${q.fills === 1 ? "" : "s"} dispensed` : "") +
                (q.spentCents > 0 ? ` · ${money(q.spentCents)} bought` : "")
              }
            >
              <p className="mb-3 text-xs text-ink-2">{q.why}</p>

              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Reading</th>
                      <th className="whitespace-nowrap">Pack size</th>
                      <th className="whitespace-nowrap">Pack cost</th>
                      <th className="whitespace-nowrap">Cost per unit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.suppliers.map((s) => (
                      <tr key={s.supplier}>
                        <td>{s.supplier}</td>
                        <td className="whitespace-nowrap font-mono text-xs">{s.packSize ?? "—"}</td>
                        <td className="whitespace-nowrap tabular-nums">{money(s.packCostCents)}</td>
                        {/* The column the decision is actually made on. */}
                        <td className="whitespace-nowrap tabular-nums">{perUnit(s.unitCostMicros)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td className="align-top">
                        <span className="font-medium">The FDA</span>
                        <p className="mt-1 max-w-[28rem] font-mono text-[11px] leading-relaxed text-ink-3">
                          {q.packageDescription ?? "no package description"}
                        </p>
                      </td>
                      <td className="whitespace-nowrap font-mono text-xs">{q.fdaPackSize ?? "unreadable"}</td>
                      <td className="text-ink-3">—</td>
                      <td className="whitespace-nowrap tabular-nums">{perUnit(q.fdaUnitCostMicros)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {q.settled && (
                <p className="mt-3 text-xs text-ink-2">
                  Settled at <span className="font-mono">{q.settled.packSize}</span> by {q.settled.by} on{" "}
                  {fmt(q.settled.at)}
                  {q.settled.note ? ` — ${q.settled.note}` : ""}.
                </p>
              )}

              {canFix && (
                <form action={settle} className="mt-3 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="ndc11" value={q.ndc11} />
                  <label>
                    <span className="mb-1 block text-xs text-ink-3">What the package holds</span>
                    <input
                      name="packSize"
                      className="field font-mono"
                      defaultValue={q.settled?.packSize ?? q.fdaPackSize ?? q.suppliers[0]?.packSize ?? ""}
                      placeholder="180 EA"
                      required
                    />
                  </label>
                  <label className="grow">
                    {/* Asked for every time, because a correction with no reason is
                        indistinguishable next year from a typing mistake. */}
                    <span className="mb-1 block text-xs text-ink-3">What you checked it against</span>
                    <input name="note" className="field" placeholder="Counted off the bottle, 12 Sept" defaultValue="" />
                  </label>
                  <button className="btn btn-primary" type="submit">Settle it</button>
                  {q.settled && (
                    // formNoValidate because "What the package holds" is required for settling and
                    // meaningless for undoing — without it the browser blocks the undo on an empty
                    // field and the button silently does nothing.
                    <button className="btn" type="submit" formAction={undo} formNoValidate>
                      Undo
                    </button>
                  )}
                </form>
              )}
            </Card>
          ))}
        </>
      )}
    </>
  );
}
