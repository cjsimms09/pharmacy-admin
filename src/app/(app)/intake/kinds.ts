/**
 * The kinds of file the site can read, as the person adding one would name them.
 *
 * The owner's words on finding he could not say what he was uploading: "no way to tell system
 * that's what this is in the add tool. need many more options!!!" He had a balance-on-hand report
 * in his hand and the only choices offered were a person and a credential type.
 *
 * Left empty nothing changes and the site works it out as before. Naming one removes the guess,
 * which matters most for the files that look like one another — a drug file and a wholesaler's
 * catalogue are both a wide CSV of NDCs and prices.
 *
 * ── Why this is its own file ──
 *
 * `actions.ts` carries "use server", and Next.js allows a server module to export nothing but
 * async functions. A plain array exported from there fails the build, and it fails it at build
 * time rather than at the keyboard — so the list lives here, where the page and the action can
 * both read it.
 */
export const FILE_KINDS = [
  { key: "", label: "Let the site work it out" },
  { key: "balance_on_hand", label: "Drug file / balance on hand (PioneerRx)" },
  { key: "rx_transactions", label: "Rx Transaction Details — the daily claims report" },
  { key: "supplier_catalog", label: "A wholesaler's catalogue" },
  { key: "supplier_invoice", label: "A wholesaler's invoice" },
  { key: "remittance", label: "An 835 remittance from a plan" },
  { key: "copay_remit", label: "A copay-card voucher remittance (RedSail)" },
  { key: "bank_statement", label: "A bank statement" },
  { key: "contract", label: "A contract, rate exhibit or provider manual" },
  { key: "staff_document", label: "A licence, certificate or training record" },
] as const;

/** What the person adding the file said it was, where they said anything. */
export type IntakeHint = {
  kind?: string | null;
  /** The day a count represents, for a balance-on-hand report. Beats the file's own date. */
  countedOn?: string | null;
};
