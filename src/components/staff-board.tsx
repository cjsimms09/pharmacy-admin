import Link from "next/link";
import { PERSON_ROLE_LABEL } from "@/lib/labels";
import { sendTrainingAction } from "@/app/(app)/_actions/compliance";
import { Card } from "@/components/ui";
import type { StaffMatrix, MatrixRow, Cell } from "@/lib/staff-matrix";

/**
 * Is my staff covered — as a board somebody would be willing to show an inspector.
 *
 * The previous version answered the question and looked like a spreadsheet with buttons glued
 * into it. Every one of five people by eleven requirements carried a status badge *and* its own
 * send button: fifty-five controls, in cells an inch wide, running off the right-hand edge of the
 * screen. It was reported, accurately, as amateur.
 *
 * The cause was a good instinct taken one step too far. Acting from the cell that shows the gap is
 * right — being sent to another screen is where the work stops happening — but the unit of action
 * was wrong. Nobody sends one person one course: they chase a person for everything that person
 * owes, and the site already sends exactly that, as one email covering the lot. So the grid
 * reports, one button per row acts, and fifty-five controls become five.
 *
 * What that buys is not only tidiness. A cell is now the same size as every other cell, so the
 * eye reads down a column and finds the gap; the row height is constant, so five people fit on a
 * screen instead of two; and the button that remains says how many things it is chasing, which is
 * the number the pharmacist-in-charge actually cares about.
 */
export function StaffBoard({ m, back = "/staff" }: { m: StaffMatrix; back?: string }) {
  if (m.rows.length === 0) {
    return (
      <Card id="staff" title="Staff compliance" className="mb-6">
        <p className="text-sm text-ink-3">
          No active staff yet. <Link href="/staff/new-hire" className="text-accent underline">Add the first person</Link>{" "}
          and this becomes the board you show an inspector.
        </p>
      </Card>
    );
  }

  return (
    <Card
      id="staff"
      title="Staff compliance"
      actions={
        <>
          <Link href="/compliance/training" className="btn btn-sm btn-primary">Send training</Link>
          <Link href="/staff/new-hire" className="btn btn-sm">New employee</Link>
        </>
      }
      subtitle={
        m.gaps === 0
          ? `All ${m.rows.length} active staff are covered on every requirement.`
          : `${m.gaps} gap${m.gaps === 1 ? "" : "s"} across ${m.rows.length - m.covered} of ${m.rows.length} people. A gap is nothing on file, or lapsed — not merely approaching its date.`
      }
      className="mb-6"
    >
      <div className="-mx-5 overflow-x-auto px-5">
        <table className="w-full min-w-[52rem] border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-ink-3">
              <th className="sticky left-0 z-10 border-b border-line bg-surface py-2 pr-3 font-semibold shadow-[6px_0_6px_-6px_rgba(27,42,42,.10)]">
                Person
              </th>
              {m.columns.map((c) => (
                <th key={c.key} className="whitespace-nowrap border-b border-line px-2 py-2 text-center font-semibold" title={c.label}>
                  {c.short}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.rows.map((r: MatrixRow) => (
              <tr key={r.id} className="group">
                {/*
                  The name, what they owe, and the button that chases it — all in the pinned column.

                  The action used to be the last column, which on eleven requirements is off the
                  right-hand edge of the screen: the one control on the board you actually press was
                  the one you had to scroll to find. It travels with the name now, so it is reachable
                  wherever the grid has been scrolled to.
                */}
                <td className="sticky left-0 z-10 whitespace-nowrap border-b border-line bg-surface py-2.5 pr-4 align-middle shadow-[6px_0_6px_-6px_rgba(27,42,42,.10)]">
                  <div className="flex items-center gap-2.5">
                    <span className="min-w-0">
                      <Link href={`/staff/${r.id}`} className="text-sm font-medium text-accent hover:underline">
                        {r.name}
                      </Link>
                      <span className="block text-[11px] text-ink-3">
                        {PERSON_ROLE_LABEL[r.role as keyof typeof PERSON_ROLE_LABEL] ?? r.role}
                        {r.isPic ? " · PIC" : ""}
                      </span>
                    </span>
                    {r.gaps === 0 ? (
                      <span className="badge badge-ok shrink-0">clear</span>
                    ) : (
                      <form action={sendTrainingAction} className="ml-auto flex shrink-0 items-center gap-1.5">
                        <input type="hidden" name="personId" value={r.id} />
                        <input type="hidden" name="trainingType" value="" />
                        <input type="hidden" name="followUp" value="1" />
                        <input type="hidden" name="back" value={back} />
                        <span className="badge badge-crit" title={`${r.gaps} outstanding`}>{r.gaps}</span>
                        <button className="btn btn-sm">Chase</button>
                      </form>
                    )}
                  </div>
                </td>

                {m.columns.map((c) => (
                  <td key={c.key} className="border-b border-line px-2 py-2.5 text-center align-middle">
                    <CellMark cell={r.cells[c.key]} />
                  </td>
                ))}

              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        A legend rather than a paragraph.
        
        The four states are the whole of how to read the board, and they were buried in the fifth
        sentence of a note underneath it.
      */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] text-ink-3">
        <span className="inline-flex items-center gap-1.5"><span className="badge badge-ok">date</span> on file and current</span>
        <span className="inline-flex items-center gap-1.5"><span className="badge badge-warn">date</span> within 30 days</span>
        <span className="inline-flex items-center gap-1.5"><span className="badge badge-crit">none</span> missing or lapsed</span>
        <span className="inline-flex items-center gap-1.5"><span className="text-ink-3">—</span> does not apply</span>
      </div>
      <p className="mt-2 text-[11px] text-ink-3">
        Scrolls sideways; the name, what each person owes and the button that chases it all stay put. A badge with something behind it opens the evidence — the certificate, or
        the record a credential was read from — because &ldquo;it says they did it&rdquo; and &ldquo;here is the
        certificate&rdquo; are different claims, and only the second is worth anything with an inspector in the room.
      </p>
    </Card>
  );
}

/**
 * One cell: a status, and nothing else.
 *
 * It carried a button, a sent-date, a reminder count and a follow-up control. In a column an inch
 * wide, repeated fifty-five times, that is not a board — it is a form pretending to be one. The
 * cell's job is to be scannable down a column; the acting happens once per row.
 */
function CellMark({ cell }: { cell: Cell }) {
  if (!cell || cell.state === "na") {
    return <span className="text-ink-3" title={cell?.title}>—</span>;
  }
  const cls =
    cell.state === "missing" || cell.state === "late" ? "badge-crit" : cell.state === "soon" ? "badge-warn" : "badge-ok";

  return cell.href ? (
    <Link href={cell.href} className={`badge ${cls} hover:underline`} title={cell.title}>
      {cell.label}
    </Link>
  ) : (
    <span className={`badge ${cls}`} title={cell.title}>{cell.label}</span>
  );
}
