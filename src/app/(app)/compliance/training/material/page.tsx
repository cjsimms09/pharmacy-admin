import { familyTabs } from "@/lib/families";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { onSiteToday } from "@/lib/roster";
import { COURSES } from "@/lib/courses";
import { binderContents } from "@/lib/training-binder";
import { courseVersion } from "@/lib/course-packet";
import { TRAINING_LABEL } from "@/lib/labels";
import { TRAINING_TYPES, type TrainingType } from "@/db/schema";
import { PageHeader, Card, Notice } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Training material" };

/**
 * What the staff were actually sent, to read or print.
 *
 * The material existed only as an attachment on an email, which meant the pharmacist-in-charge
 * could not read what his own people had been given without going and finding the message — and
 * "show me the bloodborne pathogens training you delivered" was a search of somebody's Sent
 * folder rather than a document.
 *
 * Every one of these opens the same PDF the staff member received, not a rendering of it. The
 * version somebody was trained on is the thing being produced, and a second implementation of it
 * would eventually disagree with the first.
 */
export default async function TrainingMaterialPage() {
  await requireUser();
  const [s, people] = await Promise.all([getSettings(), onSiteToday()]);
  const immunizers = people.filter((p) => p.administersVaccines);

  const written = TRAINING_TYPES.filter((t) => COURSES[t]);
  const binder = binderContents();
  const generated: TrainingType[] = ["policy_manual_acknowledgement", "immunization_protocol_review"];

  return (
    <>
      <PageHeader
        tabs={familyTabs("training", "/compliance/training/material")}
        title="Training material"
        subtitle="The exact document each member of staff is sent, to read on screen or print for the file. Opening one uses your browser's PDF viewer, so print is the button in there."
        actions={<Link href="/compliance/training/records" className="btn">The training file</Link>}
      />

      {/*
        The binder, first, because it is the thing somebody came here to do.

        Six courses printed one at a time from six rows is the friction that leaves a binder a year
        out of date. One file, one print job, continuously numbered, with a contents page carrying
        the version codes — so a year from now it can be told at a glance whether the paper copy
        still matches what the site is sending.
      */}
      <Card
        title="Print the whole set for the binder"
        subtitle="Every course in one file, with a cover and a contents page, numbered straight through. This is what belongs on the shelf next to the policy and procedure manual."
        className="mb-6"
      >
        <div className="flex flex-wrap items-center gap-3">
          <a href="/compliance/training/binder" target="_blank" rel="noreferrer" className="btn btn-primary">
            Open the binder
          </a>
          <span className="text-sm text-ink-2">
            {binder.length} courses · {binder.reduce((n, b) => n + b.pages, 0) + 2} pages · about{" "}
            {binder.reduce((n, b) => n + b.minutes, 0)} minutes of reading in total
          </span>
        </div>
        <p className="mt-3 text-xs text-ink-3">
          Reprint it when a version code below stops matching the one on the printed contents page. A certificate
          always names the version the person actually sat, so an out-of-date binder never makes a record wrong — it
          just stops being the material anybody was given.
        </p>
      </Card>

      <Card
        title="The written courses"
        count={written.length}
        subtitle="Each is a short read and a set of questions that must all be answered correctly. The version code changes whenever the material changes, and a certificate names the version the person actually sat."
        className="mb-6"
      >
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr><th>Training</th><th>About</th><th>Version</th><th>Requirement it meets</th><th></th></tr>
            </thead>
            <tbody>
              {written.map((t) => {
                const c = COURSES[t]!;
                return (
                  <tr key={t}>
                    <td className="text-sm font-medium">{c.title}</td>
                    <td className="whitespace-nowrap text-xs text-ink-3">{c.minutes} min · {c.questions.length} questions</td>
                    <td className="font-mono text-xs">{courseVersion(c)}</td>
                    <td className="max-w-sm text-xs text-ink-2">{c.authority}</td>
                    <td className="whitespace-nowrap">
                      <a
                        href={`/compliance/training/material/${t}`}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-sm btn-primary"
                      >
                        View and print
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/*
        The two that are not written courses.

        Acknowledging the policy manual and reviewing the immunization protocol are readings of
        documents this pharmacy already owns, so the material is generated from them rather than
        written separately — which is the only way the copy somebody signs for having read stays
        the same as the copy they were sent.
      */}
      <Card
        title="Read from the pharmacy's own documents"
        count={generated.length}
        subtitle="These two are not written courses. The material is the pharmacy's own manual and its own signed protocol, produced from the live copy — so what is sent cannot drift from what is in force."
        className="mb-6"
      >
        <ul className="rows">
          <li className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <span className="min-w-0">
              <span className="block text-sm font-medium">{TRAINING_LABEL.policy_manual_acknowledgement}</span>
              <span className="block text-xs text-ink-3">
                The whole manual as it stands today, from{" "}
                <Link href="/manual" className="underline">the manual</Link>.
              </span>
            </span>
            <a
              href="/compliance/training/material/policy_manual_acknowledgement"
              target="_blank"
              rel="noreferrer"
              className="btn btn-sm btn-primary shrink-0"
            >
              View and print
            </a>
          </li>
          <li className="py-2.5">
            <span className="block text-sm font-medium">{TRAINING_LABEL.immunization_protocol_review}</span>
            <span className="block text-xs text-ink-3">
              Written per person, because the protocol names the individual it authorises — reviewing somebody
              else&rsquo;s is not reviewing yours.
            </span>
            {immunizers.length === 0 ? (
              <p className="mt-1 text-xs text-ink-3">
                Nobody is marked as administering vaccines, so there is no protocol to produce.
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {immunizers.map((p) => (
                  <a
                    key={p.id}
                    href={`/compliance/training/material/immunization_protocol_review?person=${p.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-sm"
                  >
                    {p.firstName} {p.lastName}
                  </a>
                ))}
              </div>
            )}
          </li>
        </ul>
      </Card>

      <Notice kind="ok">
        <b>This is the same file the staff member receives.</b> It is attached to the email that assigns the training
        and shown on the page they open, so what you print here is what they were given — down to the version code on
        it. {s.pharmacy_name ? `Printed copies carry ${s.pharmacy_name}'s name.` : ""}
      </Notice>
    </>
  );
}
