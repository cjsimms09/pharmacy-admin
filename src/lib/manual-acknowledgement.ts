import "server-only";
import { db } from "@/db";
import { allSections } from "./manual-store";
import { revisionOf, ackState, describeRevision, provablyCurrent, ACK_LABEL, type Revision, type AckState } from "./manual-version";
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
  /** When it falls due again. An acknowledgement is an annual act, not a once-ever one. */
  dueOn: string | null;
  /** True where that date has passed, whatever the revision says. */
  lapsed: boolean;
  signedRevision: string | null;
  /** Who recorded it, so a paper acknowledgement reads differently from one they signed online. */
  how: string | null;
  /** The training row, for pinning a revision to it once that can be established. */
  trainingId: string | null;
  /** True where the manual has not been edited since they signed, so the version can be settled. */
  settleable: boolean;
};

export type AcknowledgementBoard = {
  revision: Revision;
  described: string;
  people: PersonAck[];
  current: number;
  superseded: number;
  missing: number;
  /** Signed, but more than a year ago. Due again regardless of what the manual says. */
  lapsed: number;
  /** Signed before revisions were recorded — an acknowledgement of nothing identifiable. */
  unknownCount: number;
  /** Of those, how many can be settled from the edit history without asking anybody again. */
  settleable: number;
};

export async function acknowledgementBoard(): Promise<AcknowledgementBoard> {
  const [sections, people, trainings] = await Promise.all([
    allSections(true),
    onSiteToday(),
    db.query.trainings.findMany(),
  ]);
  const revision = revisionOf(sections);
  const today = (await import("./dates")).todayIso();

  const rows: PersonAck[] = people.map((p) => {
    // The most recent acknowledgement is the one that counts; the earlier ones stay in the file.
    const mine = trainings
      .filter((t) => t.personId === p.id && t.type === "policy_manual_acknowledgement")
      .sort((a, b) => a.completedOn.localeCompare(b.completedOn));
    const last = mine.at(-1) ?? null;
    const state = ackState(last ? (last.manualRevision ?? "legacy") : null, revision);
    /*
     * An acknowledgement with no version can still be settled, sometimes.
     *
     * If nothing in the manual has been edited since the moment they signed, the document they
     * were shown is character for character the one on file now. That is a fact the system holds,
     * not an assumption — and it is the difference between asking eleven people to re-sign
     * something they signed this morning and simply recording what is already known.
     */
    const settleable = state === "unknown" && provablyCurrent(last?.createdAt, revision);
    /*
     * Two independent reasons to sign again, and only one was being checked.
     *
     * The manual changing is one. A year passing is the other — the acknowledgement renews every
     * twelve months like every other training here, and a signature from two years ago against
     * text nobody has edited since would otherwise read as current for ever. The date it falls due
     * is on the record already; it was simply never shown or tested.
     */
    const dueOn = last?.expiresOn ?? null;
    const lapsed = Boolean(dueOn && dueOn < today);
    return {
      personId: p.id,
      name: `${p.firstName} ${p.lastName}`,
      role: p.role,
      state,
      stateLabel: ACK_LABEL[state],
      signedOn: last?.completedOn ?? null,
      dueOn,
      lapsed,
      signedRevision: last?.manualRevision ?? null,
      how: last?.provider ?? null,
      trainingId: last?.id ?? null,
      settleable,
    };
  });

  return {
    revision,
    described: describeRevision(revision),
    people: rows,
    // A lapsed one is not counted as current, whatever revision it names.
    current: rows.filter((r) => r.state === "current" && !r.lapsed).length,
    lapsed: rows.filter((r) => r.lapsed).length,
    superseded: rows.filter((r) => r.state === "superseded").length,
    missing: rows.filter((r) => r.state === "none").length,
    unknownCount: rows.filter((r) => r.state === "unknown").length,
    settleable: rows.filter((r) => r.settleable).length,
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

/**
 * Records the revision against acknowledgements that can be settled from the edit history.
 *
 * Only touches the ones where nothing has been edited since the person signed, so nothing is
 * being asserted that the system cannot show. The basis is written into the record alongside it,
 * because a fingerprint that appeared later needs to say how it got there — an unexplained one is
 * exactly the kind of thing that looks like backfilled evidence.
 */
export async function settleVersions(user: { name: string }): Promise<{ settled: number; left: number }> {
  const board = await acknowledgementBoard();
  const { eq } = await import("drizzle-orm");
  const { schema } = await import("@/db");
  let settled = 0;

  for (const person of board.people) {
    if (!person.settleable || !person.trainingId) continue;
    const row = await db.query.trainings.findFirst({ where: eq(schema.trainings.id, person.trainingId) });
    if (!row) continue;
    await db
      .update(schema.trainings)
      .set({
        manualRevision: board.revision.fingerprint,
        notes:
          `${row.notes ?? ""}\n\nRecorded against manual revision ${board.revision.fingerprint} by ${user.name}. ` +
          `No section of the manual had been edited between this signature and that determination, so the manual ` +
          `acknowledged is the one on file.`.trim(),
      })
      .where(eq(schema.trainings.id, person.trainingId));
    settled++;
  }

  const after = await acknowledgementBoard();
  return { settled, left: after.unknownCount };
}
