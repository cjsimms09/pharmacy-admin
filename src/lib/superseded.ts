/**
 * Telling a record that has been replaced apart from one that has simply lapsed.
 *
 * These look identical in a database — both are expired — and treating them the same is how a
 * screen ends up either useless or dangerous. A page that shows every expired licence a person has
 * ever held buries this year's problem in five years of history. A page that hides everything
 * expired hides the licence that ran out last week and was never renewed, which is the single most
 * important thing on the page.
 *
 * So the distinction is replacement, not expiry. A credential that expired and was renewed is
 * history: it is kept, it can be produced, and it does not belong in the eye line. A credential
 * that expired and was not renewed is a live gap and stays exactly where it is, at full weight.
 *
 * Written generically because the same argument applies to credentials, trainings and documents,
 * and three implementations of it would have disagreed about the interesting case.
 */

export type Superseding<T> = {
  /** What makes two rows the same thing over time — a person's pharmacist licence, say. */
  key: (row: T) => string;
  /** When the row stops being in force. Null means it does not expire, which always wins. */
  endsOn: (row: T) => string | null;
};

export type Split<T> = {
  /** In force, or lapsed with nothing to replace it — either way, on the page. */
  current: T[];
  /** Superseded by something newer. Kept, findable, and out of the way. */
  history: T[];
};

/**
 * Splits rows into what belongs on the page and what belongs behind a fold.
 *
 * Within each group the row that runs the longest is the one in force — a row with no end date
 * beats any dated one, and a later date beats an earlier one. Every *other* row in that group that
 * has already ended is history. The consequence worth stating: a group whose best row has already
 * expired keeps that row in `current`, because a lapsed licence with no replacement is the thing
 * somebody needs to see.
 */
export function splitSuperseded<T>(rows: T[], today: string, on: Superseding<T>): Split<T> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = on.key(row);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }

  const current: T[] = [];
  const history: T[] = [];
  for (const group of groups.values()) {
    const best = group.reduce((a, b) => (rank(on.endsOn(b)) > rank(on.endsOn(a)) ? b : a));
    for (const row of group) {
      const end = on.endsOn(row);
      if (row !== best && end !== null && end < today) history.push(row);
      else current.push(row);
    }
  }
  return { current, history };
}

/** No end date outranks every date; otherwise the later date wins. */
function rank(end: string | null): string {
  return end === null ? "9999-99-99" : end;
}

/** True where a row has ended and something else has taken over. */
export function isSuperseded<T>(row: T, rows: T[], today: string, on: Superseding<T>): boolean {
  return splitSuperseded(rows, today, on).history.includes(row);
}
