/**
 * Which stored mailbox lines a fixed reader should be given another go at.
 *
 * A report a reader refuses ("Held, nothing stored: ... does not hold together") keeps that verdict
 * for ever: the sweep never touches a message twice, and only reports the monthly ceiling held were
 * brought back on their own. So when the reader is mended, the line goes on saying "arrived and was
 * not counted" until somebody presses Read again. A Health Mart Atlas payment detail sat like that
 * from 3 October, a reader fix on 4 October notwithstanding.
 *
 * A line is tried once per build of the site, not once per sweep: the same refusal rewritten every
 * few minutes would change nothing and fill the audit trail. The build it was last tried on is
 * written into the line.
 *
 * Pure.
 */
export const REFUSED_MARK = "Held, nothing stored";

export const triedMark = (build: string) => `[tried on build ${build}]`;

export type RefusedLine = { routeResult: string | null; imported: boolean | null; documentId: string | null; receivedAt: string };

export function wantsAnotherRead(line: RefusedLine, build: string, since: string): boolean {
  if (!build) return false;
  if (!line.documentId) return false;
  if (line.imported === true) return false;
  if (line.receivedAt < since) return false;
  const said = line.routeResult ?? "";
  if (!said.includes(REFUSED_MARK)) return false;
  return !said.includes(triedMark(build));
}
