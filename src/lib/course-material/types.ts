import type { TrainingType } from "@/db/schema";

/**
 * The shape of a course, kept away from the courses themselves.
 *
 * Six files import this and one file assembles them. Keeping the type here rather than in the
 * assembler is what stops the import graph from looping back on itself, and it means a course can
 * be opened and read on its own without the whole register coming with it.
 */

export type Section = {
  heading: string;
  body: string[];
  /**
   * The short version, for somebody who has read it once and is coming back to it.
   *
   * Printed as a boxed summary at the end of the section. This is the part people actually retain,
   * and writing it out is also the honest test of whether the section said anything: a section
   * whose takeaways cannot be written in three lines was three pages of throat-clearing.
   */
  takeaways?: string[];
};

export type Question = {
  q: string;
  options: string[];
  /** Index into options. */
  answer: number;
  /** Shown when they get it wrong, because the wrong answer is the teachable moment. */
  why: string;
};

export type Course = {
  type: TrainingType;
  title: string;
  /**
   * Roughly how long the material takes, computed from the material.
   *
   * Never typed by hand. It was, and after the courses were expanded four of the six numbers were
   * wrong by a factor of two — which is worse than no number at all, because somebody schedules
   * twenty minutes for a forty-minute course and rushes the part that mattered. The assembler
   * fills this in from the word count; a course file that sets it is ignored.
   */
  minutes?: number;
  /** The rule this exists to satisfy, in one line, for the certificate and for the sceptic. */
  authority: string;
  intro: string;
  /**
   * What the person will be able to do afterwards, in their words rather than the regulation's.
   *
   * Every real training package has these and they are not decoration: an inspector reading a
   * course wants to know what it set out to teach before judging whether it did, and a person
   * about to spend twenty minutes on it deserves to know what it is for.
   */
  objectives?: string[];
  sections: Section[];
  questions: Question[];
  /** Set where the standard requires something a web page cannot provide on its own. */
  liveQuestionsRequired?: boolean;
  /**
   * Where this pharmacy's own rule on the subject lives, so the material and the manual cannot
   * drift apart without somebody noticing.
   */
  seeAlso?: string[];
  /** The sources, named, so a reader can go and check rather than take it on faith. */
  references?: string[];
  /**
   * What the rule says about who is allowed to deliver this training.
   *
   * The question behind this field is a fair one and the answer is different for each course, so
   * it is answered per course rather than in a paragraph somewhere: most of these name no
   * qualification for the trainer at all, one asks for a person "knowledgeable in the subject
   * matter", and none of them is continuing education. Printing the answer on the training file
   * means the pharmacy does not have to reconstruct it under questioning.
   */
  whoMayTeach: string;
};

export type { TrainingType };
