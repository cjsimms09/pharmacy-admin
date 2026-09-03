import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { rotations, rotationRequirements, type RotationRow } from "@/lib/roster";
import { fmt } from "@/lib/dates";
import { PageHeader, Card, Figure, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rotations" };

/**
 * Students on rotation.
 *
 * They are the hardest people in a pharmacy to keep records on, because everything about them is
 * temporary except the obligation to have kept the records. A student works five weeks, leaves,
 * and two years later somebody asks who was on the bench the day a prescription went wrong. If
 * they were tracked as staff the dashboard chased them for annual training forever; if they were
 * marked inactive on their last day the fact that they were ever here quietly disappeared.
 *
 * So a rotation is a window. Inside it they count exactly like anyone else — the same board, the
 * same training, the same chasing. Outside it they count for nothing and their file stays put.
 */
export default async function RotationsPage() {
  await requireUser();
  const rows = await rotations();
  const here = rows.filter((r) => r.presence === "here");
  const arriving = rows.filter((r) => r.presence === "arriving");
  const past = rows.filter((r) => r.presence === "finished" || r.presence === "left");
  const notReady = here.filter((r) => !r.ready).length;

  return (
    <>
      <PageHeader
        back={{ href: "/staff", label: "Staff" }}
        title="Rotations"
        subtitle="Students and anyone else here for a fixed spell. They are chased while they are on site and their file is kept for good afterwards."
        actions={<Link href="/staff/new" className="btn btn-primary">Add a student</Link>}
      />

      {rows.length === 0 ? (
        <Empty>
          No rotations recorded. <Link href="/staff/new" className="underline">Add someone</Link> and set &ldquo;Here as&rdquo;
          to a rotation with the dates they are on site.
        </Empty>
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Figure value={here.length} label="On site now" tone={here.length > 0 ? "ok" : "muted"} />
            <Figure
              value={notReady}
              label="Not cleared to work"
              sub={notReady === 0 ? "Everyone here has what they need" : "Something is missing from their file"}
              tone={notReady === 0 ? "ok" : "crit"}
            />
            <Figure value={arriving.length} label="Arriving" sub="Get their paperwork before day one" tone={arriving.length > 0 ? "warn" : "ok"} />
            <Figure value={past.length} label="Finished" sub="Records kept and searchable" tone="muted" />
          </div>

          {here.length > 0 && <Group title="On site now" rows={here} />}
          {arriving.length > 0 && <Group title="Arriving" rows={arriving} />}
          {past.length > 0 && <Group title="Finished" rows={past} muted />}
        </>
      )}

      <Card title="What a student has to have on file" className="mt-6">
        <p className="card-sub">
          Taken from the affiliation agreement, not guessed at. The school arranges nearly all of it and then tells the
          student to produce it &ldquo;upon request&rdquo; — which means this pharmacy holds none of it unless it asks,
          every time, for every student.
        </p>
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>What</th><th>Why</th><th>Whose job</th></tr></thead>
            <tbody>
              {rotationRequirements().map((r) => (
                <tr key={r.key}>
                  <td className="font-medium">{r.label}</td>
                  <td className="text-xs text-ink-2">{r.why}</td>
                  <td>
                    <span className={`badge ${r.from === "pharmacy" ? "badge-warn" : "badge-muted"}`}>
                      {r.from === "pharmacy" ? "ours to deliver" : r.from === "school" ? "the school" : "the student"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function Group({ title, rows, muted }: { title: string; rows: RotationRow[]; muted?: boolean }) {
  return (
    <Card title={title} count={rows.length} className="mb-6">
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr><th>Student</th><th>From</th><th>On site</th><th>Cleared</th><th>Outstanding</th></tr>
          </thead>
          <tbody className={muted ? "opacity-70" : ""}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">
                  <Link href={`/staff/${r.id}`} className="font-medium text-accent hover:underline">{r.name}</Link>
                </td>
                <td className="text-xs text-ink-2">{r.affiliation ?? "—"}</td>
                <td className="whitespace-nowrap text-xs">
                  {r.startsOn ? fmt(r.startsOn) : "—"} to {r.endsOn ? fmt(r.endsOn) : "—"}
                  {r.presence === "here" && r.daysLeft !== null && (
                    <div className="text-ink-3">{r.daysLeft} day{r.daysLeft === 1 ? "" : "s"} left</div>
                  )}
                  {r.presence === "arriving" && r.daysUntilStart !== null && (
                    <div className="text-warn">starts in {r.daysUntilStart} day{r.daysUntilStart === 1 ? "" : "s"}</div>
                  )}
                </td>
                <td>
                  {r.ready ? (
                    <span className="badge badge-ok">cleared</span>
                  ) : (
                    <span className="badge badge-crit">{r.missing.length} missing</span>
                  )}
                </td>
                <td className="text-xs">
                  {r.ready ? (
                    <span className="text-ink-3">nothing</span>
                  ) : (
                    <>
                      {r.toAskFor.length > 0 && (
                        <div>
                          <b>Ask them for:</b> {r.toAskFor.join(", ")}
                        </div>
                      )}
                      {r.oursToDo.length > 0 && (
                        <div className="mt-1 text-warn">
                          <b>Ours to deliver:</b> {r.oursToDo.join(", ")}{" "}
                          <Link href="/compliance/training" className="underline">send it</Link>
                        </div>
                      )}
                    </>
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
