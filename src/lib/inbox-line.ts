/**
 * One arrival, told as a sentence a person can act on.
 *
 * The owner: "THE INBOX SCREEN NEEDS TO BE A LOT BETTER. NEEDS TO BE MORE CLEAR ABOUT WHAT WAS
 * RECEIVED, HOW IT WAS SORTED.. I NEED TO BE ABLE TO MAKE SURE IT DID THE RIGHT THING WITH THE
 * DOCUMENT." Asked what he wanted in front of him he chose everything that arrived, newest first,
 * with the problems marked — a log rather than a worklist, so the ordinary days are visible too.
 *
 * Five questions per line, in the order somebody asks them:
 *
 *   what is it        the kind, in his words rather than the recogniser's
 *   where from        the mailbox, the Add screen, or the SFTP host
 *   what happened     one of six outcomes, each looking different from the others
 *   what changed      the loader's own sentence, which already carries the figures
 *   what can I do     said on the line, because a dead end was the whole complaint
 *
 * ── Why this is pure, and reads no file ──
 *
 * The page it feeds draws two hundred rows. The version before this read up to twenty stored files
 * on every view to guess at the unrecognised ones, on the thread that serves every other page —
 * and this project has now twice found the site pinned at full CPU by work of exactly that shape.
 * Everything here is derived from the row the sweep already wrote. Nothing is opened, nothing is
 * parsed, nothing is recomputed.
 */

/** The columns of `inbox_items` this needs. A row, not a table. */
export type InboxRow = {
  receivedAt: string;
  fromAddress: string | null;
  subject: string | null;
  fileName: string | null;
  documentId: string | null;
  status: string;
  reason: string | null;
  routedAs: string | null;
  routeResult: string | null;
  scanned?: boolean | null;
};

export type ArrivalSource = "mailbox" | "sftp" | "dropped";

/**
 * Where it came from, which the row records only by implication.
 *
 * There are three ways in now and the pharmacist should not have to know that "sftp://136.65..."
 * in a From column means RedSail's host pushed it. The Add screen files under the file's own name
 * rather than an address, so an entry with no `@` and no scheme came from somebody's hands.
 */
export function sourceOf(row: Pick<InboxRow, "fromAddress">): { source: ArrivalSource; label: string } {
  const from = (row.fromAddress ?? "").trim();
  if (/^sftp:/i.test(from)) return { source: "sftp", label: "Pushed to the pharmacy's file host" };
  if (from.includes("@")) return { source: "mailbox", label: "Emailed to the pharmacy's mailbox" };
  return { source: "dropped", label: "Added by hand on the Add screen" };
}

/** The kinds the loader knows, in the owner's words. Anything unlisted is shown as it is stored. */
const KIND_WORDS: Record<string, string> = {
  training_reply: "A member of staff replying to a training email",
  rx_transactions: "Daily claims report",
  claims: "Claims export",
  on_hand: "Balance on hand",
  pioneer_catalog: "Wholesaler catalogue",
  supplier_catalog: "Wholesaler catalogue",
  nadac: "NADAC pricing file",
  rebate_report: "McKesson rebate breakdown",
  purchase_drilldown: "McKesson Purchase Drill Down",
  return_policy: "Returned goods policy",
  remittance_835: "835 remittance",
  copay_remit: "Copay-card voucher remittance",
  rxrescue_credit: "RxRescue credit memo",
  payer_payments: "Third-party payments report",
  accrual_sales: "System sales summary",
  unrecognised: "Not recognised",
};

export function kindWords(routedAs: string | null | undefined): string | null {
  if (!routedAs) return null;
  return KIND_WORDS[routedAs] ?? routedAs.replace(/_/g, " ");
}

export type Outcome =
  /** Read, and the data changed. The ordinary good day. */
  | "loaded"
  /** Recognised, and deliberately not stored: a gate refused it. Nothing changed. */
  | "held"
  /** Recognised, stored as a document, and not loaded into any table. */
  | "filed_only"
  /** Stored as a document because nothing recognised it. */
  | "not_recognised"
  /** Refused before it was stored at all — size, type, or the PHI gate. */
  | "rejected"
  /** Seen and deliberately passed over: a sender nobody allowed, or a message with nothing in it. */
  | "ignored";

export type LineStory = {
  outcome: Outcome;
  /** The one line, in bold, that says what happened. */
  headline: string;
  /** The loader's own sentence, where there is one: what actually changed. */
  changed: string | null;
  /** Why it went the way it did, where that is not obvious from the headline. */
  why: string | null;
  tone: "ok" | "warn" | "crit" | "muted";
  /** True where a person deciding what this is would help. Drives the re-route control. */
  invitesRerouting: boolean;
};

/*
 * A gate refusal, in every wording the loaders use for it.
 *
 * These are deliberately literal. "Held, nothing stored" is what the copay reader says and
 * "does not balance" is what the 835 path says; a loose test like /held/ would catch a catalogue
 * line reading "3 rows held for review" and colour a good load as a refusal.
 */
const HELD = /^Held, nothing stored|does not balance|could not be loaded|nothing could be loaded/i;

/**
 * What happened to this arrival, and how it should look.
 *
 * The distinction that matters most is between recognised-and-refused and recognised-and-loaded.
 * A catalogue turned away for naming the wrong supplier was recognised perfectly well, and a green
 * badge on it says the opposite of the truth.
 */
export function storyOf(row: InboxRow): LineStory {
  const kind = kindWords(row.routedAs);
  const result = row.routeResult?.trim() || null;

  if (row.status === "rejected") {
    return {
      outcome: "rejected",
      headline: "Refused before it was stored",
      changed: null,
      why: row.reason ?? "No reason was recorded.",
      tone: "crit",
      invitesRerouting: false,
    };
  }
  if (row.status === "ignored") {
    return {
      outcome: "ignored",
      headline: "Passed over",
      changed: null,
      why: row.reason ?? "Nothing in this message was for the pharmacy.",
      tone: "muted",
      invitesRerouting: false,
    };
  }

  if (row.routedAs && row.routedAs !== "unrecognised") {
    if (result && HELD.test(result)) {
      return {
        outcome: "held",
        headline: `${kind}, held — nothing was stored`,
        changed: null,
        why: result,
        tone: "crit",
        // The reading may be right and the file wrong; re-routing is not the fix, but it is worth offering.
        invitesRerouting: true,
      };
    }
    return {
      outcome: result ? "loaded" : "filed_only",
      headline: result ? `Loaded as ${kind?.toLowerCase()}` : `${kind}, filed but not loaded`,
      changed: result,
      why: result ? null : "It was recognised and kept as a document, and nothing was read into the site's tables.",
      tone: result ? "ok" : "warn",
      invitesRerouting: true,
    };
  }

  return {
    outcome: "not_recognised",
    headline: "Filed, not recognised",
    changed: null,
    why: result ?? row.reason ?? "Nothing in the file matched anything the site knows how to read.",
    tone: "warn",
    invitesRerouting: true,
  };
}

/**
 * The one-line summary above the list, so a day can be judged without reading it.
 *
 * Counted over whatever is shown rather than over all time: the number that matters is how today
 * went, and a total since the beginning would be the same number every day.
 */
export function summarise(rows: InboxRow[]): string {
  if (rows.length === 0) return "Nothing has arrived yet.";
  const by = new Map<Outcome, number>();
  for (const r of rows) {
    const o = storyOf(r).outcome;
    by.set(o, (by.get(o) ?? 0) + 1);
  }
  const n = (o: Outcome) => by.get(o) ?? 0;
  const bits: string[] = [`${rows.length} arrival${rows.length === 1 ? "" : "s"}`];
  if (n("loaded")) bits.push(`${n("loaded")} loaded`);
  if (n("held")) bits.push(`${n("held")} held with nothing stored`);
  if (n("filed_only")) bits.push(`${n("filed_only")} filed but not loaded`);
  if (n("not_recognised")) bits.push(`${n("not_recognised")} not recognised`);
  if (n("rejected")) bits.push(`${n("rejected")} refused`);
  if (n("ignored")) bits.push(`${n("ignored")} passed over`);
  return `${bits.join(", ")}.`;
}
