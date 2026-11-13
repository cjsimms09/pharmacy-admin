import type { TrainingType } from "@/db/schema";
import type { Course } from "./course-material/types";
import { hipaa } from "./course-material/hipaa";
import { fwa } from "./course-material/fwa";
import { bloodborne } from "./course-material/bloodborne";
import { hazcom } from "./course-material/hazcom";
import { diversion } from "./course-material/diversion";
import { cqi } from "./course-material/cqi";
import { technician } from "./course-material/technician";

/**
 * The training itself, written out.
 *
 * Until now the site could record that somebody had done their annual training and could email
 * them a link to somebody else's website. Both of those depend on a course existing somewhere
 * else, and the free ones move, expire or quietly turn into a sales page. A pharmacy that cannot
 * produce the material its staff were trained on has training records rather than training.
 *
 * So the material lives here, in the repository, versioned with the rest of the site, and is
 * read on the same page the person signs. Three consequences worth stating:
 *
 *   It is in-house training, and that is a legitimate thing to be. HIPAA requires training on
 *   the covered entity's own policies and procedures — 45 CFR 164.530(b)(1) — and names no
 *   accreditor. OSHA requires the content at 1910.1030(g)(2)(vii) and 1910.1200(h) and names no
 *   accreditor either. Nothing here is CE and nothing here claims to be.
 *
 *   Bloodborne pathogens training additionally requires an opportunity for interactive questions
 *   and answers with a person knowledgeable in the subject. A web page cannot be that person, so
 *   the pharmacist-in-charge goes through it and records that he did, and the record is not
 *   complete until he has. Leaving that out would be the difference between training that
 *   satisfies the standard and training that merely looks like it does.
 *
 *   A Part D plan or PSAO may insist on its own FWA module. Where it does, that module is the
 *   one to use and this becomes the general compliance training that sits alongside it. The
 *   course says so rather than letting a pharmacy assume it is covered.
 *
 * Each course ends with questions that have to be answered correctly. A record that says someone
 * read a page is weaker than one that says they demonstrated they understood it, and the extra
 * cost to the person is a couple of minutes.
 *
 * One course per file, under course-material/, because these are documents rather than code and
 * a six-thousand-word register in one module is a file nobody edits carefully.
 */

export type { Section, Question, Course } from "./course-material/types";

/** Stamps the reading time on, so the figure and the material cannot disagree. */
const timed = (c: Course): Course => ({ ...c, minutes: readingMinutes(c) });

export const COURSES: Partial<Record<TrainingType, Course>> = {
  hipaa_privacy_security: timed(hipaa),
  fwa_general_compliance: timed(fwa),
  osha_bloodborne: timed(bloodborne),
  osha_hazard_communication: timed(hazcom),
  controlled_substance_diversion: timed(diversion),
  cqi_program_review: timed(cqi),
  technician_initial_training: timed(technician),
};

export function courseFor(type: TrainingType): Course | null {
  return COURSES[type] ?? null;
}

/** Total questions in a course, for wording like "4 of 4". */
export function questionCount(type: TrainingType): number {
  return COURSES[type]?.questions.length ?? 0;
}

/**
 * Roughly how long the material takes to read, from the material itself.
 *
 * The stated minutes used to be a number somebody typed, and after the courses were expanded four
 * of the six were wrong by a factor of two. A figure that drifts from the thing it describes is
 * worse than no figure: somebody schedules twenty minutes for a forty-minute course, and the
 * honest ones end up rushing the part that mattered.
 *
 * Two hundred words a minute is a fair pace for careful reading of material like this, and each
 * question is counted at a quarter of a minute for reading and choosing.
 */
export function readingMinutes(course: Course): number {
  const words = course.sections
    .flatMap((s) => [...s.body, ...(s.takeaways ?? [])])
    .concat(course.intro, ...(course.objectives ?? []))
    .reduce((n, p) => n + p.split(/\s+/).filter(Boolean).length, 0);
  const questionWords = course.questions.reduce(
    (n, q) => n + [q.q, ...q.options].join(" ").split(/\s+/).filter(Boolean).length,
    0,
  );
  return Math.max(5, Math.round((words + questionWords) / 200 + course.questions.length * 0.25));
}
