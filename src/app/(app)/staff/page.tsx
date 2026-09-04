import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { daysUntil, fmt } from "@/lib/dates";
import { CREDENTIAL_LABEL, PERSON_ROLE_LABEL } from "@/lib/labels";
import { PageHeader, Empty, StatusBadge, Notice } from "@/components/ui";
import { endEmploymentAction, reinstateAction } from "./actions";
import { todayIso } from "@/lib/dates";
import { trainingsFor } from "@/lib/onboarding";
import { TRAINING_CADENCE, addMonths } from "@/lib/due";
import { staffMatrix } from "@/lib/staff-matrix";
import { StaffBoard } from "@/components/staff-board";

export const metadata = { title: "Staff & licenses" };

export default async function StaffPage({ searchParams }: { searchParams: Promise<{ all?: string; saved?: string; error?: string }> }) {
  const user = await requireUser();
  const { all, saved, error } = await searchParams;
  const people = await db.query.people.findMany({ orderBy: (p, { asc }) => [asc(p.lastName), asc(p.firstName)] });
  const creds = await db.query.credentials.findMany();
  const matrix = await staffMatrix();
  /*
   * Training belongs on the list of people, not only inside each person.
   *
   * The pharmacist-in-charge asked whether the policy-and-procedure acknowledgement needed adding
   * to the staff list. It was already tracked — a training, in the new-hire pack, on the
   * dashboard grid, renewing every year — but it was not visible here, and a thing you cannot see
   * from the screen you are on is a thing you assume does not exist.
   */
  const trainings = await db.query.trainings.findMany();
  const shown = people.filter((p) => (all ? true : p.active) && (user.role === "staff" ? p.id === user.personId : true));
  const canManage = user.role !== "staff";
  const former = people.filter((p) => !p.active).length;

  return (
    <>
      <PageHeader
        title="Staff & licenses"
        subtitle="Every licensee and registrant, their credentials, and when each expires."
        actions={
          <>
            <Link href="/staff/rotations" className="btn">Rotations</Link>
            <Link href="/staff/technician-list" className="btn">Technician list (C-900)</Link>
            {canManage && <Link href="/staff/new" className="btn btn-primary">Add staff member</Link>}
          </>
        }
      />
      {saved && <Notice kind="ok">{saved}</Notice>}
      {error && <Notice kind="crit">{error}</Notice>}

      {/*
        Is my staff covered, on the page about staff.

        It used to sit on the dashboard directly beneath a list that had already named every one of
        the same gaps, which is two renderings of the same forty-two things on one screen. Here it
        is the summary of the list underneath it rather than a duplicate of something else.
      */}
      <StaffBoard m={matrix} back="/staff" />

      {shown.length === 0 ? (
        <Empty>No staff yet. {canManage && <Link href="/staff/new" className="text-accent underline">Add the first person.</Link>}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Credentials</th>
                <th>Training</th>
                <th>Next expiration</th>
                {canManage && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const pc = creds.filter((c) => c.personId === p.id);
                const withDates = pc.filter((c) => c.expiresOn).sort((a, b) => a.expiresOn!.localeCompare(b.expiresOn!));
                const next = withDates[0];

                const owed = trainingsFor({ administersVaccines: p.administersVaccines });
                const mine = trainings.filter((t) => t.personId === p.id);
                const today = todayIso();
                const done = owed.filter((type) => {
                  const last = mine
                    .filter((t) => t.type === type)
                    .sort((a, b) => b.completedOn.localeCompare(a.completedOn))[0];
                  if (!last) return false;
                  const cadence = TRAINING_CADENCE[type];
                  const expires = last.expiresOn ?? (cadence ? addMonths(last.completedOn, cadence.months) : null);
                  return !expires || expires >= today;
                });
                const manual = mine
                  .filter((t) => t.type === "policy_manual_acknowledgement")
                  .sort((a, b) => b.completedOn.localeCompare(a.completedOn))[0];

                return (
                  <tr key={p.id} className={p.active ? "" : "opacity-60"}>
                    <td>
                      <Link href={`/staff/${p.id}`} className="font-medium text-accent hover:underline">{p.lastName}, {p.firstName}</Link>
                      <div className="text-xs text-ink-3">
                        {p.isPic && <span className="badge badge-ok mr-1">PIC</span>}
                        {p.administersVaccines && <span className="badge badge-muted mr-1">vaccinator</span>}
                        {!p.active && <span className="badge badge-muted">inactive since {fmt(p.endedOn)}</span>}
                        {p.title}
                      </div>
                    </td>
                    <td>{PERSON_ROLE_LABEL[p.role]}</td>
                    <td className="text-xs text-ink-2">
                      {pc.length === 0 ? <span className="text-crit">none on file</span> : pc.map((c) => <div key={c.id}>{c.type === "other" && c.label ? c.label : CREDENTIAL_LABEL[c.type]}{c.number ? ` · ${c.number}` : ""}</div>)}
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {/*
                        The manual acknowledgement is named rather than counted, because it is the
                        one an inspector asks for by name and the one the manual itself promises
                        every employee has signed.
                      */}
                      <Link
                        href={`/staff/${p.id}#training`}
                        className={done.length === owed.length ? "text-ink-2 hover:underline" : "text-crit hover:underline"}
                      >
                        {done.length} of {owed.length} current
                      </Link>
                      <div className="mt-0.5 text-ink-3">
                        P&amp;P manual:{" "}
                        {manual ? (
                          <span>signed {fmt(manual.completedOn)}</span>
                        ) : (
                          <span className="text-crit">never signed</span>
                        )}
                      </div>
                    </td>
                    <td>
                      {next ? (
                        <div className="flex items-center gap-2">
                          <StatusBadge days={daysUntil(next.expiresOn)} />
                          <span className="text-xs text-ink-2">{fmt(next.expiresOn)} · {CREDENTIAL_LABEL[next.type]}</span>
                        </div>
                      ) : (
                        <span className="text-xs text-ink-3">—</span>
                      )}
                    </td>
                    {canManage && (
                      <td>
                        {/*
                          One click, from the list somebody is already looking at.
                          
                          This existed only as a collapsed section at the foot of each person's own
                          page, under the words "record that they have left" — so a pharmacist
                          looking for how to make somebody inactive found nothing, because that is
                          not what it was called and not where it was.
                        */}
                        {/*
                          Printing the protocol from the list, because that is where somebody
                          looking for it starts. It was on the person's own page only, and gated on
                          the immunizer checkbox — so for anyone whose record did not already say
                          immunizer, it did not exist anywhere.
                        */}
                        <Link href={`/staff/${p.id}/protocol`} className="text-xs text-accent hover:underline">
                          Protocol
                        </Link>
                        {p.active ? (
                          <form action={endEmploymentAction}>
                            <input type="hidden" name="personId" value={p.id} />
                            <input type="hidden" name="endedOn" value={todayIso()} />
                            <input type="hidden" name="back" value="/staff" />
                            <button
                              className="text-xs text-ink-3 hover:text-crit hover:underline"
                              title="Keeps the whole file; stops them owing training and stops the emails."
                            >
                              Make inactive
                            </button>
                          </form>
                        ) : (
                          <form action={reinstateAction}>
                            <input type="hidden" name="personId" value={p.id} />
                            <input type="hidden" name="back" value="/staff" />
                            <button className="btn btn-sm btn-primary" title="They are back — training and licences start counting again.">
                              Reactivate
                            </button>
                          </form>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-sm text-ink-2">
        {all ? (
          <Link href="/staff" className="btn btn-sm">Hide inactive staff</Link>
        ) : (
          <Link href="/staff?all=1" className="btn btn-sm">
            Show inactive staff{former > 0 ? ` (${former})` : ""}
          </Link>
        )}
      </p>
      <p className="mt-2 text-xs text-ink-3">
        Making somebody inactive deletes nothing. Their licences, training records, certificates and signed
        attestations stay on their page and stay searchable for as long as the retention rules require — what changes
        is that they stop counting as staff who owe training and the site stops emailing them. Reactivating puts them
        straight back; check their dates afterwards, because some will have lapsed while they were away.
      </p>
    </>
  );
}
