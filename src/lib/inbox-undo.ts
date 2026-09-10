/**
 * What a load left behind, and whether pressing anything can take it back.
 *
 * The owner, asked which of the things that can go wrong worries him most, chose: "It filed
 * something as the wrong kind of document." Re-routing loads it correctly. It does not remove what
 * the wrong reading already wrote, and until now the screen said so in one vague sentence for all
 * fourteen kinds — which is the same as saying nothing, because the answer is completely different
 * depending on what it was read as.
 *
 * A catalogue misread costs nothing: tomorrow's catalogue reprices the same NDCs over the top of
 * it. A remittance misread puts money in the bank account and against fills. Those two facts want
 * two different sentences, and a person deciding whether to worry needs the right one.
 *
 * ── The four answers ──
 *
 *   nothing     it proposes and stores nothing, so there is nothing to take back
 *   replaced    the next correct file of the same kind writes over it, on its own
 *   removable   the site knows which rows it wrote and can delete them
 *   kept        it stays until a person deals with it, and this says where
 *
 * Every sentence below was read out of the loader it describes rather than assumed, because a
 * reassurance that is wrong is worse than no reassurance: "nothing to worry about" on a file that
 * banked $1,530 is exactly the sentence that stops somebody checking.
 *
 * Pure. `inbox-undo-store.ts` does the removing.
 */

export type Reversal = "nothing" | "replaced" | "removable" | "kept";

export type KindEffect = {
  /** Two or three words for a picker, where a clause will not fit. */
  short: string;
  /** What loading a file as this kind writes, in one clause. */
  writes: string;
  reversal: Reversal;
  /** What a load of the wrong file as this kind leaves behind. */
  leaves: string;
  /** Where a person goes to deal with what the site cannot remove. */
  at?: { href: string; label: string };
};

const EFFECTS: Record<string, KindEffect> = {
  claims: {
    short: "adds claims",
    writes: "claims, one per row, refusing any it already holds",
    reversal: "kept",
    leaves: "the claims it added stay. They are real rows on the claims table and every margin figure counts them.",
    at: { href: "/claims", label: "Claims" },
  },
  rx_transactions: {
    short: "adds and cancels claims",
    writes: "claims from the paid rows, and cancels the claims that the reversal rows name",
    reversal: "kept",
    leaves:
      "the claims it added stay, and any claim a reversal row named was cancelled. Cancelling is the half that cannot be guessed back: the site cannot tell a claim this file wrongly reversed from one that was genuinely reversed.",
    at: { href: "/claims", label: "Claims" },
  },
  invoice: {
    short: "files an invoice",
    /*
     * This path does something none of the others do: having filed the invoice, it withdraws the
     * document row the file was originally stored under and, where nothing else points at the
     * bytes, deletes the file too. So the arrival's own document is gone and the line now points at
     * the invoice's. Worth saying, because "just re-route it" quietly means something different
     * here from everywhere else.
     */
    writes: "a supplier invoice, filed under the schedule of the strongest thing on it",
    reversal: "kept",
    leaves:
      "the invoice stays, and what it lists counts as stock bought. Filing it also withdrew the document this arrived as and put the invoice's in its place, so re-routing now re-reads the invoice's own copy.",
    at: { href: "/invoices", label: "Invoices" },
  },
  supplier_statement: {
    short: "recategorises the document",
    writes: "nothing — it recategorises the document as a statement, a rebate breakdown or a credit memo",
    reversal: "nothing",
    leaves: "nothing. Only the document's own category changed; no figure anywhere moved.",
    at: { href: "/documents", label: "Documents" },
  },
  rxrescue_credit: {
    short: "pays fills",
    writes: "payments against the fills the memo names, keyed on the memo's own transaction numbers",
    reversal: "kept",
    leaves:
      "the payments it applied stay against those prescriptions. They were keyed on the memo's transaction numbers, so this file cannot apply them twice — but nothing removes them either.",
  },
  on_hand: {
    short: "replaces a day's shelf",
    writes: "the shelf as counted on the date printed in the file, replacing any earlier count for that date",
    reversal: "replaced",
    leaves:
      "the count it filed stands as that day's shelf until a real count for the same date replaces it. It files nothing at all if the file prints no date.",
    at: { href: "/inventory", label: "Inventory" },
  },
  payer_payments: {
    short: "banks money",
    writes: "a bank deposit per payment, keyed on the payer's own payment number",
    reversal: "kept",
    leaves: "the deposits it banked stay on the cash account, in the month each was paid.",
    at: { href: "/money", label: "Money" },
  },
  accrual_sales: {
    short: "replaces a month",
    writes: "the month's takings, replacing whatever was held for that month",
    reversal: "replaced",
    leaves: "it stands as that month's takings until the correct summary for the same month replaces it.",
    at: { href: "/reports", label: "Reports" },
  },
  pioneer_catalog: {
    short: "reprices NDCs",
    writes: "prices and pack sizes against the NDCs in the file, for the supplier the file names",
    reversal: "replaced",
    leaves: "the prices it wrote stand until that supplier's next catalogue reprices the same NDCs, which is daily.",
    at: { href: "/purchasing", label: "Purchasing" },
  },
  supplier_catalog: {
    short: "reprices NDCs",
    writes: "prices and pack sizes against the NDCs in the file, for the supplier the sender rule names",
    reversal: "replaced",
    leaves: "the prices it wrote stand until that supplier's next price file reprices the same NDCs.",
    at: { href: "/purchasing", label: "Purchasing" },
  },
  rebate_report: {
    short: "sets the rebate rate",
    writes: "the rebate tier ladder and the month's achieved rate",
    reversal: "replaced",
    leaves:
      "the rate it set is the one used to price a generic until the next statement replaces it, and statements are monthly. Worth checking rather than waiting for.",
    at: { href: "/purchasing", label: "Purchasing" },
  },
  purchase_drilldown: {
    short: "sets the discount band",
    writes: "where the compliance ratio stands, which is what picks the discount band",
    reversal: "replaced",
    leaves: "the ratio it set prices contract generics until the next morning's report replaces it.",
    at: { href: "/purchasing", label: "Purchasing" },
  },
  return_policy: {
    short: "proposes only, stores nothing",
    writes: "nothing — it proposes terms and waits for somebody to check each figure against the sentence it came from",
    reversal: "nothing",
    leaves: "nothing. It was never stored; reading another policy replaces the proposal.",
  },
  remittance_835: {
    short: "pays fills and banks money",
    writes: "a payment against each claim the remittance names, and the total as a bank deposit",
    reversal: "removable",
    leaves: "payments against those fills and a deposit on the cash account — all of which this site can take back out.",
    at: { href: "/money", label: "Money" },
  },
  copay_remit: {
    short: "pays fills and banks money",
    writes: "a payment against each fill the voucher statement names, and the total as a bank deposit",
    reversal: "removable",
    leaves: "payments against those fills and a deposit on the cash account — all of which this site can take back out.",
    at: { href: "/money", label: "Money" },
  },
  nadac: {
    short: "adds prices, keeps the file",
    /*
     * The one nobody would ever find from a screen.
     *
     * This loader copies the file into the reference folder and then re-reads that whole folder,
     * every time any NADAC file is loaded afterwards. So a file forced through here is not a
     * one-off mistake that the next file corrects: it is re-read for ever, and no page in this site
     * lists what is in that folder.
     */
    writes: "NADAC prices by NDC and date, and keeps a copy of the file in the reference folder",
    reversal: "kept",
    leaves:
      "the prices it added stay, and — the part worth knowing — the file itself is kept in the reference folder and read again every time any NADAC file is loaded afterwards. A wrong file put through here is not corrected by the next one.",
    at: { href: "/nadac", label: "NADAC" },
  },
};

export function effectOf(kind: string | null | undefined): KindEffect | null {
  if (!kind || kind === "unrecognised") return null;
  return EFFECTS[kind] ?? null;
}

/**
 * What is still there from the reading being overruled, said before anybody presses anything.
 *
 * `was` null, or a kind nothing is known about, is answered as not known rather than as nothing:
 * "nothing was left behind" and "this cannot say what was left behind" are different statements and
 * only one of them is a reason to stop worrying.
 */
export function leftBehind(was: string | null | undefined): string {
  if (!was || was === "unrecognised") return "Nothing was loaded from it before, so there is nothing left over.";
  const e = effectOf(was);
  if (!e) return `It was loaded as ${was.replace(/_/g, " ")}, and this screen cannot say what that left behind. Check before you rely on the figures.`;
  const where = e.at ? ` Look under ${e.at.label}.` : "";
  switch (e.reversal) {
    case "nothing":
      return `It wrote ${e.writes}, so ${e.leaves}`;
    case "replaced":
      return `Loading it wrote ${e.writes}: ${e.leaves}${where}`;
    case "removable":
      return `Loading it wrote ${e.writes}. Take it back out first — ${e.leaves}`;
    case "kept":
      return `Loading it wrote ${e.writes}, and ${e.leaves}${where}`;
  }
}

/** What forcing this kind will do, said before anybody chooses it. */
export function willWrite(kind: string): string | null {
  const e = effectOf(kind);
  if (!e) return null;
  return `Loading it as this writes ${e.writes}.`;
}

/** The same fact in two or three words, for the line of a picker. */
export function willWriteShort(kind: string): string | null {
  return effectOf(kind)?.short ?? null;
}

/** True where the site itself can remove what a load of this kind wrote. */
export function isRemovable(kind: string | null | undefined): boolean {
  return effectOf(kind)?.reversal === "removable";
}
