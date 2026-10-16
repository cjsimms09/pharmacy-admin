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
  /**
   * When the row stops being in force. Null means it does not expire, which always wins. `UNKNOWN_END` means nobody recorded when, which
   * loses to every date.
   */
  endsOn: (row: T) => string | null;
};

/** What `endsOn` returns for a row that carries no date and is not said to be permanent: nobody has recorded when it stops. */
export const UNKNOWN_END = "";

/**
 * What a credential row says about when it stops, in the terms `inForce` and `splitSuperseded` rank by: null when it is said never to
 * expire, its date when it has one, and `UNKNOWN_END` when it has neither. A blank date is not "never expires" — it is something nobody
 * entered, so it must never outrank a date somebody did, and the three screens that read these rows (Licences, the inspection list and the
 * due list) must not each decide it differently.
 */
export function credentialEnd(c: { noExpiry?: boolean | null; expiresOn?: string | null }): string | null {
  if (c.noExpiry) return null;
  return c.expiresOn || UNKNOWN_END;
}

export type Split<T> = {
  /** In force, or lapsed with nothing to replace it — either way, on the page. */
  current: T[];
  /** Superseded by something newer. Kept, findable, and out of the way. */
  history: T[];
};

/**
 * Splits rows into what belongs on the page and what belongs behind a fold.
 *
 * Within each group the row that runs the longest is the one in force — a row said never to expire
 * beats any dated one, and a later date beats an earlier one. Every *other* row in that group that
 * has already ended is history. The consequence worth stating: a group whose best row has already
 * expired keeps that row in `current`, because a lapsed licence with no replacement is the thing
 * somebody needs to see. A row whose date nobody recorded loses to every date and is never put in
 * history: it stays in view until somebody records one, because hiding it would hide that the
 * date is missing.
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
    const best = inForce(group, on.endsOn);
    for (const row of group) {
      const end = on.endsOn(row);
      if (row !== best && end !== null && end !== UNKNOWN_END && end < today) history.push(row);
      else current.push(row);
    }
  }
  return { current, history };
}

/**
 * The row of a group that is in force: the one that runs the longest, a row said never to expire beating any dated one, a row with no
 * date recorded losing to every date, and the first of two that end together. A reader that wants "the certificate on file" takes it
 * from here and not from the first row the database returns, because once a record has been renewed the first row is the one it replaced.
 */
export function inForce<T>(rows: T[], endsOn: (row: T) => string | null): T | undefined {
  if (rows.length === 0) return undefined;
  return rows.reduce((a, b) => (rank(endsOn(b)) > rank(endsOn(a)) ? b : a));
}

/** Never expiring outranks every date and an unrecorded date ranks below every one; otherwise the later date wins. */
function rank(end: string | null): string {
  return end === null ? "9999-99-99" : end;
}

/** True where a row has ended and something else has taken over. */
export function isSuperseded<T>(row: T, rows: T[], today: string, on: Superseding<T>): boolean {
  return splitSuperseded(rows, today, on).history.includes(row);
}
