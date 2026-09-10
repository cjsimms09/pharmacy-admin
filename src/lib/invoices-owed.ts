/**
 * Which invoices the pharmacy is still waiting on, and which it has decided it is not.
 *
 * The owner: "are we using pioneers receipts to make sure we are getting invoices from suppliers? If
 * it was received by pioneer than we should be receiving the invoice." Yes — that is the check, and
 * this is it. PioneerRx records every delivery the pharmacy books in at the counter, so its purchase
 * list is the only independent count of what was billed. Every other figure on the invoice page is
 * read off the invoices themselves, and so cannot tell an invoice that never arrived from one that
 * does not exist: the file looks complete because it is consistent with itself.
 *
 * And the caveat he added in the same breath, which is what makes this usable rather than nagging:
 *
 * > "I should have an option on a supplier to use pioneers receipts as invoice for that supplier (ie
 * > Xymogen supplier)... there are a couple suppliers where I'd rather just use the pioneers invoice
 * > as the invoice."
 *
 * ── Three different pieces of news ──
 *
 * A delivery with no invoice behind it means one of three things, and calling them all "missing"
 * would have handed him a $142,036.21 headline that was not true. McKesson's forty-two uninvoiced
 * deliveries are all dated 1–9 September; every McKesson invoice on file is dated the 9th or later.
 * They are not a wholesaler failing to send. They are the days before this mailbox started catching
 * what the wholesaler sends, which is the exact thing he set this up to recover:
 *
 * > "it was for the money section... to catch the money from invoices we didn't get before this was
 * > setup in September"
 *
 * So a delivery with no invoice is sorted by what the pharmacy knows about that supplier:
 *
 * - **waiting** — they have sent invoices here, starting on a known date, and this delivery is dated
 *   after it and has none. That is a wholesaler that owes a document. This is the only thing chased.
 * - **before we were catching them** — dated before the first invoice they ever sent here. Nothing
 *   was watching. Recoverable from the wholesaler's own portal, at leisure, and not a fault.
 * - **never filed at all** — no invoice from them has ever arrived. Either they do not email one (in
 *   which case the switch below is the answer) or their sending address is not recorded (in which
 *   case invoices are being quietly dropped, which is the worse of the two and worth knowing).
 *
 * ── The switch is not about the money ──
 *
 * The cash account already counts every PioneerRx purchase that no invoice covers, matched on the
 * wholesaler's own invoice number, so nothing here is uncounted either way. What the switch changes
 * is the chasing. A supplier that never emails an invoice produced a row on this list every time it
 * delivered, for ever, and a list that always carries something nobody intends to act on is a list
 * that stops being read — which is how the six handled training replies became the whole of his
 * inbox.
 *
 * So the switch says which suppliers he is not waiting on. It is his decision and not a rule the
 * site should infer: a wholesaler that has sent nothing for three months might be one he is about to
 * ring, or one whose receipt he is content to file as the record.
 *
 * Pure, so it is tested.
 */

export type PurchaseRow = {
  supplier: string | null;
  supplierId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  totalCents: number | null;
};

/** An invoice the pharmacy holds. The date is what says when their invoices started arriving. */
export type FiledRow = {
  supplier: string | null;
  supplierId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  /** What it came to. The only handle on an invoice whose number could not be read. */
  totalCents: number | null;
};

export type SupplierRow = {
  id: string;
  name: string;
  /** True where the owner has said this wholesaler's receipt is the invoice. */
  invoiceFromPioneer: boolean;
};

export type OwedLine = {
  supplier: string;
  supplierId: string | null;
  /** Purchases PioneerRx recorded for them. */
  received: number;
  receivedCents: number;
  /** No invoice, and dated after their invoices started arriving here. Owed a document. */
  waiting: number;
  waitingCents: number;
  /** No invoice, and from before anything was catching theirs. Recoverable, not a fault. */
  before: number;
  beforeCents: number;
  /** True where no invoice from them has ever been filed, so there is no date to judge against. */
  neverFiled: boolean;
  /** The earliest invoice of theirs on file — the day their invoices started arriving. */
  filingSince: string | null;
  /** Deliveries covered by an invoice of theirs that carries no number, matched on the amount. */
  matchedByAmount: number;
  /** True where he has said not to wait: counted, listed, never chased. */
  receiptIsTheInvoice: boolean;
  says: string;
};

const norm = (v: string | null | undefined): string => (v ?? "").trim().toUpperCase();
const fold = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string | null): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return iso ?? "";
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${Number(m[3])} ${names[Number(m[2]) - 1] ?? m[2]}`;
};

/**
 * The invoice-shaped gap, by supplier.
 *
 * Matched on the wholesaler's own invoice number and nothing else. The two systems spell the same
 * wholesaler three ways — "IPC", "Independent Pharmacy Cooperative", "Independent Pharmacy
 * Cooperative (IPC)" — and keying on the name as well is how the last matching bug hid. The supplier
 * name is used for one thing only: deciding whose filing history a delivery is judged against.
 */
export function invoicesOwed(purchases: PurchaseRow[], filed: FiledRow[], suppliers: SupplierRow[], watchingSince?: string | null): OwedLine[] {
  const have = new Set(filed.map((f) => norm(f.invoiceNumber)).filter(Boolean));
  const byName = new Map(suppliers.map((s) => [fold(s.name), s]));
  const byId = new Map(suppliers.map((s) => [s.id, s]));
  const keyOf = (supplierId: string | null, supplier: string | null): string => {
    const name = supplier ?? "(unnamed)";
    const reg = (supplierId ? byId.get(supplierId) : undefined) ?? byName.get(fold(name));
    return reg?.id ?? fold(name);
  };

  /*
   * When each supplier's invoices started arriving here.
   *
   * The earliest invoice of theirs on file. Before that date nothing was catching them, so a
   * delivery with no invoice is a gap in the pharmacy's watching rather than in the wholesaler's
   * posting — and saying otherwise is the difference between a figure he acts on and one he learns
   * to ignore.
   */
  const since = new Map<string, string>();
  for (const f of filed) {
    const d = (f.invoiceDate ?? "").trim();
    if (!d) continue;
    const k = keyOf(f.supplierId, f.supplier);
    const held = since.get(k);
    if (!held || d < held) since.set(k, d);
  }

  /*
   * Their invoices that carry no number at all.
   *
   * IPD's do. Both of the ones on file were read, dated and totalled, and neither carries a number
   * this reader could find — so matching on the number alone declared a $3,255.70 invoice missing
   * while it sat in the invoice file, which is the worst thing this list could do. It would send
   * him to ring a wholesaler about a document the pharmacy already holds.
   *
   * So an unnumbered invoice from the same supplier, for the exact amount of the delivery, covers
   * it. Each is spent once — two deliveries of the same amount need two invoices, not one used
   * twice — and the amount must match to the cent. Nothing looser: a near-match here would hide a
   * genuinely missing invoice behind an unrelated one, and the whole point of this list is that
   * it can tell those apart.
   */
  const unnumbered = new Map<string, number[]>();
  for (const f of filed) {
    if (norm(f.invoiceNumber) || f.totalCents === null) continue;
    const k = keyOf(f.supplierId, f.supplier);
    unnumbered.set(k, [...(unnumbered.get(k) ?? []), f.totalCents]);
  }

  const lines = new Map<string, OwedLine>();
  for (const p of purchases) {
    const name = p.supplier ?? "(unnamed)";
    const reg = (p.supplierId ? byId.get(p.supplierId) : undefined) ?? byName.get(fold(name));
    const key = reg?.id ?? fold(name);
    /*
     * Their own first invoice if they have sent one, and otherwise the day this mailbox started
     * catching anybody's. A supplier that has never sent one still gets judged against something:
     * before that day nothing was being caught from anyone, so their silence proves nothing.
     */
    const filingSince = since.get(key) ?? watchingSince ?? null;
    const line =
      lines.get(key) ??
      ({
        supplier: reg?.name ?? name,
        supplierId: reg?.id ?? null,
        received: 0,
        receivedCents: 0,
        waiting: 0,
        waitingCents: 0,
        before: 0,
        beforeCents: 0,
        matchedByAmount: 0,
        neverFiled: !since.has(key),
        filingSince,
        receiptIsTheInvoice: reg?.invoiceFromPioneer ?? false,
        says: "",
      } satisfies OwedLine);
    line.received++;
    line.receivedCents += p.totalCents ?? 0;

    /*
     * A purchase with no number of its own can never be matched to an invoice, so it can never be
     * proved missing either. Counted as received and not as waiting, because "we have no way to
     * tell" is not the same news as "they have not sent it".
     *
     * And nothing accumulates against a supplier he has settled. The field is called `waiting` and
     * the sentence beside it says nothing is waiting on them, so the count has to agree with both.
     */
    if (!line.receiptIsTheInvoice && norm(p.invoiceNumber) && !have.has(norm(p.invoiceNumber))) {
      /* One of their unnumbered invoices, for exactly this, spent once. */
      const pool = unnumbered.get(key);
      const at = p.totalCents === null ? -1 : (pool?.indexOf(p.totalCents) ?? -1);
      if (at >= 0 && pool) {
        pool.splice(at, 1);
        line.matchedByAmount++;
        lines.set(key, line);
        continue;
      }
      const watched = filingSince !== null && (p.invoiceDate ?? "") >= filingSince;
      if (watched) {
        line.waiting++;
        line.waitingCents += p.totalCents ?? 0;
      } else {
        line.before++;
        line.beforeCents += p.totalCents ?? 0;
      }
    }
    lines.set(key, line);
  }

  for (const l of lines.values()) {
    l.says = l.receiptIsTheInvoice
      ? `${l.received} deliveries, ${money(l.receivedCents)}. You have said their receipt is the invoice, so nothing here is waiting on them.`
      : l.neverFiled && (l.waiting > 0 || l.before > 0)
        ? `${l.received} deliveries, ${money(l.receivedCents)}, and no invoice from them has ever been filed here. Either they do not email one — in which case say so and this stops asking — or the address they send from is not recorded.`
        : l.waiting > 0 && l.before > 0
          ? `${l.waiting} deliveries since ${day(l.filingSince)} have no invoice — ${money(l.waitingCents)} they have not sent. A further ${l.before} predate ${day(l.filingSince)}, when their invoices started arriving here.`
          : l.waiting > 0
            ? `${l.waiting} of ${l.received} deliveries have no invoice — ${money(l.waitingCents)} the pharmacy has been billed for and has no document to keep.${l.matchedByAmount > 0 ? ` (${l.matchedByAmount} more ${l.matchedByAmount === 1 ? "is" : "are"} covered by an invoice of theirs carrying no number, matched on the amount.)` : ""}`
            : l.before > 0
              ? `${l.before} of ${l.received} deliveries predate ${day(l.filingSince)}, when their invoices started arriving here — ${money(l.beforeCents)}, recoverable from their portal. Everything since has an invoice on file.`
              : `${l.received} deliveries, ${money(l.receivedCents)}, and an invoice on file for every one.`;
  }

  /*
   * Worst first, and the ones he is not waiting on last whatever their size. A supplier actually
   * owing a document outranks one with a backlog from before this was set up, which outranks one
   * that has simply never sent anything. A supplier he has settled is not competing for his
   * attention with any of them.
   */
  const rank = (l: OwedLine) => (l.receiptIsTheInvoice ? 4 : l.waiting > 0 ? 0 : l.neverFiled && l.before > 0 ? 1 : l.before > 0 ? 2 : 3);
  return [...lines.values()].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return b.waitingCents - a.waitingCents || b.beforeCents - a.beforeCents || b.receivedCents - a.receivedCents;
  });
}

/**
 * What is genuinely still to chase, for the one line above a list.
 *
 * Only deliveries a wholesaler owes a document for. The backlog from before the mailbox was watching
 * is real money and is on the list, but it is not something to ring anybody about, and folding it in
 * here would put a number at the top of the page that overstates the problem by two orders of
 * magnitude.
 */
export function stillToChase(lines: OwedLine[]): { suppliers: number; invoices: number; cents: number } {
  const live = lines.filter((l) => !l.receiptIsTheInvoice && l.waiting > 0);
  return {
    suppliers: live.length,
    invoices: live.reduce((n, l) => n + l.waiting, 0),
    cents: live.reduce((n, l) => n + l.waitingCents, 0),
  };
}

/** The backlog from before this was catching invoices — worth recovering, not worth chasing. */
export function fromBeforeWeWatched(lines: OwedLine[]): { suppliers: number; invoices: number; cents: number } {
  const live = lines.filter((l) => !l.receiptIsTheInvoice && l.before > 0);
  return {
    suppliers: live.length,
    invoices: live.reduce((n, l) => n + l.before, 0),
    cents: live.reduce((n, l) => n + l.beforeCents, 0),
  };
}
