import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { trainingFile } from "@/lib/training-records";
import { fmt, fmtLong } from "@/lib/dates";
import { PrintFrame } from "@/components/print";
import { SignBlock } from "@/components/sign-block";
import { Notice } from "@/components/ui";
import { signatureFor } from "@/lib/record-signatures";
import { signRecordAction } from "../../../_actions/sign";

export const dynamic = "force-dynamic";
export const metadata = { title: "Training records" };

/**
 * The whole training file, on paper, in the order somebody auditing it would want.
 *
 * A summary matrix first, because that is what gets looked at and what the follow-up questions
 * come from, then the detail behind every single record — including the ones that are weaker,
 * which are labelled as weaker. A file where every record claims to be the strongest kind is the
 * one that gets taken apart; a file that says plainly which were signed, which were confirmed by
 * email and which the pharmacist-in-charge recorded on someone's behalf is the one that survives
 * being read closely.
 */
export default async function TrainingRecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string; ok?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { all, ok, error } = await searchParams;
  const f = await trainingFile({ includeFormer: all === "1" });

  /*
   * The record is signed per year and per scope, not once for all time.
   *
   * A signature that covered "the training file" for ever would be a signature against a moving
   * document — every completion added afterwards would arrive under somebody's certification
   * without them seeing it. The year and the scope together name a version somebody can actually
   * have read.
   */
  const recordKey = `${f.preparedOn.slice(0, 4)}-${all === "1" ? "all" : "current"}`;
  const signature = await signatureFor("training_file", recordKey);

  // What the signature is bound to. Any change to who is on the file, or to what they have
  // completed, changes this — and the signed block then says so rather than standing silently.
  const content = f.people
    .map((p) => `${p.name}|${p.lines.map((l) => `${l.type}:${l.completedOn ?? ""}`).join(",")}`)
    .join("\n");

  const backTo = `/compliance/training/records${all === "1" ? "?all=1" : ""}`;

  return (
    <PrintFrame ownDocument formTitle="Workforce training records" formNumber="" revised="" backHref="/compliance/training">
      {ok && <div className="no-print"><Notice kind="ok">{ok}</Notice></div>}
      {error && <div className="no-print"><Notice kind="crit">{error}</Notice></div>}

      <div className="no-print mb-4 flex flex-wrap gap-2">
        <Link href="/compliance/training/records" className={`btn btn-sm ${all === "1" ? "" : "btn-primary"}`}>
          Current staff
        </Link>
        <Link href="/compliance/training/records?all=1" className={`btn btn-sm ${all === "1" ? "btn-primary" : ""}`}>
          Include former staff and students
        </Link>
      </div>

      <div className="mb-4">
        <p className="text-lg font-bold">{f.pharmacy.name}</p>
        <p className="text-xs">{f.pharmacy.address}</p>
        {f.pharmacy.registration && <p className="text-xs">Kansas pharmacy registration {f.pharmacy.registration}</p>}
        <p className="mt-2 text-xs">
          Prepared {fmtLong(f.preparedOn)} by {user.name}. Covers {f.people.length}{" "}
          {all === "1" ? "people on file, current and former" : "current staff"}.
        </p>
        <p className="mt-1 text-xs">
          <b>Training delivered by:</b> {f.trainer.name} — {f.trainer.qualifications}.
        </p>
      </div>

      {/* ── Who has done what ── */}
      <div className="mb-1 text-sm font-bold">SUMMARY</div>
      <table className="mb-6 w-full border-collapse text-[10px]">
        <thead>
          <tr>
            <th className="border border-black px-1.5 py-1 text-left">Name</th>
            <th className="border border-black px-1.5 py-1 text-left">Job title</th>
            {f.courses.map((c) => (
              <th key={c.type} className="border border-black px-1.5 py-1 text-left">{c.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {f.people.map((p) => (
            <tr key={p.id}>
              <td className="border border-black px-1.5 py-1 align-top">{p.name}</td>
              <td className="border border-black px-1.5 py-1 align-top">{p.jobTitle}</td>
              {f.courses.map((c) => {
                const line = p.lines.find((l) => l.type === c.type);
                return (
                  <td key={c.type} className="border border-black px-1.5 py-1 align-top">
                    {line ? fmt(line.completedOn) : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* ── The material itself ── */}
      <div className="mb-1 text-sm font-bold">MATERIAL USED</div>
      <table className="mb-6 w-full border-collapse text-[10px]">
        <thead>
          <tr>
            <th className="border border-black px-1.5 py-1 text-left">Course</th>
            <th className="border border-black px-1.5 py-1 text-left">Length</th>
            <th className="border border-black px-1.5 py-1 text-left">Version in force</th>
            <th className="border border-black px-1.5 py-1 text-left">Requirement it addresses</th>
          </tr>
        </thead>
        <tbody>
          {f.courses.map((c) => (
            <tr key={c.type} className="print-block">
              <td className="border border-black px-1.5 py-1 align-top">{c.title}</td>
              <td className="border border-black px-1.5 py-1 align-top">~{c.minutes} min</td>
              <td className="border border-black px-1.5 py-1 align-top font-mono">{c.version}</td>
              <td className="border border-black px-1.5 py-1 align-top">{c.authority}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mb-6 text-[10px]">
        The material is written and held by this pharmacy and covers its own policies and procedures. Each version is
        identified by the code above; every record below names the version that was actually delivered to that person,
        so a course revised later cannot be mistaken for the one they sat. A copy of any version can be produced.
      </p>

      {/* ── Every record ── */}
      <div className="mb-1 text-sm font-bold">RECORDS</div>
      {f.people.map((p) => (
        <div key={p.id} className="print-block mb-4 border border-black">
          <div className="border-b border-black bg-neutral-200 px-2 py-1 text-[11px] font-bold">
            {p.name} — {p.jobTitle} · {p.present}
          </div>
          {p.lines.length === 0 ? (
            <p className="px-2 py-1 text-[10px]">No training recorded.</p>
          ) : (
            <table className="w-full border-collapse text-[10px]">
              <thead>
                <tr>
                  <th className="border border-black px-1.5 py-1 text-left">Training</th>
                  <th className="border border-black px-1.5 py-1 text-left">Date</th>
                  <th className="border border-black px-1.5 py-1 text-left">Next due</th>
                  <th className="border border-black px-1.5 py-1 text-left">Material</th>
                  <th className="border border-black px-1.5 py-1 text-left">How it was delivered and evidenced</th>
                </tr>
              </thead>
              <tbody>
                {p.lines.map((l) => (
                  <tr key={l.trainingId}>
                    <td className="border border-black px-1.5 py-1 align-top">{l.title}</td>
                    <td className="border border-black px-1.5 py-1 align-top">{fmt(l.completedOn)}</td>
                    <td className="border border-black px-1.5 py-1 align-top">{l.expiresOn ? fmt(l.expiresOn) : "does not repeat"}</td>
                    <td className="border border-black px-1.5 py-1 align-top">{l.material ?? "—"}</td>
                    <td className="border border-black px-1.5 py-1 align-top">
                      {l.how}
                      {l.comprehension ? ` ${l.comprehension}.` : ""}
                      {l.signedName ? ` Signed as "${l.signedName}"${l.signedAt ? ` on ${new Date(l.signedAt).toLocaleString()}` : ""}.` : ""}
                      {l.minutes ? ` Approximately ${l.minutes} minutes.` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {/*
            The gap "current" hides.

            29 CFR 1910.1030(g)(2)(i) asks for bloodborne training at the time of initial
            assignment — before the exposure, not merely within the same year as it. Being current
            today says nothing about the months between starting and being trained, and that gap is
            exactly what an inspector reads off a training file. Better it is stated here, with the
            number, than found there.
          */}
          {p.initialTrainingGapDays !== null && p.initialTrainingGapDays > 30 && (
            <p className="mt-2 text-[11px]">
              <b>Note:</b> bloodborne pathogens training was first recorded {p.initialTrainingGapDays} days after this
              person started. 29 CFR 1910.1030(g)(2)(i) asks for it at the time of initial assignment to tasks with
              occupational exposure. Nothing can change a past date; what can be recorded is what was actually done at
              the time, if it was.
            </p>
          )}
          {p.missing.length > 0 && (
            <p className="border-t border-black px-2 py-1 text-[10px]">
              <b>Not yet recorded:</b> {p.missing.join(", ")}.
            </p>
          )}
        </div>
      ))}

      <div className="print-block mt-4 border border-black p-2 text-[10px]">
        <p className="font-bold">Retention</p>
        <ul className="ml-4 list-disc">
          {f.retention.map((r) => <li key={r}>{r}</li>)}
        </ul>
      </div>

      <SignBlock
        kind="training_file"
        recordKey={recordKey}
        signature={signature}
        content={content}
        action={signRecordAction}
        canSign={user.role !== "staff"}
        defaultName={user.name}
        backTo={backTo}
      />
    </PrintFrame>
  );
}
