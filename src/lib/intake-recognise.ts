/**
 * What a document that just arrived actually is, how sure the site is, and why — in words.
 *
 * The inbox already had a recogniser: `classify()` in autoroute.ts, which reads a file's own
 * header row and returns one answer. It is good at what it does and it is deliberately narrow.
 * It never looks at who sent the message, what they called it, or what the same address sent last
 * Sunday, and it returns a single verdict with no notion of how confident it is. So a PDF it
 * cannot read comes back "unrecognised" with nothing else to go on, and an invoice from a supplier
 * whose last forty messages were invoices is treated exactly like a stranger's.
 *
 * This asks every detector the site already has, ranks the answers by how specific the evidence
 * is, and says what it thinks and why. Three rules shape the whole of it:
 *
 * 1. **Specificity decides.** A rule the owner taught, naming a sender *and* a fragment of the
 *    subject or file name, beats the columns; the columns beat a bare "everything from this
 *    address is an invoice"; a bare address rule beats what the sender happened to send before;
 *    and the file name and subject come last. This is what stops "everything from McKesson is an
 *    invoice" from turning McKesson's catalogue into an invoice.
 *
 * 2. **Only certainty may file.** A name and a subject line, however suggestive, are never enough
 *    on their own — nothing reaches `certain` on them. Anything short of certain is shown to the
 *    owner with the question, and nothing is written. A document filed on a guess goes somewhere
 *    wrong and goes there silently, which is worse than not filing it at all.
 *
 * 3. **A new category is one entry in a table, not a rewrite.** The list below is data. When the
 *    pharmacy starts receiving something nobody has thought of yet, it is a row.
 *
 * Nothing here reads the database or the file system: it takes the evidence it is given and
 * returns a judgement. `intake-recognise-store.ts` gathers the evidence.
 */

/** How sure the site is, in the only four words worth saying to somebody clearing an inbox. */
export type Sureness = "certain" | "likely" | "possible" | "unknown";

export type Category = {
  key: string;
  /** What the owner calls it. */
  label: string;
  /** What happens to it once it is placed, in one sentence, so the inbox can say. */
  handling: string;
  /**
   * The verdicts from the existing content detectors that mean this category.
   *
   * `autoroute.classify()` kinds, `contract-triage` kinds prefixed `triage:`, and
   * `classifySupplierDocument` kinds prefixed `supplier:`. Kept as strings rather than a union so
   * a detector can grow a verdict without this file having to know about it first.
   */
  fromContent?: string[];
  /** Words in a file name that point here. Suggestive, never sufficient. */
  fileNameHints?: RegExp;
  /** Words in a subject line that point here. Suggestive, never sufficient. */
  subjectHints?: RegExp;
};

/**
 * Everything the pharmacy receives, and what becomes of it.
 *
 * The owner's own list, in his order, with the ones the site already routes filled in around it.
 * `handling` is written for the inbox line: it is the sentence that tells him what pressing the
 * button will do.
 */
export const CATEGORIES: Category[] = [
  {
    key: "supplier_catalog",
    label: "A supplier's catalogue",
    handling: "Prices replace that supplier's price list, so what to buy and where is worked out from them.",
    fromContent: ["pioneer_catalog", "supplier_catalog"],
    fileNameHints: /catalog|price[_\s-]*list|item[_\s-]*search/i,
    subjectHints: /catalog|price[_\s-]*list/i,
  },
  {
    key: "supplier_invoice",
    label: "A supplier invoice",
    handling: "Filed as an invoice against the supplier — by schedule where it carries controlled substances — and counted as cost of goods.",
    fromContent: ["supplier:invoice"],
    fileNameHints: /invoice|\binv\b/i,
    subjectHints: /invoice|\binv\b/i,
  },
  {
    key: "expense_invoice",
    label: "A bill from a vendor",
    handling: "Filed as a draft expense behind the vendor it came from. Nothing counts on the month until the amount is confirmed.",
    fileNameHints: /\bbill\b|statement[_\s-]*of[_\s-]*account/i,
    subjectHints: /\byour bill\b|\bbill\b|amount due|past due/i,
  },
  {
    key: "claims_export",
    label: "A claims export",
    handling: "Claims are added to the claims table, duplicates ignored, and every figure re-checked by arithmetic before it is stored.",
    fromContent: ["claims"],
    fileNameHints: /claims?/i,
    subjectHints: /claims?[_\s-]*export/i,
  },
  {
    key: "rx_transactions",
    label: "The daily transaction report",
    handling: "Paid rows become claims, reversals cancel the claims they name, unsold rows wait for the day they sell.",
    fromContent: ["rx_transactions"],
    subjectHints: /rx transaction/i,
  },
  {
    key: "payer_payments",
    label: "A payer payment report",
    handling: "Banked as cash received in the month it was deposited, once per payment number.",
    fromContent: ["payer_payments"],
    subjectHints: /payment (report|detail)/i,
  },
  {
    key: "remittance",
    label: "A remittance from a plan or facilitator",
    handling: "Posted against the claims it names, so what was paid can be set beside what was owed.",
    /*
     * `x12:remittance` is the envelope test in `intake-recognise-store.ts`; `remittance_835` is the
     * routing kind `classify()` will return once the posting side lands (BACKLOG 27). Both are here
     * so the category needs no edit on the day that happens.
     */
    fromContent: ["x12:remittance", "remittance_835"],
    fileNameHints: /remit|835|\bera\b/i,
    subjectHints: /remittance|remit advice|\b835\b/i,
  },
  {
    key: "nadac",
    label: "A NADAC price file",
    handling: "Loaded as the national average acquisition cost for the week it covers — the floor every Kansas commercial claim is measured against.",
    fromContent: ["nadac"],
    fileNameHints: /nadac/i,
    subjectHints: /nadac/i,
  },
  {
    key: "contract",
    label: "A reimbursement contract or rate sheet",
    handling: "Read for its rates and its terms, which is what makes a claim's payment predictable and an appeal arguable.",
    fromContent: ["triage:contract", "triage:rate_sheet"],
    fileNameHints: /contract|agreement|rate[_\s-]*sheet|amendment|addend/i,
    subjectHints: /contract|agreement|rate sheet|amendment|network (participation|agreement)/i,
  },
  {
    key: "compliance_document",
    label: "An employee or pharmacy compliance document",
    handling: "Filed against the person or the pharmacy, with the date it expires, so the wall chart is right without anybody checking.",
    fileNameHints: /cpr|license|licence|registration|certificat|immuniz|protocol/i,
    subjectHints: /cpr|license|licence|renewal|certificat|immuniz/i,
  },
  {
    key: "era_enrollment",
    label: "An ERA enrolment",
    handling: "Kept as sent, beside the payer it was sent to, so what is outstanding is a list rather than a memory.",
    fileNameHints: /era[_\s-]*enroll/i,
    subjectHints: /era enrol|electronic remittance/i,
  },
  {
    key: "appeal",
    label: "An appeal or a floor complaint",
    handling: "Filed against the claim it argues, with what was said and when, so a second one can be built on the first.",
    fileNameHints: /appeal|complaint/i,
    subjectHints: /appeal|\bmac\b.*(appeal|review)|below cost/i,
  },
  {
    key: "rebate_report",
    label: "A rebate breakdown",
    handling: "Read for the tier ladder and the rate the month was actually paid at.",
    fromContent: ["rebate_report", "supplier:rebate_report"],
    fileNameHints: /rebate/i,
    subjectHints: /rebate/i,
  },
  {
    key: "purchase_report",
    label: "A purchase drill down",
    handling: "Read for the compliance ratio and the OneStop share every rebate band turns on.",
    fromContent: ["purchase_drilldown", "supplier:purchase_report"],
    fileNameHints: /drill[_\s-]*down/i,
  },
  {
    key: "supplier_statement",
    label: "A supplier statement",
    handling: "Filed as a document behind the supplier. It summarises invoices rather than being one, so nothing is counted twice.",
    fromContent: ["supplier:statement"],
    fileNameHints: /statement/i,
    subjectHints: /statement/i,
  },
  {
    key: "credit_memo",
    label: "A credit memo",
    handling: "Applied to the fills or the invoice it names, so money coming back is not left out of the month.",
    fromContent: ["rxrescue_credit", "supplier:credit_memo"],
    fileNameHints: /credit/i,
    subjectHints: /credit memo|credit note/i,
  },
  {
    key: "sales_summary",
    label: "The month's sales summary",
    handling: "The whole till for a month — retail beside prescriptions — which is the only report that says what the pharmacy took.",
    fromContent: ["accrual_sales"],
    fileNameHints: /sales/i,
    subjectHints: /system sales|sales summary/i,
  },
  {
    key: "inventory_count",
    label: "An inventory count",
    handling: "Filed as the count for its own date, replacing any earlier upload for that day.",
    fromContent: ["on_hand"],
    fileNameHints: /on[_\s-]*hand|inventory/i,
    subjectHints: /inventory|on hand/i,
  },
  {
    key: "bank_statement",
    label: "A bank statement",
    handling: "Read line by line: deposits banked, bills and invoices marked paid, every line remembered.",
    fileNameHints: /bank|statement.*\d{4}/i,
    subjectHints: /bank statement|account statement/i,
  },
  {
    key: "return_policy",
    label: "A returned goods policy",
    handling: "Read against the supplier it came from, so what can be sent back and by when is on the page rather than in a drawer.",
    fromContent: ["return_policy"],
    fileNameHints: /return(ed)?[_\s-]*goods|returns?[_\s-]*polic/i,
  },
];

const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

export function categoryFor(key: string): Category | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * A rule the owner taught by correcting a guess.
 *
 * `address` is matched as a fragment of the sending address, so it holds either a whole address or
 * a domain. `subject` and `fileName` are optional fragments that narrow it — and narrowing is what
 * makes a rule trustworthy enough to beat the file's own columns.
 */
export type SenderRule = {
  address: string;
  category: string;
  subject?: string | null;
  fileName?: string | null;
};

/** What the sender has actually sent before, and how often. Never circular: only placed documents count. */
export type SenderHistory = { category: string; count: number };

export type Evidence = {
  fromAddress?: string | null;
  fromName?: string | null;
  subject?: string | null;
  fileName?: string | null;
  /** What the content detectors made of the bytes. `null` when nothing could read them. */
  content?: { verdict: string; why: string; headers?: string[] } | null;
  rules?: SenderRule[];
  history?: SenderHistory[];
};

export type Guess = {
  category: string;
  label: string;
  handling: string;
  sure: Sureness;
  /** Only for ordering and for the tests; the inbox shows `sure` and `why`. */
  score: number;
  /** Every piece of evidence that pointed here, each a sentence. */
  why: string[];
  /**
   * The strength of the single strongest thing that pointed here, before corroboration.
   *
   * Kept because a tie between two answers is only a real tie when they came from the same rung of
   * the ladder. A rule the owner wrote beating a header sniff is not a contested verdict, it is the
   * correction working.
   */
  tier: number;
};

export type Recognition = {
  /** The leading guess, or null when nothing pointed anywhere at all. */
  best: Guess | null;
  /** Every category anything pointed at, most likely first. */
  ranked: Guess[];
  /** Whether this may be filed without asking. True only when the best guess is certain and alone. */
  mayFile: boolean;
  /** Whether the owner has to say what it is. The mirror of `mayFile`. */
  needsOwner: boolean;
  /** One sentence for the inbox line, in the words somebody clearing an inbox would use. */
  says: string;
};

/*
 * The specificity ladder, as numbers.
 *
 * The gaps matter more than the values. TAUGHT_NARROW is above CONTENT because a rule the owner
 * wrote naming both a sender and a fragment is a deliberate correction of exactly this case, and a
 * correction that loses to a header sniff has to be made again every week — which is the thing
 * BACKLOG item 5 exists to stop. CONTENT is above TAUGHT_BROAD because "everything from this
 * address is an invoice" is a habit, not a fact, and their catalogue is not an invoice. And the
 * three below CONTENT are all beneath CERTAIN on purpose: nothing is ever filed on a name.
 */
const TAUGHT_NARROW_BOTH = 100;
const TAUGHT_NARROW = 90;
const CONTENT = 80;
const TAUGHT_BROAD = 60;
const HISTORY = 40;
const FILE_NAME = 25;
const SUBJECT = 20;
const SENDER_NAME = 15;

/** The score at or above which a guess is certain, and may be acted on unasked. */
export const CERTAIN_AT = CONTENT;
const LIKELY_AT = HISTORY;
const POSSIBLE_AT = SENDER_NAME;

/** Corroboration is worth a little and never enough to promote a name into a certainty. */
const CORROBORATION = 5;
const CORROBORATION_CAP = 10;

function bandOf(score: number): Sureness {
  if (score >= CERTAIN_AT) return "certain";
  if (score >= LIKELY_AT) return "likely";
  if (score >= POSSIBLE_AT) return "possible";
  return "unknown";
}

const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();

/** Whether a taught fragment appears in the text it was taught against. Empty fragments never match. */
function fragmentHits(fragment: string | null | undefined, text: string): boolean {
  const f = (fragment ?? "").trim().toLowerCase();
  return f.length > 0 && text.includes(f);
}

type Signal = { score: number; why: string };

/**
 * What the site thinks this document is.
 *
 * Every signal is collected per category, the strongest one decides that category's score, and
 * agreement between signals adds a little on top. The categories are then ranked; the leader may
 * file only if it is certain and nothing else is.
 */
export function recognise(ev: Evidence): Recognition {
  const signals = new Map<string, Signal[]>();
  const add = (category: string, score: number, why: string) => {
    if (!BY_KEY.has(category)) return; // A rule naming a category nobody kept is silently ignored.
    const list = signals.get(category) ?? [];
    list.push({ score, why });
    signals.set(category, list);
  };

  const from = lower(ev.fromAddress);
  const subject = lower(ev.subject);
  const fileName = lower(ev.fileName);
  const senderName = lower(ev.fromName);

  /* 1. Rules the owner taught, strongest first. */
  for (const r of ev.rules ?? []) {
    const addr = lower(r.address).trim();
    if (!addr || !from.includes(addr)) continue;
    const wantsSubject = Boolean((r.subject ?? "").trim());
    const wantsFile = Boolean((r.fileName ?? "").trim());
    const subjectHit = fragmentHits(r.subject, subject);
    const fileHit = fragmentHits(r.fileName, fileName);
    if (wantsSubject && !subjectHit) continue;
    if (wantsFile && !fileHit) continue;
    if (wantsSubject && wantsFile) {
      add(r.category, TAUGHT_NARROW_BOTH, `You said that mail from ${addr} with “${r.subject}” in the subject and “${r.fileName}” in the file name is this.`);
    } else if (wantsSubject) {
      add(r.category, TAUGHT_NARROW, `You said that mail from ${addr} with “${r.subject}” in the subject is this.`);
    } else if (wantsFile) {
      add(r.category, TAUGHT_NARROW, `You said that a file from ${addr} named like “${r.fileName}” is this.`);
    } else {
      add(r.category, TAUGHT_BROAD, `You said that mail from ${addr} is this.`);
    }
  }

  /* 2. What the file's own contents say. */
  if (ev.content && ev.content.verdict && ev.content.verdict !== "unrecognised") {
    for (const c of CATEGORIES) {
      if (c.fromContent?.includes(ev.content.verdict)) add(c.key, CONTENT, ev.content.why || `The file reads as ${c.label.toLowerCase()}.`);
    }
  }

  /* 3. What this sender has sent before — only what was actually placed, so it cannot feed on itself. */
  for (const h of ev.history ?? []) {
    if (h.count < 3) continue; // Two is a coincidence.
    add(h.category, HISTORY, `The last ${h.count} files from this address were ${(categoryFor(h.category)?.label ?? h.category).toLowerCase()}.`);
  }

  /* 4. The name, the subject and who it says it is from. Suggestive; never sufficient. */
  for (const c of CATEGORIES) {
    if (fileName && c.fileNameHints?.test(fileName)) add(c.key, FILE_NAME, `The file is named like ${c.label.toLowerCase()}.`);
    if (subject && c.subjectHints?.test(subject)) add(c.key, SUBJECT, `The subject reads like ${c.label.toLowerCase()}.`);
    if (senderName && c.subjectHints?.test(senderName)) add(c.key, SENDER_NAME, `The sender's name reads like ${c.label.toLowerCase()}.`);
  }

  const ranked: Guess[] = [];
  for (const [key, list] of signals) {
    const c = BY_KEY.get(key)!;
    const sorted = [...list].sort((a, b) => b.score - a.score);
    const top = sorted[0]!;
    const bonus = Math.min((sorted.length - 1) * CORROBORATION, CORROBORATION_CAP);
    const score = top.score + bonus;
    ranked.push({
      category: key,
      label: c.label,
      handling: c.handling,
      score,
      tier: top.score,
      sure: bandOf(score),
      why: sorted.map((s) => s.why),
    });
  }
  ranked.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));

  const best = ranked[0] ?? null;
  const runnerUp = ranked[1] ?? null;

  /*
   * Two certainties of equal standing are not a certainty.
   *
   * When two answers of the same strength both fire — two content detectors, or two rules written
   * with the same degree of care — the leader is demoted and the question goes to the owner rather
   * than a coin being tossed. Filing the wrong one writes into the tables everything else reads,
   * unattended, overnight.
   *
   * Deliberately *not* a tie when the two came from different rungs. A rule the owner wrote naming
   * a sender and a fragment of the file name outranking what the columns said is the correction
   * doing its job: he wrote it precisely because the columns were read wrong last week, and a
   * correction that has to be made again every Sunday is not a correction.
   */
  let contested = false;
  if (best && runnerUp && bandOf(runnerUp.score) === "certain" && runnerUp.tier === best.tier) {
    contested = true;
    best.sure = "likely";
    best.why.push(`It could also be ${runnerUp.label.toLowerCase()}, so nothing was filed on it.`);
  }

  const mayFile = Boolean(best && best.sure === "certain");
  return {
    best,
    ranked,
    mayFile,
    needsOwner: !mayFile,
    says: sentence(best, runnerUp, contested, ev),
  };
}

/** The inbox line, in the words somebody clearing an inbox would use. */
function sentence(best: Guess | null, runnerUp: Guess | null, contested: boolean, ev: Evidence): string {
  if (!best) {
    const because = ev.content?.why ? ` ${ev.content.why}` : "";
    return `This does not look like anything the site knows.${because} Tell it what it is and it will remember for this sender.`;
  }
  const why = best.why[0] ?? "";
  if (best.sure === "certain") return `${best.label}. ${why} ${best.handling}`.trim();
  if (contested && runnerUp) {
    return `This is either ${best.label.toLowerCase()} or ${runnerUp.label.toLowerCase()} and the evidence is split, so nothing was filed. Say which it is.`;
  }
  const hedge = best.sure === "likely" ? "Probably" : "Possibly";
  return `${hedge} ${best.label.toLowerCase()}. ${why} Not sure enough to file it, so nothing has been — say what it is and it will be remembered for this sender.`;
}

/**
 * The rule to keep when the owner says what a document really was.
 *
 * The point is that next week needs no correcting, and the shape of the rule decides whether that
 * works. A bare address rule is right when everything from that address is the same thing — a
 * NADAC feed, a claims export. It is wrong when a supplier sends invoices and catalogues from one
 * address, and the way to tell is that the file's own columns already said something different:
 * in that case the rule is narrowed to the part of the file name that is stable, so the correction
 * applies to these files and not to everything the supplier ever sends.
 */
export function ruleFromCorrection(input: {
  fromAddress: string;
  category: string;
  fileName?: string | null;
  subject?: string | null;
  /** What the recogniser had thought, if anything. */
  wrongCategory?: string | null;
  /** Whether the file's own contents pointed somewhere else. */
  contentDisagreed?: boolean;
}): SenderRule | null {
  const address = lower(input.fromAddress).trim();
  if (!address || !BY_KEY.has(input.category)) return null;
  if (!input.contentDisagreed) return { address, category: input.category, subject: null, fileName: null };
  const stem = stableStem(input.fileName ?? "");
  if (stem) return { address, category: input.category, subject: null, fileName: stem };
  const subject = stableStem(input.subject ?? "");
  if (subject) return { address, category: input.category, subject, fileName: null };
  return { address, category: input.category, subject: null, fileName: null };
}

/**
 * The part of a name that will be the same next week.
 *
 * Scheduled reports are named for their run date — "McKesson Invoices 2026-09-08.csv" — so the
 * whole name matches once and never again. Dates, long digit runs and the extension come off; what
 * is left is the part a rule can be written against.
 */
export function stableStem(name: string): string {
  const stem = name
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/\d{4}[-_]?\d{2}[-_]?\d{2}/g, " ")
    .replace(/\d{1,2}[-_/]\d{1,2}[-_/]\d{2,4}/g, " ")
    .replace(/\d{3,}/g, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
  return stem.length >= 3 ? stem : "";
}
