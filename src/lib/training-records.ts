import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getSettings } from "./settings";
import { TRAINING_LABEL, CREDENTIAL_LABEL } from "./labels";
import { courseFor } from "./courses";
import { courseVersion } from "./course-packet";
import { todayIso, daysBetween } from "./dates";
import type { TrainingType } from "@/db/schema";

/**
 * The training file, as an inspector would want it.
 *
 * Individual certificates are the right thing for the person who earned one. They are the wrong
 * thing to hand somebody standing at the counter asking to see your training records, because
 * thirty separate pages in no particular order is not a file — it is a pile, and a pile invites
 * the question of what is missing from it.
 *
 * So this assembles one document: who works here, what each of them has done and when, and then
 * the detail behind every record. The summary at the front is what gets looked at; the detail
 * behind it is what makes the summary believable.
 *
 * One requirement drove a specific field. The bloodborne pathogens standard does not simply
 * require training — 29 CFR 1910.1030(h)(2)(i) requires the record to contain four things: the
 * dates, a summary of the contents, the names *and qualifications* of the person who conducted
 * it, and the names and job titles of everyone who attended. Three of those were already here.
 * The trainer's qualifications were not, which would have been a citation on an otherwise
 * complete file.
 */

export type TrainerIdentity = {
  name: string;
  /** Licence, role and number — what makes them "a person knowledgeable in the subject matter". */
  qualifications: string;
};

/** Who delivers training here, and what makes them qualified to. */
export async function trainer(): Promise<TrainerIdentity> {
  const people = await db.query.people.findMany();
  const pic = people.find((p) => p.isPic);
  if (!pic) return { name: "The pharmacist-in-charge", qualifications: "No pharmacist-in-charge is recorded." };

  const creds = await db.query.credentials.findMany({ where: eq(schema.credentials.personId, pic.id) });
  const licence = creds.find((c) => c.type === "pharmacist_license");
  const bits = [pic.title || "Pharmacist-in-charge"];
  if (licence) {
    bits.push(
      `${CREDENTIAL_LABEL.pharmacist_license}${licence.number ? ` ${licence.number}` : ""}${licence.expiresOn ? `, current to ${licence.expiresOn}` : ""}`,
    );
  }
  if (creds.some((c) => c.type === "immunization_training")) bits.push("immunization-certified");
  return { name: `${pic.firstName} ${pic.lastName}`, qualifications: bits.join("; ") };
}

export type RecordLine = {
  type: TrainingType;
  title: string;
  completedOn: string;
  expiresOn: string | null;
  /** Signed on the page, replied by email, or recorded by the PIC. The three are not equal. */
  how: string;
  comprehension: string | null;
  material: string | null;
  minutes: number | null;
  signedName: string | null;
  signedAt: string | null;
  trainingId: string;
};

export type PersonFile = {
  id: string;
  name: string;
  jobTitle: string;
  present: string;
  lines: RecordLine[];
  missing: string[];
  /**
   * Where the first bloodborne pathogens training sits against the day they started.
   *
   * The standard is not satisfied by being current. 29 CFR 1910.1030(g)(2)(i) requires training at
   * the time of initial assignment to tasks where occupational exposure may take place — before
   * the exposure, not merely within the same year as it. So a technician hired in March and
   * trained in August has a five-month gap, and the record proves it rather than hiding it.
   *
   * Null where the person has no hire date recorded or has never had the training, both of which
   * are their own problem and are already reported elsewhere.
   */
  initialTrainingGapDays: number | null;
};

export type TrainingFile = {
  preparedOn: string;
  pharmacy: { name: string; registration: string | null; address: string };
  trainer: TrainerIdentity;
  people: PersonFile[];
  /** The courses this pharmacy uses, with the version currently in force. */
  courses: { type: TrainingType; title: string; authority: string; minutes: number; version: string }[];
  retention: string[];
};

const REQUIRED: TrainingType[] = [
  "hipaa_privacy_security",
  "fwa_general_compliance",
  "osha_bloodborne",
  "osha_hazard_communication",
  "controlled_substance_diversion",
  "cqi_program_review",
  "policy_manual_acknowledgement",
];

export async function trainingFile(opts: { includeFormer?: boolean } = {}): Promise<TrainingFile> {
  const [s, everyone, trainings, assignments, who] = await Promise.all([
    getSettings(),
    db.query.people.findMany({ orderBy: (p, { asc }) => [asc(p.lastName), asc(p.firstName)] }),
    db.query.trainings.findMany(),
    db.query.trainingAssignments.findMany(),
    trainer(),
  ]);

  const people = everyone
    .filter((p) => (opts.includeFormer ? true : p.active))
    .map((p): PersonFile => {
      const mine = trainings
        .filter((t) => t.personId === p.id)
        .sort((a, b) => b.completedOn.localeCompare(a.completedOn));

      const lines = mine.map((t): RecordLine => {
        const a = assignments.find((x) => x.trainingId === t.id);
        const course = courseFor(t.type);
        return {
          type: t.type,
          title: course?.title ?? TRAINING_LABEL[t.type],
          completedOn: t.completedOn,
          expiresOn: t.expiresOn,
          how:
            a?.completedVia === "email_reply"
              ? `Confirmed by email reply${a.replyFromAddress ? ` from ${a.replyFromAddress}` : ""}. Not individually signed.`
              : a?.completedVia === "pic_recorded"
                ? `Delivered in person and recorded by ${t.createdBy}. Not individually signed.`
                : a?.completedVia === "signed" || t.provider === "The pharmacy's own course, signed online"
                  ? "Read and signed by the person named, using a personal link."
                  : (t.provider ?? "Recorded from an outside certificate."),
          comprehension:
            a?.quizCorrect != null && a.quizTotal
              ? `${a.quizCorrect} of ${a.quizTotal} questions answered correctly`
              : null,
          material: a?.materialVersion
            ? `${course?.title ?? TRAINING_LABEL[t.type]}, version ${a.materialVersion}`
            : course
              ? `${course.title}, version ${courseVersion(course)}`
              : null,
          minutes: t.minutes ?? course?.minutes ?? null,
          signedName: a?.signedName ?? null,
          signedAt: a?.completedAt ?? null,
          trainingId: t.id,
        };
      });

      return {
        id: p.id,
        name: `${p.firstName} ${p.lastName}`,
        jobTitle: p.title || p.role,
        present: p.active
          ? p.engagement === "rotation"
            ? `On rotation${p.startsOn ? ` from ${p.startsOn}` : ""}${p.endsOn ? ` to ${p.endsOn}` : ""}${p.affiliation ? `, ${p.affiliation}` : ""}`
            : `Employed${p.hiredOn ? ` since ${p.hiredOn}` : ""}`
          : `Left${p.endedOn ? ` ${p.endedOn}` : ""}`,
        lines,
        missing: REQUIRED.filter((t) => !mine.some((x) => x.type === t)).map((t) => TRAINING_LABEL[t]),
        /*
         * The gap between starting and being trained, which "current" hides.
         *
         * 29 CFR 1910.1030(g)(2)(i) asks for training at the time of initial assignment to tasks
         * with occupational exposure — before it, not within the same year as it. A record showing
         * somebody hired in March and trained in August is evidence of five months of untrained
         * exposure, and it is better to know that from this page than from an inspector reading it.
         */
        initialTrainingGapDays: (() => {
          if (!p.hiredOn) return null;
          const first = mine
            .filter((x) => x.type === "osha_bloodborne")
            .map((x) => x.completedOn)
            .sort()[0];
          if (!first) return null;
          return Math.max(0, daysBetween(p.hiredOn, first));
        })(),
      };
    });

  return {
    preparedOn: todayIso(),
    pharmacy: {
      name: s.pharmacy_name || "This pharmacy",
      registration: s.pharmacy_registration_number || null,
      address: [s.pharmacy_address, [s.pharmacy_city, s.pharmacy_state].filter(Boolean).join(", "), s.pharmacy_zip]
        .filter(Boolean)
        .join(" · "),
    },
    trainer: who,
    people,
    courses: REQUIRED.map((t) => {
      const c = courseFor(t);
      // The policy manual has no course written into the site — the material is the pharmacy's
      // own manual, which cannot live in the software and is attached to the email instead.
      return c
        ? { type: t, title: c.title, authority: c.authority, minutes: c.minutes, version: courseVersion(c) }
        : {
            type: t,
            title: TRAINING_LABEL[t],
            authority: "The pharmacy's own policy and procedure manual, which the manual itself requires every employee to acknowledge.",
            minutes: 0,
            version: "the manual as attached",
          };
    }),
    retention: [
      "HIPAA training documentation is kept six years from creation — 45 CFR 164.530(j).",
      "Bloodborne pathogens training records are kept three years from the date of training — 29 CFR 1910.1030(h)(2)(ii).",
      "Records are kept for former staff for the same periods; nobody is removed from this file when they leave.",
    ],
  };
}
