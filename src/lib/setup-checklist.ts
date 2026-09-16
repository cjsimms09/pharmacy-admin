/**
 * What the site still needs from the owner, in one list, ranked by what it costs to leave undone.
 *
 * The owner: "I'm getting overwhelmed about what I need to do to get the site complete and
 * accurate." Every page already says what it is missing, which is the problem: the answer is
 * spread over forty screens, and nobody can hold forty screens in their head. So this is one
 * list, and it is the only list — each item says what is missing, what stops working without it,
 * how long it takes, and the one place to go and do it.
 *
 * Three ranks, and the rank is the reason rather than a guess at importance:
 *
 *   **stops** — something is wrong or silently absent because of this. A figure is missing, a feed
 *     is not arriving, a claim cannot be judged. These come first, always.
 *   **sharpens** — everything works, but a figure is an estimate or a comparison is on gross
 *     rather than net. Doing it makes the site right rather than approximately right.
 *   **later** — worth having, nothing waits on it.
 *
 * Nothing here is invented: an item exists only where a table, a setting or a feed can be checked,
 * and "done" means the check passed, never that somebody ticked a box. Pure; `setup-store.ts`
 * gathers what it reads.
 */

export type SetupRank = "stops" | "sharpens" | "later";

export type SetupItem = {
  key: string;
  /** What to do, in the imperative: "Classify the plans your claims come from". */
  title: string;
  rank: SetupRank;
  done: boolean;
  /** What does not work until it is done. One sentence, concrete. */
  why: string;
  /** Where the state stands right now: "34 of 51 plans decided". Empty where there is nothing to count. */
  detail: string;
  /** Where to go and do it. */
  href: string;
  /** The words on the button. */
  action: string;
  /** Roughly how long, so a spare ten minutes can be spent well. */
  minutes: number;
  /** Which part of the business it belongs to, for grouping. */
  area: "connections" | "buying" | "claims" | "money" | "compliance";
  /**
   * Set aside by the pharmacy as not applying to it, with the reason and who said so.
   *
   * A third answer, and the one the list never had. Every item says "something is wrong until this
   * is done", which is true of a missing order minimum and untrue of an order minimum for a
   * wholesaler he does not buy from — and with no way to say the second, forty-five of those
   * accumulated. The cost is not the noise. It is that the list stops being read, and the items
   * that do stop something go unread with them.
   *
   * It is emphatically not `done`: nothing was completed and no check passed. A dismissed item is
   * shown on the page behind its own count and comes back with one press, because a decision that
   * cannot be undone is the worse half of "nothing ships without the means to correct it".
   */
  notApplicable?: { reason: string; at: string; by: string } | null;
};

export type SetupInput = {
  /** Whether the Claude API key is stored. */
  aiReady: boolean;
  /** The mailbox: reachable, sweeping, and filing what arrives. */
  mail: { configured: boolean; enabled: boolean; autoImport: boolean };
  /** Feeds that should arrive on a cadence: name, and whether the newest row is recent enough. */
  feeds: { key: string; label: string; state: "ok" | "late" | "never" | "off"; says: string; href: string }[];
  /** Background jobs and whether each has run. */
  jobs: { key: string; label: string; state: "ok" | "stale" | "never" | "off"; href: string }[];
  /** The plan register: how many plans the claims name, and how many are classified. */
  plans: { total: number; decided: number; claimsUndecided: number };
  /** The newest shelf count, and how old it is in days. */
  shelf: { countedOn: string | null; ageDays: number | null };
  /** Wholesalers on the register, and whether each has a rebate ladder on file. Order minimums are not asked for. */
  suppliers: { name: string; primary: boolean; hasLadder: boolean; hasTermsPage: string; /** Whether anything of theirs is on the site at all: a catalogue, an invoice or a delivery. A supplier with none has no prices to compare. */ trades: boolean }[];
  /** Standing monthly costs entered (payroll, rent, the loan). */
  standingCosts: number;
  /** Bills entered in the last ninety days. */
  billsRecent: number;
  /** The federal benchmark. */
  nadac: { state: "none" | "current" | "behind"; says: string };
  /** The pharmacy's own details, for the forms it prints. */
  identity: { missing: string[] };
  /** Claims: how many fills carry the basis-of-reimbursement code, of how many. */
  claims: { fills: number; withBasis: number };
  /** The FDA drug directory: rows held. */
  directoryRows: number;
  /** The Kansas Medicaid dispensing fee, entered or not. */
  ksFeeEntered: boolean;
  /**
   * The contract folder, counted by the work rather than by the filename.
   *
   * "worthReading" leaves out the documents the triage has judged not to be contracts — reading one
   * of those tells nobody anything, and a denominator that includes them flatters the position. The
   * page figures are there because 219 documents at 3.9 pages and 187 at 30.6 are not the same job,
   * and the fraction says they are. "modelStopped" because the button cannot work while the model
   * is over its monthly ceiling.
   */
  contracts: { total: number; read: number; worthReading: number; pagesLeft: number; pagesRead: number; modelStopped: boolean };
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function setupItems(input: SetupInput): SetupItem[] {
  const out: SetupItem[] = [];
  const add = (i: SetupItem) => out.push(i);

  /* ── Connections: nothing arrives without these ── */

  add({
    key: "ai-key",
    title: "Add the Claude API key",
    rank: "stops",
    done: input.aiReady,
    why: "Without it no dropped document is read: every invoice, remittance and contract has to be typed in by hand.",
    detail: input.aiReady ? "Stored." : "Not stored.",
    href: "/settings/connections",
    action: "Add the key",
    minutes: 5,
    area: "connections",
  });

  add({
    key: "mailbox",
    title: "Connect the mailbox and let it file what arrives",
    rank: "stops",
    done: input.mail.configured && input.mail.enabled && input.mail.autoImport,
    why: "The daily report, the Monday catalogues and the 835s arrive by email. Until the mailbox is on, every one of them is a file somebody has to remember to upload.",
    detail: !input.mail.configured
      ? "No mailbox is set up."
      : !input.mail.enabled
        ? "Set up, but not being checked."
        : !input.mail.autoImport
          ? "Checked, but arrivals are not loaded on their own."
          : "Connected, checked and loading.",
    href: "/settings/email",
    action: "Set up email",
    minutes: 10,
    area: "connections",
  });

  for (const f of input.feeds.filter((x) => x.state !== "ok")) {
    add({
      key: `feed-${f.key}`,
      title: `Get ${f.label} arriving`,
      rank: f.state === "off" ? "later" : "stops",
      done: false,
      why: "Every figure drawn from this feed is out of date or missing while it is not arriving.",
      detail: f.says,
      href: f.href,
      action: "Look at it",
      minutes: 10,
      area: "connections",
    });
  }

  for (const j of input.jobs.filter((x) => x.state === "never" || x.state === "off")) {
    add({
      key: `job-${j.key}`,
      title: `Turn on ${j.label}`,
      rank: "later",
      done: false,
      why: "It is a job the site would do by itself; while it is off, it is a job for a person.",
      detail: j.state === "never" ? "Has never run." : "Switched off.",
      href: j.href,
      action: "Turn it on",
      minutes: 5,
      area: "connections",
    });
  }

  /* ── Claims: what makes a payment judgeable ── */

  add({
    key: "plans",
    title: "Say what kind of plan each payer is",
    rank: "stops",
    done: input.plans.total > 0 && input.plans.decided === input.plans.total,
    why: "The Kansas floor only reaches some plans, and a claim on an unclassified plan cannot be called underpaid, appealed, or priced by the law. It is the single thing the most figures wait on.",
    detail:
      input.plans.total === 0
        ? "No claims are held yet, so there are no plans to classify."
        : `${input.plans.decided} of ${input.plans.total} decided${input.plans.claimsUndecided > 0 ? `; ${plural(input.plans.claimsUndecided, "claim")} on the rest` : ""}.`,
    href: "/plans",
    action: "Classify the plans",
    minutes: 30,
    area: "claims",
  });

  add({
    key: "ks-fee",
    title: "Enter the Kansas Medicaid dispensing fee",
    rank: "sharpens",
    done: input.ksFeeEntered,
    why: "The floor is NADAC plus the greater of $10.50 and this fee. Without it the site uses $10.50, which understates the floor if the state fee is higher.",
    detail: input.ksFeeEntered ? "Entered." : "Not entered; $10.50 is being used.",
    href: "/settings",
    action: "Enter the fee",
    minutes: 2,
    area: "claims",
  });

  add({
    key: "basis-column",
    title: "Add the four missing columns to the PioneerRx daily report",
    rank: "sharpens",
    done: input.claims.fills > 0 && input.claims.withBasis / Math.max(1, input.claims.fills) >= 0.8,
    why: "Basis of Reimbursement (522-FM), Dispensed AWP, Usual and Customary, and DAW. With them the site knows how each claim was priced instead of working it out from the money; every NDC recommendation on a non-floor plan sharpens.",
    detail:
      input.claims.fills === 0
        ? "No claims are held yet."
        : input.claims.withBasis === 0
          ? "No fill carries the basis code today."
          : `${Math.round((100 * input.claims.withBasis) / input.claims.fills)}% of fills carry it.`,
    href: "/reports",
    action: "See what the report needs",
    minutes: 15,
    area: "claims",
  });

  /*
   * ── The contracts, counted by the work rather than by the filename ──
   *
   * This said "219 of 406 read", which sounds a little over half done. Measured on 16 September
   * 2026 it is nothing like half.
   *
   * Twenty-nine of the 406 are documents the triage has already judged not to be contracts at all.
   * They are in the denominator of a row asking him to read them, and reading them would tell him
   * nothing, because the site has already decided there is nothing in them.
   *
   * And the count hides the size. The 219 already read average 3.9 pages; the ones left average
   * 30.6, and the 25 that failed average 51.8, one of them 256 pages. By documents it reads as 54%
   * done. By pages it is 698 of 6,944 — about a tenth. The reader has done the short ones and left
   * the long ones, which is exactly what one would expect and exactly what the fraction conceals.
   * A number whose denominator flatters the position is the fault this file has carried three times
   * this week; this is the fourth.
   *
   * The last part is the gate. Reading a contract costs money at the model, and the model stops at
   * the monthly ceiling — which it has. Until that is raised, pressing the button on this row does
   * nothing at all, and a row that asks for work the system will refuse teaches that the list lies.
   */
  if (input.contracts.worthReading > 0) {
    const left = Math.max(0, input.contracts.worthReading - input.contracts.read);
    const skipped = input.contracts.total - input.contracts.worthReading;
    add({
      key: "contracts",
      title: "Read the payer contracts in the folder",
      rank: "sharpens",
      done: input.contracts.read >= input.contracts.worthReading,
      why: "A contract read once gives the site the rate it promised, so an underpayment is arithmetic against a document rather than a suspicion.",
      detail: [
        `${input.contracts.read} of ${input.contracts.worthReading} read`,
        left > 0 && input.contracts.pagesLeft > 0
          ? `; the ${left} left run to ${input.contracts.pagesLeft.toLocaleString()} pages, against ${input.contracts.pagesRead.toLocaleString()} for the ones already done`
          : "",
        skipped > 0 ? `. ${skipped} more are not counted: the triage judged them not to be contracts` : "",
        input.contracts.modelStopped
          ? ". Claude has stopped at the monthly ceiling, so this cannot run until the ceiling is raised"
          : "",
        ".",
      ]
        .filter(Boolean)
        .join(""),
      href: "/payers/contracts",
      action: input.contracts.modelStopped ? "Raise the ceiling first" : "Read them",
      minutes: 20,
      area: "claims",
    });
  }

  /* ── Buying: what the order and the comparison rest on ── */

  add({
    key: "shelf-count",
    title: "Upload a shelf count",
    rank: "stops",
    done: input.shelf.countedOn !== null && (input.shelf.ageDays ?? 999) <= 14,
    why: "Without a recent count the site cannot tell a shortage from a full shelf, so nothing can be ordered, and surplus stock cannot be sent back.",
    detail:
      input.shelf.countedOn === null
        ? "No count has ever been uploaded."
        : `Last counted ${input.shelf.countedOn}${input.shelf.ageDays !== null ? `, ${plural(input.shelf.ageDays, "day")} ago` : ""}.`,
    href: "/purchasing/shelf",
    action: "Upload the count",
    minutes: 10,
    area: "buying",
  });

  /*
   * ── Order minimums are not asked for ──
   *
   * This produced one "stops" item per wholesaler without a minimum — eleven of them — saying
   * "Without the minimum there is nothing for the add-on list to count towards, so that wholesaler
   * gets no card on the Buying page."
   *
   * Every part of that was wrong, and it had been wrong since before it was written.
   *
   * The owner, 8 September: "I don't want to set minimums.. more want system to decide next best
   * things to order from that supplier based on days left on hand, price, etc." `fillToMinimums`
   * has honoured that from the start — a supplier with no minimum gets its full ranked add-on list
   * and says so in as many words: "no order minimum on file, so nothing is filled to a target: this
   * is the next best to order here, ranked by days left on the shelf and by price against the
   * field." The Buying page renders exactly that card. So the wholesaler was never missing from the
   * page, and nothing was waiting on the figure.
   *
   * And the owner again, 16 September, asked directly whether the unset ones have no minimum or are
   * simply not bought from: "for all the suppliers i havent set, there is no minimum." So an empty
   * minimum is an answer — measured and none — and not a gap. There is nothing here to ask for.
   *
   * Eleven rows at the rank that means something is broken, demanding a figure that changes
   * nothing, on a justification the code contradicts, against a decision he had already given.
   * A wholesaler that does impose one is served by entering it on the supplier's terms page, which
   * is where it has always gone.
   */

  /*
   * A ladder is asked for only where there are prices of theirs to compare.
   *
   * The row says: "Their prices are compared gross while the ladder is missing, which makes them
   * look dearer than they are and can send an order to the wrong wholesaler." That is true, and
   * worth acting on, for a wholesaler whose catalogue is in the comparison. It is empty of one with
   * no catalogue, no invoice and no delivery on the whole site: there are no prices of theirs to
   * compare, gross or net, so no order can be sent anywhere by the lack of a rate.
   *
   * Measured 16 September 2026: of the fourteen asked for, eight were suppliers with nothing at all
   * on file — 0 catalogue items, 0 invoices, 0 deliveries — and every one of those eight is a
   * supplier the owner has already said he buys from on their PioneerRx receipt. The other six
   * trade, and for them the sentence is true and the row stays.
   *
   * The third row of this exact shape, after the order minimums and the price files: a list item
   * asserting a consequence that cannot occur, kept alive by a condition that never asked whether
   * it could. The condition is now the consequence itself. Nothing is hidden — a supplier that
   * starts trading gets the row back on the next page load, because it is decided from the data.
   */
  for (const s of input.suppliers.filter((x) => !x.hasLadder && x.trades)) {
    add({
      key: `ladder-${s.name}`,
      title: `Enter ${s.name}'s rebate ladder`,
      rank: "sharpens",
      done: false,
      why: "Their prices are compared gross while the ladder is missing, which makes them look dearer than they are and can send an order to the wrong wholesaler.",
      detail: "No rebate rate on file.",
      href: s.hasTermsPage,
      action: "Enter the ladder",
      minutes: 10,
      area: "buying",
    });
  }

  add({
    key: "nadac",
    title: "Load the federal benchmark (NADAC)",
    rank: "stops",
    done: input.nadac.state === "current",
    why: "NADAC is what the floor pays and what every price is measured against. Without it nothing can be called cheap, dear, or underpaid.",
    detail: input.nadac.says,
    href: "/nadac",
    action: "Fetch it",
    minutes: 2,
    area: "buying",
  });

  add({
    key: "directory",
    title: "Load the FDA drug directory",
    rank: "later",
    done: input.directoryRows > 0,
    why: "It says which NDCs are genuinely the same drug, so a switch is between equivalents rather than between things that sound alike. Until it is loaded the site groups on NADAC's description.",
    detail: input.directoryRows > 0 ? `${plural(input.directoryRows, "package")} held.` : "Not loaded.",
    href: "/nadac",
    action: "Load it",
    minutes: 5,
    area: "buying",
  });

  /* ── Money: what the books cannot state without ── */

  add({
    key: "standing-costs",
    title: "Enter the standing monthly costs",
    rank: "stops",
    done: input.standingCosts > 0,
    why: "Payroll, rent and the loan are the largest costs a pharmacy has. Until they are entered, every profit figure on the site is too high — and looks like good news.",
    detail: input.standingCosts > 0 ? `${plural(input.standingCosts, "cost")} entered.` : "None entered.",
    href: "/expenses",
    action: "Enter them",
    minutes: 15,
    area: "money",
  });

  add({
    key: "bills",
    title: "File the bills as they arrive",
    rank: "sharpens",
    done: input.billsRecent > 0,
    why: "A month with no bills in it reports a profit nobody made. Photograph each one on the day it comes and the books stay true without an evening of typing.",
    detail: input.billsRecent > 0 ? `${plural(input.billsRecent, "bill")} in the last ninety days.` : "None in the last ninety days.",
    href: "/intake",
    action: "Add a bill",
    minutes: 2,
    area: "money",
  });

  /* ── Compliance: what a form cannot be printed without ── */

  if (input.identity.missing.length > 0) {
    add({
      key: "identity",
      title: "Fill in the pharmacy's own details",
      rank: "stops",
      done: false,
      why: "Every Board form the site prints carries these. A form with a blank where the registration number belongs is a finding at an inspection.",
      detail: `Missing: ${input.identity.missing.join(", ")}.`,
      href: "/settings",
      action: "Fill them in",
      minutes: 5,
      area: "compliance",
    });
  }

  return out;
}

const RANK_ORDER: Record<SetupRank, number> = { stops: 0, sharpens: 1, later: 2 };

/**
 * The list as the page shows it: what is left first, by rank then by how quick it is.
 *
 * Three piles, not two. An item set aside is neither left nor done — calling it done would claim a
 * check passed, and leaving it in `left` is the thing he asked to stop. It gets its own pile, its
 * own count, and a press that puts it back.
 *
 * `progress` counts the dismissed as settled, because they are: they are questions with an answer,
 * and a bar that can never reach the end while a wholesaler he does not use has no rebate ladder
 * is a bar that measures the wrong thing.
 */
export function ranked(items: SetupItem[]): {
  left: SetupItem[];
  done: SetupItem[];
  notApplicable: SetupItem[];
  minutesLeft: number;
  progress: number;
} {
  const notApplicable = items.filter((i) => !i.done && i.notApplicable).sort((a, b) => a.title.localeCompare(b.title));
  const left = items
    .filter((i) => !i.done && !i.notApplicable)
    .sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank] || a.minutes - b.minutes || a.title.localeCompare(b.title));
  const done = items.filter((i) => i.done);
  return {
    left,
    done,
    notApplicable,
    minutesLeft: left.reduce((n, i) => n + i.minutes, 0),
    progress: items.length === 0 ? 1 : (done.length + notApplicable.length) / items.length,
  };
}

/**
 * How many of the things that stop something are still open — the figure Today leads with.
 *
 * Set-aside items are not counted. That number is the one that makes him open the list, so it has
 * to mean "things that stop something and that you have not already answered"; counting answered
 * ones would put the badge permanently on a number he cannot move.
 */
export function stopsCount(items: SetupItem[]): number {
  return items.filter((i) => !i.done && !i.notApplicable && i.rank === "stops").length;
}
