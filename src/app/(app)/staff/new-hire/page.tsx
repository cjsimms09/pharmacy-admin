import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { newHirePack, openPacks, startedOn } from "@/lib/onboarding";
import { assignTraining, sendOutstanding } from "@/lib/training-assignments";
import { fmt } from "@/lib/dates";
import { PageHeader, Card, Figure, Notice, Empty, BackLink } from "@/components/ui";
import { PersonForm } from "../person-form";
import { createPerson } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "New employee" };

const GROUPS = [
  { key: "identity", title: "Who they are", sub: "Two fields, and everything below can start." },
  { key: "credential", title: "What they bring", sub: "The licence or registration, and the document itself — not just its number." },
  { key: "training", title: "What they complete", sub: "Sent in one email. The reply is the attestation, and the certificate writes itself." },
  { key: "record", title: "What the pharmacy does about them", sub: "Duties that fall on the pharmacy the moment somebody starts." },
] as const;

/**
 * The new employee, start to finish.
 *
 * Hiring somebody triggers about fifteen separate obligations across five screens, and none of
 * them is hard. What is hard is remembering all fifteen on a Tuesday when the phone is going —
 * and a half-finished new starter is invisible for months, until somebody counts the training
 * file and finds five certificates for six people.
 *
 * So it is one page, and it works out what is done from the records rather than from a tick
 * somebody remembered to make. A checklist maintained by hand is just a second thing to forget.
 */
export default async function NewHirePage({
  searchParams,
}: {
  searchParams: Promise<{ person?: string; ok?: string; error?: string }>;
}) {
  await requireManager();
  const { person: personId, ok, error } = await searchParams;
  const pack = personId ? await newHirePack(personId) : null;
  const open = await openPacks();

  async function sendAll(fd: FormData) {
    "use server";
    const u = await requireManager();
    const id = String(fd.get("person") ?? "");
    const p = await newHirePack(id);
    if (!p) redirect("/staff/new-hire?error=" + encodeURIComponent("That person no longer exists."));
    if (!p.person.email) {
      redirect(`/staff/new-hire?person=${id}&error=` + encodeURIComponent("Add an email address first — there is nowhere to send it."));
    }

    const outstanding = p.items.filter((i) => i.group === "training" && !i.done && i.trainingType).map((i) => i.trainingType!);
    if (outstanding.length === 0) {
      redirect(`/staff/new-hire?person=${id}&ok=` + encodeURIComponent("Nothing outstanding — everything has already been completed."));
    }
    for (const type of outstanding) await assignTraining([id], type, { email: false }, u);
    const r = await sendOutstanding([id]);
    await audit({ action: "onboarding.send", userId: u.id, userName: u.name, entity: "person", entityId: id, details: outstanding.join(", ") });
    revalidatePath("/staff/new-hire");
    redirect(
      `/staff/new-hire?person=${id}&${r.problems.length ? "error" : "ok"}=` +
        encodeURIComponent(
          r.problems.length
            ? r.problems.join(" ")
            : `${outstanding.length} trainings accepted for delivery to ${p.person.email} in one email — that is the mail server taking it, not ${p.person.firstName} receiving it. They reply with the code in it, and the certificate is generated and filed here. If it bounces, the report is read automatically and appears against them.`,
        ),
    );
  }

  // ── Nobody chosen: create one, or pick up an unfinished pack ──
  if (!pack) {
    return (
      <>
        <BackLink href="/staff">Staff</BackLink>
        <PageHeader
          title="New employee"
          subtitle="Everything a new starter has to complete, worked out from their role, and tracked until it is done."
          actions={
            /*
              The reading, as one thing to hand somebody.
              
              The courses can each be opened on screen by a person who has been sent a link and
              remembers to follow it, which is fine for an annual refresher and useless on a first
              morning. This is the same material, in order, with a cover and a contents page.
            */
            <Link href="/staff/new-hire/pack" className="btn">Print the training pack</Link>
          }
        />
        {error && <Notice kind="crit">{error}</Notice>}

        {open.length > 0 && (
          <Card title="Started recently, not finished" count={open.length} tone="warn" className="mb-6">
            <ul className="rows">
              {open.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={`/staff/new-hire?person=${p.id}`} className="text-sm font-medium hover:underline">{p.name}</Link>
                  <span className="flex items-center gap-3 text-xs text-ink-3">
                    <span className="capitalize">{p.role}</span>
                    {p.startsOn && <span>started {fmt(p.startsOn)}</span>}
                    <span className="badge badge-warn">{p.done} of {p.total} done</span>
                    <Link href={`/staff/new-hire?person=${p.id}`} className="btn btn-sm">Open</Link>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card title="Add the person" subtitle="Name, role and email. The list of what they owe is worked out from the role, and whether they will be immunizing.">
          <PersonForm action={createPerson} submitLabel="Create and open the checklist" hidden={{ next: "new-hire" }} />
        </Card>
      </>
    );
  }

  // ── One person's pack ──
  const p = pack;
  const pct = Math.round((p.done / p.total) * 100);
  const trainingLeft = p.items.filter((i) => i.group === "training" && !i.done).length;

  return (
    <>
      <BackLink href="/staff/new-hire">New employee</BackLink>
      <PageHeader
        title={`${p.person.firstName} ${p.person.lastName}`}
        subtitle={`${p.person.role[0].toUpperCase()}${p.person.role.slice(1)}${p.person.administersVaccines ? ", immunizer" : ""}${startedOn(p.person) ? ` · started ${fmt(startedOn(p.person))}` : " · no start date recorded"}`}
        actions={
          <>
            <Link href={`/staff/${p.person.id}`} className="btn">Their full record</Link>
            {trainingLeft > 0 && (
              <form action={sendAll}>
                <input type="hidden" name="person" value={p.person.id} />
                <button className="btn btn-primary">Send all {trainingLeft} trainings now</button>
              </form>
            )}
          </>
        }
      />
      {ok && <Notice kind="ok">{ok}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Figure value={`${p.done}/${p.total}`} label="Complete" sub={pct === 100 ? "Nothing outstanding" : `${pct}% of the pack`} tone={pct === 100 ? "ok" : pct > 50 ? "warn" : "crit"} />
        <Figure value={trainingLeft} label="Trainings outstanding" sub={trainingLeft ? "All of them go in one email" : "All returned and certificated"} tone={trainingLeft ? "warn" : "ok"} />
        <Figure
          value={p.daysSinceStart === null ? "—" : `${p.daysSinceStart}d`}
          label="Since they started"
          sub={p.daysSinceStart !== null && p.daysSinceStart > 10 ? "The hepatitis B offer was due within ten working days" : "Ten working days for the hepatitis B offer"}
          tone={p.daysSinceStart !== null && p.daysSinceStart > 10 && !p.items.find((i) => i.key === "hep-b")?.done ? "crit" : "ok"}
        />
      </div>

      {GROUPS.map((g) => {
        const items = p.items.filter((i) => i.group === g.key);
        if (items.length === 0) return null;
        const left = items.filter((i) => !i.done).length;
        return (
          <Card key={g.key} title={g.title} count={`${items.length - left} of ${items.length}`} subtitle={g.sub} tone={left === 0 ? "ok" : undefined} className="mb-4">
            <ul className="rows">
              {items.map((i) => (
                <li key={i.key} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className={i.done ? "text-accent" : "text-ink-3"} aria-hidden>{i.done ? "✓" : "○"}</span>
                      <span className={i.done ? "text-ink-2" : ""}>{i.label}</span>
                    </div>
                    <p className="ml-6 mt-0.5 text-xs leading-snug text-ink-3">{i.why}</p>
                    {i.detail && <p className="ml-6 mt-0.5 text-xs text-ink-2">{i.detail}</p>}
                  </div>
                  {!i.done && i.href && (
                    <Link href={i.href} className="btn btn-sm shrink-0">
                      {i.group === "credential" ? "Record it" : i.group === "training" ? "Training" : "Do it"}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        );
      })}

      {p.done === p.total && (
        <Notice kind="ok">
          Nothing outstanding for {p.person.firstName}. Their certificates are in the{" "}
          <Link href="/compliance/training/records" className="underline">training file</Link>, and their documents are on{" "}
          <Link href={`/staff/${p.person.id}`} className="underline">their record</Link>.
        </Notice>
      )}
    </>
  );
}
