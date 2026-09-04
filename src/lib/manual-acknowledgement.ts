import "server-only";
import { db } from "@/db";
import { allSections } from "./manual-store";
import { revisionOf, ackState, describeRevision, ACK_LABEL, type Revision, type AckState } from "./manual-version";
import { onSiteToday } from "./roster";

/**
 * Who has acknowledged the policy manual, and which one.
 *
 * The question the pharmacist-in-charge asked was whether staff need to sign something for the
 * P&P manual. No single regulation says "collect a signature for the manual" in those words, but
 * four separate requirements are evidenced by it and by nothing else the pharmacy holds:
 *
 *  - 45 CFR 164.530(b)(1) — the workforce must be trained on the privacy policies and procedures,
 *    and 164.530(j)(1)(ii) requires that training to be documented and kept for six years.
 *  - 45 CFR 164.530(e)(1) — there must be sanctions for workforce members who fail to comply with
 *    the policies. A sanction for breaking a rule somebody was never shown does not survive
 *    scrutiny, and the acknowledgement is what shows they were.
 *  - 29 CFR 1910.1030(g)(2) — the exposure control plan must be explained to staff, and the
 *    explanation documented.
 *  - K.A.R. 68-19-1 — the pharmacy's continuous quality improvement programme must be in writing
 *    and pharmacy personnel must participate in it. Participation begins with having read it.
 *
 * So: yes, and it already exists here as a training every member of staff is sent. What was
 * missing is the half that makes it evidence rather than a tick — which manual they agreed to.
 * A manual edited in this system changes under a signature collected against it, and an
 * acknowledgement that cannot name its version quietly stops being true.
 */

export type PersonAck = {
  personId: string;
  name: string;
  role: string;
  state: AckState;
  stateLabel: string;
  signedOn: string | null;
  signedRevision: string | null;
  /** Who recorded it, so a paper acknowledgement reads differently from one they signed online. */
  how: string | null;
};

export type AcknowledgementBoard = {
  revision: Revision;
  described: string;
  people: PersonAck[];
  current: number;
  superseded: number;
  missing: number;
  /** Signed before revisions were recorded — an acknowledgement of nothing identifiable. */
  unknownCount: number;
};

export async function acknowledgementBoard(): Promise<AcknowledgementBoard> {
  const [sections, people, trainings] = await Promise.all([
    allSections(true),
    onSiteToday(),
    db.query.trainings.findMany(),
  ]);
  const revision = revisionOf(sections);

  const rows: PersonAck[] = people.map((p) => {
    // The most recent acknowledgement is the one that counts; the earlier ones stay in the file.
    const mine = trainings
      .filter((t) => t.personId === p.id && t.type === "policy_manual_acknowledgement")
      .sort((a, b) => a.completedOn.localeCompare(b.completedOn));
    const last = mine.at(-1) ?? null;
    const state = ackState(last ? (last.manualRevision ?? "legacy") : null, revision);
    return {
      personId: p.id,
      name: `${p.firstName} ${p.lastName}`,
      role: p.role,
      state,
      stateLabel: ACK_LABEL[state],
      signedOn: last?.completedOn ?? null,
      signedRevision: last?.manualRevision ?? null,
      how: last?.provider ?? null,
    };
  });

  return {
    revision,
    described: describeRevision(revision),
    people: rows,
    current: rows.filter((r) => r.state === "current").length,
    superseded: rows.filter((r) => r.state === "superseded").length,
    missing: rows.filter((r) => r.state === "none").length,
    unknownCount: rows.filter((r) => r.state === "unknown").length,
  };
}

/**
 * Whether the manual has moved on far enough to be worth asking eleven people to sign again.
 *
 * A typo corrected in a heading is not a change of policy, and chasing signatures for one is how a
 * control stops being taken seriously. The judgement is a person's, so this only reports the
 * position — how many are signed against an older manual, and when the manual last changed — and
 * says nothing about whether that matters.
 */
export async function acknowledgementGap(): Promise<{ superseded: number; missing: number; changedOn: string | null }> {
  const b = await acknowledgementBoard();
  return { superseded: b.superseded, missing: b.missing, changedOn: b.revision.changedOn };
}
