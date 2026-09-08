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
  /** Wholesalers on the register: whether each has a minimum and a rebate ladder on file. */
  suppliers: { name: string; primary: boolean; hasMinimum: boolean; hasLadder: boolean; hasTermsPage: string }[];
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
  /** Contract documents: how many are in the folder, how many have been read. */
  contracts: { total: number; read: number };
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

  if (input.contracts.total > 0) {
    add({
      key: "contracts",
      title: "Read the payer contracts in the folder",
      rank: "sharpens",
      done: input.contracts.read >= input.contracts.total,
      why: "A contract read once gives the site the rate it promised, so an underpayment is arithmetic against a document rather than a suspicion.",
      detail: `${input.contracts.read} of ${input.contracts.total} read.`,
      href: "/payers/contracts",
      action: "Read them",
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

  for (const s of input.suppliers.filter((x) => !x.primary && !x.hasMinimum)) {
    add({
      key: `minimum-${s.name}`,
      title: `Put ${s.name}'s order minimum on file`,
      rank: "stops",
      done: false,
      why: "Without the minimum there is nothing for the add-on list to count towards, so that wholesaler gets no card on the Buying page.",
      detail: "No minimum on file.",
      href: s.hasTermsPage,
      action: "Enter the minimum",
      minutes: 2,
      area: "buying",
    });
  }

  for (const s of input.suppliers.filter((x) => !x.hasLadder)) {
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

/** The list as the page shows it: what is left first, by rank then by how quick it is. */
export function ranked(items: SetupItem[]): { left: SetupItem[]; done: SetupItem[]; minutesLeft: number; progress: number } {
  const left = items
    .filter((i) => !i.done)
    .sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank] || a.minutes - b.minutes || a.title.localeCompare(b.title));
  const done = items.filter((i) => i.done);
  return {
    left,
    done,
    minutesLeft: left.reduce((n, i) => n + i.minutes, 0),
    progress: items.length === 0 ? 1 : done.length / items.length,
  };
}

/** How many of the things that stop something are still open — the figure Today leads with. */
export function stopsCount(items: SetupItem[]): number {
  return items.filter((i) => !i.done && i.rank === "stops").length;
}
