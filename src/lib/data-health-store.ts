import "server-only";
import { db, schema } from "@/db";
import { count } from "drizzle-orm";
import { todayIso } from "./dates";
import { SPECS, type Measurement } from "./data-health";
import { comparePack } from "./data-health-packages";
import { allSuppliers, supplierRecordFor } from "./suppliers-registry";
import { supplierFromFileName } from "./pioneer-catalog";
import { getSettings } from "./settings";

/**
 * Running the data health counts, and keeping the answers.
 *
 * The arithmetic and the wording are in `data-health.ts`, which is pure. This is the half that
 * touches the database, and it is deliberately the half nobody calls on a page view.
 *
 * ── Why the counts are stored rather than computed on view ──
 *
 * Every libsql call blocks the Node event loop. Reading 200,000 rows takes one and three-quarter
 * seconds and, measured with a heartbeat every twenty milliseconds, lets not one of the eighty-four
 * possible beats through — the web server answers nothing for the duration. Several of the counts
 * below read the whole catalogue and the whole NADAC table. A page that recounted on every view
 * would take the site down while telling somebody how healthy it is, which would be a joke at the
 * pharmacy's expense.
 *
 * So measuring is an explicit act with a button behind it, the answers go in `data_health_counts`,
 * and the page reads that table — nineteen rows, instant. `tookMs` is stored so a count that is
 * becoming expensive says so before anybody notices it as a hang.
 *
 * ── What is not measured, and why that is a state and not a bug ──
 *
 * A measurement this cannot take soundly is not taken. There is no row, the page shows "not
 * measured", and that is honest. Writing a plausible number would be the exact failure the page
 * exists to remove — worse than a gap, because a gap invites somebody to look.
 */

/** One page of rows read at a time, so a large table does not arrive as one allocation. */
const isNdc = (s: string | null | undefined): s is string => typeof s === "string" && /^\d{11}$/.test(s);

/** A fill, as the pharmacy means it: one dispensing, however many payors adjudicated it. */
function fillKey(r: { rxNumber: string; fillNumber: number | null; dateFilled: string; ndc11: string | null }): string {
  return [r.rxNumber, r.fillNumber ?? "", r.dateFilled, r.ndc11 ?? ""].join("|");
}

/** Months between two ISO dates, positive where the second is later. */
function monthsBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return (b - a) / (86_400_000 * 30.437);
}

/**
 * Counts everything it can count soundly, and stores the answers.
 *
 * Returns what it measured and what it deliberately did not, so the caller can say both.
 */
export async function measureDataHealth(): Promise<{ measured: number; skipped: string[]; tookMs: number }> {
  const startedAll = Date.now();
  const today = todayIso();
  const out: (Measurement & { tookMs: number })[] = [];
  const skipped: string[] = [];

  /*
   * `measuredAt` is today unless the measurement carries its own, and one of them has to.
   *
   * The claims proof is not measured by this sweep — it is read back from what a nightly script
   * left behind, and its age is the age of that run. Stamping it with today would print "measured
   * today" over a proof that last ran three weeks ago, which is precisely the blind spot the row
   * exists to show. An explicit null still means never measured and is not overwritten either.
   */
  const timed = async (key: string, run: () => Promise<Omit<Measurement, "key" | "measuredAt"> & { measuredAt?: string | null }>) => {
    const t = Date.now();
    const { measuredAt, ...m } = await run();
    out.push({ key, measuredAt: measuredAt === undefined ? today : measuredAt, tookMs: Date.now() - t, ...m });
  };

  /*
   * ── The claims, proved against the reports they were read from ───
   *
   * The owner: "these things need to be right!! we need to make sure claims are matching their
   * info properly and continue to … this is the most important thing." Every other row here asks
   * whether the site's tables agree with one another, which they can do perfectly while all of
   * them disagree with the file behind them. `scripts/prove-claims.ts` re-reads the stored daily
   * reports each night and leaves its answer in a setting; this row is that answer, and it is read
   * rather than recomputed so that the page and the proof can never differ about it.
   */
  await timed("claims-proof", async () => {
    const { parseClaimsProof, claimsProofFraction, claimsProofGaps, claimsProofNote } = await import("./data-health-claims-proof");
    const { SETTING_KEYS } = await import("./settings");
    /*
     * The row says so when it cannot see the proof, rather than reading it as nothing.
     *
     * `getSettings` builds its answer from `SETTING_KEYS` and drops every key not on that list, so
     * a proof written to an unregistered key reads as the empty string here — for ever, quietly,
     * looking exactly like a proof that has never run. The two need different actions from
     * different people, so the row distinguishes them by name.
     */
    const registered = (SETTING_KEYS as readonly string[]).includes("claims_proof");
    const raw = registered ? (await getSettings())["claims_proof" as keyof Awaited<ReturnType<typeof getSettings>>] : undefined;
    const proof = parseClaimsProof(raw);
    if (!proof) {
      return {
        numerator: 0,
        denominator: 0,
        // Never measured, which is not a measurement of zero and must not be stamped with today.
        measuredAt: null,
        gaps: registered ? [] : ["`claims_proof` is not in SETTING_KEYS, so the site cannot read what the nightly proof writes."],
        note: registered
          ? "The nightly proof has not run, so no claim on this site has been set against the report it came from."
          : "The nightly proof writes to a setting this site does not read: `claims_proof` is missing from SETTING_KEYS in settings.ts. Until it is added, this row cannot see the proof however often it runs.",
      };
    }
    const { numerator, denominator } = claimsProofFraction(proof);
    return { numerator, denominator, measuredAt: proof.provedOn, gaps: claimsProofGaps(proof), note: claimsProofNote(proof) };
  });

  // ── The rows every claim question is asked of ────────────────────
  // Counted by prescription, fill number, date and NDC rather than by claim row: one dispensing
  // can carry a second payor, and of 1,054 insured paid fills 22 do. Counting rows would inflate
  // every denominator on this page by exactly those coordinations.
  const claimRows = await db
    .select({
      rxNumber: schema.claims.rxNumber,
      fillNumber: schema.claims.fillNumber,
      dateFilled: schema.claims.dateFilled,
      ndc11: schema.claims.ndc11,
      bin: schema.claims.bin,
      pcn: schema.claims.pcn,
      groupNumber: schema.claims.groupNumber,
      cashPlan: schema.claims.cashPlan,
      status: schema.claims.status,
    })
    .from(schema.claims);

  const insuredRows = claimRows.filter((r) => !r.cashPlan && r.status === "paid");
  const fills = new Map<string, (typeof insuredRows)[number]>();
  for (const r of insuredRows) if (!fills.has(fillKey(r))) fills.set(fillKey(r), r);
  const fillCount = fills.size;
  const dispensedNdcs = new Set([...fills.values()].map((r) => r.ndc11).filter(isNdc));

  await timed("claims", async () => ({
    numerator: fillCount,
    denominator: fillCount,
    gaps:
      claimRows.length === insuredRows.length
        ? []
        : [`${(claimRows.length - insuredRows.length).toLocaleString("en-US")} claim rows are cash-plan or reversed and are not counted here`],
    note:
      fillCount === 0
        ? "No claims have been imported."
        : `${insuredRows.length.toLocaleString("en-US")} insured paid claim rows became ${fillCount.toLocaleString("en-US")} fills; the difference is second payors on the same dispensing.`,
  }));

  // ── The catalogue ────────────────────────────────────────────────
  const catalogue = await db
    .select({
      ndc11: schema.supplierItems.ndc11,
      supplier: schema.supplierItems.supplier,
      unitCostMicros: schema.supplierItems.unitCostMicros,
      packSize: schema.supplierItems.packSize,
      awpCents: schema.supplierItems.awpCents,
    })
    .from(schema.supplierItems);

  await timed("catalogue", async () => {
    const priced = catalogue.filter((r) => r.unitCostMicros !== null && r.unitCostMicros > 0).length;
    return {
      numerator: priced,
      denominator: catalogue.length,
      gaps: gapsBySupplier(catalogue.filter((r) => !(r.unitCostMicros !== null && r.unitCostMicros > 0)), "carry no unit price"),
    };
  });

  await timed("catalogue-awp", async () => {
    const withAwp = catalogue.filter((r) => r.awpCents !== null && r.awpCents > 0).length;
    return {
      numerator: withAwp,
      denominator: catalogue.length,
      gaps: gapsBySupplier(catalogue.filter((r) => !(r.awpCents !== null && r.awpCents > 0)), "carry no AWP"),
      note: "A plan paying a discount off AWP cannot be checked on a row with none.",
    };
  });

  /*
   * ── Which catalogues are still arriving ──────────────────────────
   *
   * On 7 September ANDA and ParMed sent a file and McKesson, IPC and IPD did not, and nothing on any
   * screen said so. A wholesaler whose catalogue stops arriving does not leave a gap — it leaves
   * last week's prices, which look exactly like prices that have not changed. The buy list goes on
   * recommending from them.
   *
   * Measured per supplier on the register rather than per file seen, so a wholesaler that has never
   * sent one is counted as missing rather than being absent from the denominator.
   *
   * ── When the file ARRIVED, not when it was imported ──
   *
   * The first version of this row read 5 of 5 while three wholesalers had sent nothing for two
   * days, and the reason is the whole point of the row: re-running a stored 6 September file
   * through the importer on the 8th to fill in item numbers stamps `supplier_imports` with the 8th.
   * Import time measures our own activity; the question is the supplier's. A row that answers "have
   * we touched this lately" while appearing to answer "is this current" is worse than no row,
   * because it is reassuring.
   *
   * `inbox_items.received_at` is when the message actually landed, and a re-import creates no inbox
   * item at all.
   */
  const arrivals = await db
    .select({
      receivedAt: schema.inboxItems.receivedAt,
      fileName: schema.inboxItems.fileName,
      subject: schema.inboxItems.subject,
      routedAs: schema.inboxItems.routedAs,
    })
    .from(schema.inboxItems);
  await timed("catalogue-currency", async () => {
    const registry = await allSuppliers(true);
    const newest = new Map<string, string>();
    for (const a of arrivals) {
      const name = `${a.fileName ?? ""} ${a.subject ?? ""}`;
      // A catalogue is recognised by the file the wholesaler sends, not by how the site filed it.
      const isCatalogue = /catalog/i.test(name) || a.routedAs === "supplier_catalog";
      if (!isCatalogue) continue;
      /*
       * Whose file this is, answered by the reader the import itself uses.
       *
       * I first matched the register's own names against the file name, which was the right
       * instinct and the wrong reader: PioneerRx writes "MCKCatalog9_6_2026.txt" and the register
       * says "Mckesson", so squashed they never meet — the row read 4 of 5 and called McKesson
       * "never". The fix is not a "MCKCatalog" alias on the register either, because that is
       * PioneerRx's file prefix wearing the costume of a name the wholesaler goes by, and the
       * register is what the invoice matcher reads.
       *
       * `supplierFromFileName` already holds those prefixes, because deciding whose file this is
       * is exactly what the catalogue import does with it. One place knows them, and it is the
       * place that has to be right anyway.
       */
      const catalogueName = a.fileName ? supplierFromFileName(a.fileName) : null;
      const supplier = catalogueName ? supplierRecordFor(registry, catalogueName) : null;
      if (!supplier) continue;
      const seen = newest.get(supplier.id);
      if (!seen || a.receivedAt > seen) newest.set(supplier.id, a.receivedAt);
    }
    const expected = registry.filter((r) => r.active);
    const days = (iso: string) => (Date.parse(today) - Date.parse(iso.slice(0, 10))) / 86_400_000;
    const fresh: string[] = [];
    const stale: string[] = [];
    for (const r of expected) {
      const at = newest.get(r.id);
      /*
       * Two days, not a week.
       *
       * These are scheduled nightly deliveries, so "current" means last night or the night before —
       * one missed night can be a mail delay, two is a feed that has stopped. A seven-day window
       * called a 6 September file current on the 8th, which is how IPC and IPD passed while having
       * sent nothing for two days. The window has to match the cadence of the thing it judges.
       */
      if (at && Number.isFinite(days(at)) && days(at) <= 2) fresh.push(r.name);
      else stale.push(at ? `${r.name} (last ${at.slice(0, 10)})` : `${r.name} (never)`);
    }
    return {
      numerator: fresh.length,
      denominator: expected.length,
      gaps: stale.length === 0 ? [] : [`No catalogue in the last two nights from: ${stale.join(", ")}`],
      note:
        expected.length === 0
          ? "No supplier is on the register, so nothing is expected."
          : "Measured on when the file arrived in the inbox, not when it was imported — re-running a stored file makes a supplier look current when nothing new has come. A catalogue that stops arriving leaves last week's prices in place, and they look exactly like prices that have not changed.",
    };
  });

  /*
   * ── How much history the claims cover ────────────────────────────
   *
   * The paid archive is fifteen days, 24 August to 7 September. Every rate, every steadiness test
   * and every trend on this site is judged on whatever window exists, and a fortnight cannot tell a
   * slow seller from a new one. The
   * denominator is a year because a year is what has been asked of PioneerRx — so the row reads as
   * progress towards the thing that fixes it rather than as an abstract percentage.
   */
  await timed("claims-window", async () => {
    // Over every paid claim, cash included: the archive is the archive.
    const dates = claimRows.filter((r) => r.status === "paid").map((r) => r.dateFilled).filter(Boolean).sort();
    if (dates.length === 0) {
      /*
       * No claims is "nothing to measure", not "a window of zero days".
       *
       * A denominator of 365 here would print 0% and read as broken, which is a different
       * statement from the claims row's "nothing has been imported" — and two rows describing one
       * absence in two ways is the confusion this page exists to remove.
       */
      return { numerator: 0, denominator: 0, note: "No claims have been imported, so there is no window to measure." };
    }
    const from = dates[0];
    const to = dates[dates.length - 1];
    /*
     * The span, and separately the days inside it that carry a claim. Both are true and they answer
     * different questions.
     *
     * The span is how far back the archive reaches, and it is the one the percentage uses, because
     * "twelve months" is a span. The count of days with a claim is how much is actually in it — a
     * pharmacy that shuts on Sundays has fewer, and a gap of a fortnight in the middle shows up here
     * and nowhere else.
     *
     * The first version measured the span over insured fills alone and read 15 where a count over
     * all paid claims reads 21, because the cash fills reach further back. The archive is the
     * archive: cash business is history the site holds, so the span is over everything paid.
     */
    const covered = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
    const daysWithAClaim = new Set(dates).size;
    const insured = [...fills.values()].map((f) => f.dateFilled).filter(Boolean).sort();
    const insuredSpan =
      insured.length === 0
        ? 0
        : Math.round((Date.parse(insured[insured.length - 1]) - Date.parse(insured[0])) / 86_400_000) + 1;

    const gaps = [`${daysWithAClaim} day${daysWithAClaim === 1 ? "" : "s"} carry a claim, across a span of ${covered} — ${from} to ${to}.`];
    if (insuredSpan > 0 && insuredSpan !== covered) {
      gaps.push(`Insured fills span ${insuredSpan} of those days; the rest is cash business, which reaches further back.`);
    }

    return {
      numerator: Math.min(covered, 365),
      denominator: 365,
      gaps,
      note:
        covered >= 365
          ? "A full year is held, so a seasonal drug can be told from a dying one."
          : `${covered} day${covered === 1 ? "" : "s"} of history. Every rate, steadiness test and trend on this site is judged on that window, and it cannot tell a slow seller from a new one. A twelve-month export is what closes it.`,
    };
  });

  // ── NADAC, and how current it is ─────────────────────────────────
  const nadac = await db
    .select({ ndc11: schema.nadacPrices.ndc11, effectiveOn: schema.nadacPrices.effectiveOn })
    .from(schema.nadacPrices);
  const newestNadac = new Map<string, string>();
  for (const r of nadac) {
    const seen = newestNadac.get(r.ndc11);
    if (!seen || r.effectiveOn > seen) newestNadac.set(r.ndc11, r.effectiveOn);
  }

  await timed("nadac", async () => {
    const current = [...newestNadac.values()].filter((d) => monthsBetween(d, today) <= 3).length;
    return {
      numerator: current,
      denominator: newestNadac.size,
      note:
        newestNadac.size === 0
          ? "No NADAC file has been loaded."
          : "A NADAC row older than three months is not the figure in force on a recent fill, and the Kansas floor is measured against the figure in force.",
    };
  });

  // ── The FDA directory ────────────────────────────────────────────
  // The package description is kept only for NDCs the catalogue actually carries. The directory is
  // 217,773 rows and holding every description would be tens of megabytes to answer a question
  // asked of 63,809 of them.
  const catalogueNdcSet = new Set(catalogue.map((r) => r.ndc11).filter(isNdc));
  const directory = await db
    .select({ ndc11: schema.drugDirectory.ndc11, packageDescription: schema.drugDirectory.packageDescription })
    .from(schema.drugDirectory);
  const directoryNdcs = new Set(directory.map((r) => r.ndc11));
  const packageOf = new Map<string, string>();
  for (const r of directory) if (catalogueNdcSet.has(r.ndc11)) packageOf.set(r.ndc11, r.packageDescription);
  await timed("fda-directory", async () => ({
    numerator: directoryNdcs.size,
    denominator: directoryNdcs.size,
    note: directoryNdcs.size === 0 ? "The FDA NDC directory has never been loaded." : null,
  }));

  // ── Invoices ─────────────────────────────────────────────────────
  const invoiceRows = await db
    .select({
      id: schema.supplierInvoices.id,
      supplier: schema.supplierInvoices.supplier,
      totalCents: schema.supplierInvoices.totalCents,
      // Named on the proof row's gaps: "an invoice does not add up" is unactionable without it.
      invoiceNumber: schema.supplierInvoices.invoiceNumber,
    })
    .from(schema.supplierInvoices);
  const lineRows = await db
    .select({
      invoiceId: schema.invoiceLines.invoiceId,
      supplierId: schema.invoiceLines.supplierId,
      supplier: schema.invoiceLines.supplier,
      extendedCents: schema.invoiceLines.extendedCents,
    })
    .from(schema.invoiceLines);
  const invoicesWithLines = new Set(lineRows.map((l) => l.invoiceId));

  await timed("invoices", async () => {
    const empty = invoiceRows.filter((i) => !invoicesWithLines.has(i.id));
    const owing = empty.filter((i) => (i.totalCents ?? 0) > 0);
    const owingCents = owing.reduce((n, i) => n + (i.totalCents ?? 0), 0);
    return {
      numerator: invoiceRows.length - empty.length,
      denominator: invoiceRows.length,
      gaps:
        owing.length === 0
          ? []
          : [
              `${owing.length} invoice${owing.length === 1 ? "" : "s"} worth $${(owingCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} carry a total and no item lines — usually a scan with no text layer`,
            ],
      note: invoiceRows.length === 0 ? "No supplier invoice has been filed." : null,
    };
  });

  /*
   * ── The directory against the load that wrote it ─────────────────
   *
   * Read back from what `loadDrugDirectory` stamped, and set against a count of the table. The
   * count is a `count(*)`, not a read of the rows: this is the 217,773-row table, and reading it to
   * measure its health would be the joke at the pharmacy's expense this file's own header warns
   * about.
   */
  await timed("directory-proof", async () => {
    const { parseDirectoryProof, directoryProofFraction, directoryProofGaps, directoryProofNote } = await import("./data-health-directory-proof");
    const proof = parseDirectoryProof((await getSettings()).drug_directory_proof);
    const [{ n: tableRows }] = await db.select({ n: count() }).from(schema.drugDirectory);
    if (!proof) {
      return {
        numerator: 0,
        denominator: 0,
        measuredAt: null,
        gaps:
          tableRows > 0
            ? [`The table holds ${tableRows.toLocaleString("en-US")} packages that no recorded load accounts for. They were loaded before the loader began proving itself; the next load will prove them.`]
            : [],
        note:
          tableRows > 0
            ? "The directory was loaded before loads recorded what they wrote, so there is nothing to set it against until it is fetched again."
            : "No drug directory has been loaded.",
      };
    }
    const { numerator, denominator } = directoryProofFraction(proof, tableRows);
    return {
      numerator,
      denominator,
      // The load's date, not the sweep's: an ageing proof is the fetch having stopped.
      measuredAt: proof.provedOn.slice(0, 10) || null,
      gaps: directoryProofGaps(proof, tableRows, today),
      note: directoryProofNote(proof, tableRows),
    };
  });

  /*
   * ── Every invoice against the total printed on its own face ──────
   *
   * The proof of the invoice family, and it needs no file: the invoice's printed total was captured
   * when it was filed, and the lines are stored beside it, so the two can be set against each other
   * whenever anybody asks.
   *
   * That makes this narrower than a re-read and worth saying so. It proves the storing, not the
   * reading — a total that was itself misread off the page would agree with lines read from the
   * same misreading, and this row would show nothing. What it does catch is the failure that has
   * actually happened here: lines dropped between the page and the table, where every line that
   * survived looks perfectly sound and only the missing one's drug appears cheaper than it was.
   */
  await timed("invoices-proof", async () => {
    const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const linesBy = new Map<string, { n: number; cents: number }>();
    for (const l of lineRows) {
      const held = linesBy.get(l.invoiceId) ?? { n: 0, cents: 0 };
      held.n++;
      held.cents += l.extendedCents ?? 0;
      linesBy.set(l.invoiceId, held);
    }
    // Only invoices that print a total can be proved against one. An invoice without one is not a
    // failure here; it is outside the question, and counting it as either answer would be a lie.
    const provable = invoiceRows.filter((i) => (i.totalCents ?? 0) > 0);
    const agree: typeof provable = [];
    const differ: { supplier: string | null; number: string | null; byCents: number; lines: number }[] = [];
    const empty: typeof provable = [];
    for (const i of provable) {
      const l = linesBy.get(i.id);
      if (!l || l.n === 0) {
        empty.push(i);
        continue;
      }
      const by = l.cents - (i.totalCents ?? 0);
      if (by === 0) agree.push(i);
      else differ.push({ supplier: i.supplier, number: i.invoiceNumber, byCents: by, lines: l.n });
    }
    const gaps: string[] = [];
    for (const d of differ.slice(0, 12)) {
      gaps.push(
        `${d.supplier ?? "an unnamed supplier"} invoice ${d.number ?? "with no number"}: ${d.lines} lines add to ${d.byCents > 0 ? "more" : "less"} than the printed total, by ${money(Math.abs(d.byCents))}.`,
      );
    }
    if (differ.length > 12) gaps.push(`… and ${differ.length - 12} more that do not add up.`);
    if (empty.length > 0) {
      const owed = empty.reduce((n, i) => n + (i.totalCents ?? 0), 0);
      gaps.push(
        `${empty.length} invoice${empty.length === 1 ? "" : "s"} worth ${money(owed)} carry a total and not one line, so nothing on ${empty.length === 1 ? "it" : "them"} reaches the cost of any drug.`,
      );
    }
    const withoutTotal = invoiceRows.length - provable.length;
    return {
      numerator: agree.length,
      denominator: provable.length,
      gaps,
      note:
        provable.length === 0
          ? "No invoice on file prints a total, so none can be proved against one."
          : `${agree.length.toLocaleString("en-US")} of ${provable.length.toLocaleString("en-US")} invoices carrying a total have lines that add to it exactly.` +
            (withoutTotal > 0 ? ` ${withoutTotal.toLocaleString("en-US")} more print no total and are outside this count.` : "") +
            " This proves what was stored against what the invoice said it came to; it cannot catch a total that was itself misread.",
    };
  });

  /*
   * ── Which wholesalers have ever sent an invoice, and which have a returns policy ──
   *
   * Two rows for the two halves of a question the site could not answer on 8 September: the owner
   * asked "is our system setup to make sure I am returning things when I need to?" and the honest
   * answer was no, for a reason no screen showed. The arithmetic works. It had one invoice to work
   * on — IPC, 4 September, eight lines — and no ANDA, IPD, ParMed or McKesson invoice has ever been
   * loaded, so 1,200 lines on Return soon carry no supplier at all.
   *
   * Counted per wholesaler on the register, never per invoice, and that is the whole point of
   * these two rows. The row above counts invoices that arrived and is structurally blind to the
   * ones that never did: a wholesaler that has sent nothing contributes nothing to a numerator or
   * a denominator, so four missing wholesalers read as a perfect score. Measuring against the
   * register puts them in the denominator, where they show up as the gap they are.
   *
   * Resolved the way the rest of the site resolves a supplier — `supplier_id` first, then
   * `supplierRecordFor` on the printed name — because an invoice filed under "Independent Pharmacy
   * Cooperative" is IPC's invoice, and a row that says otherwise would be the third screen to
   * disagree with the supplier card about the same eight lines.
   */
  const registryForInvoices = await allSuppliers(true);
  const activeSuppliers = registryForInvoices.filter((r) => r.active);

  await timed("supplier-invoices", async () => {
    const sent = new Set<string>();
    for (const i of invoiceRows) {
      const owner = supplierRecordFor(registryForInvoices, i.supplier);
      if (owner) sent.add(owner.id);
    }
    // An invoice whose lines named a supplier the invoice's own face did not counts too.
    for (const l of lineRows) {
      const owner = (l.supplierId && registryForInvoices.some((s) => s.id === l.supplierId) ? l.supplierId : null) ?? supplierRecordFor(registryForInvoices, l.supplier)?.id ?? null;
      if (owner) sent.add(owner);
    }
    const never = activeSuppliers.filter((s) => !sent.has(s.id));
    return {
      numerator: activeSuppliers.length - never.length,
      denominator: activeSuppliers.length,
      gaps:
        never.length === 0
          ? []
          : [
              `No invoice has ever been loaded from: ${never.map((s) => s.name).join(", ")}. Nothing bought from them has a cost, a supplier or a return clock.`,
            ],
      note:
        activeSuppliers.length === 0
          ? "No wholesaler is on the register."
          : never.length === 0
            ? null
            : "One invoice email from each closes this. The site reads an invoice from an address it does not know, so nothing has to be set up first.",
    };
  });

  await timed("supplier-returns", async () => {
    const { currentReturnPolicy } = await import("./supplier-terms-store");
    const without: string[] = [];
    for (const s of activeSuppliers) {
      if (!(await currentReturnPolicy(s.id))) without.push(s.name);
    }
    return {
      numerator: activeSuppliers.length - without.length,
      denominator: activeSuppliers.length,
      gaps: without.length === 0 ? [] : [`No returns policy on file for: ${without.join(", ")}. Nothing bought from them can be given a credit clock.`],
      note:
        without.length === 0
          ? null
          : "Typed from the wholesaler's own returns policy, as ANDA's was — never inferred, because a guessed window sends a bottle back on a date nobody agreed to.",
    };
  });

  // ── Invoice line → supplier → rebate ladder ──────────────────────
  const suppliers = await db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers);
  const programs = await db.select({ supplierId: schema.supplierRebatePrograms.supplierId }).from(schema.supplierRebatePrograms);
  const withLadder = new Set(programs.map((p) => p.supplierId));
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));

  await timed("invoice-supplier-ladder", async () => {
    /*
     * Resolved exactly as earningSoFar resolves it: supplier_id first, then the register's own
     * matcher on the printed name.
     *
     * Asking only for supplier_id read 0 of 8 on the live database and put "these lines resolve to
     * no supplier" on the screen — while the supplier card, going through supplierRecordFor and the
     * IPC aliases, placed all eight. Two screens disagreeing about the same eight lines is worse
     * than either being wrong on its own, because it leaves nobody knowing which to believe. This
     * page measures what the rest of the site does, or it measures nothing.
     */
    const registry = await allSuppliers(true);
    const ownerOf = (l: { supplierId: string | null; supplier: string | null }): string | null =>
      (l.supplierId && registry.some((s) => s.id === l.supplierId) ? l.supplierId : null) ??
      supplierRecordFor(registry, l.supplier)?.id ??
      null;

    const owners = lineRows.map((l) => ({ line: l, owner: ownerOf(l) }));
    const placed = owners.filter((o) => o.owner !== null && withLadder.has(o.owner)).length;
    const unplaced = owners.filter((o) => o.owner === null);
    const noLadder = owners.filter((o) => o.owner !== null && !withLadder.has(o.owner));

    const gaps: string[] = [];
    if (unplaced.length > 0) {
      const names = [...new Set(unplaced.map((o) => (o.line.supplier ?? "").trim() || "(no supplier printed)"))];
      gaps.push(
        `${unplaced.length} line${unplaced.length === 1 ? "" : "s"} match no supplier on the register, by id or by any name it holds — printed as ${names.slice(0, 3).join(", ")}. Add the printed name to that supplier's "Other names they go by".`,
      );
    }
    if (noLadder.length > 0) {
      const names = [...new Set(noLadder.map((o) => supplierName.get(o.owner!) ?? "?"))];
      gaps.push(
        `${noLadder.length} line${noLadder.length === 1 ? "" : "s"} belong to a supplier with no rebate ladder on file — ${names.slice(0, 3).join(", ")}. Nothing is being claimed on ${noLadder.length === 1 ? "it" : "them"}.`,
      );
    }
    return {
      numerator: placed,
      denominator: lineRows.length,
      gaps,
      // The two halves of this figure fail differently and want different actions, so the note says
      // which one is in play rather than describing both every time.
      note:
        unplaced.length > 0
          ? "A line matching no supplier leaves the rebate arithmetic without a word, which is how eight lines and $78.50 went missing."
          : noLadder.length > 0
            ? "Every line is placed on a supplier; what is missing is the ladder itself, which is a document to obtain rather than a matching fault."
            : null,
    };
  });

  // ── On-hand ──────────────────────────────────────────────────────
  const onHand = await db.select({ code: schema.onHand.code, codeKind: schema.onHand.codeKind }).from(schema.onHand);
  const counts = await db
    .select({ countedOn: schema.onHandImports.countedOn, datedBy: schema.onHandImports.datedBy })
    .from(schema.onHandImports);

  await timed("on-hand", async () => {
    /*
     * How the newest count came to be dated, because the answers are not equally good.
     *
     * "Counted on 8 September, dated by the report itself" is the report speaking. "Dated by hand"
     * is only as good as the memory of whoever typed it, and a shelf dated a day wrong misplaces a
     * day of dispensing against it. The row exists to say what is known, so it should say which of
     * those this is rather than presenting both as settled.
     */
    const newest = [...counts].sort((a, b) => b.countedOn.localeCompare(a.countedOn))[0] ?? null;
    const said: Record<string, string> = {
      typed: "dated by hand on the Add tool",
      labelled: "dated by a line in the report naming the count date",
      head: "dated by a date printed at the top of the report",
      footer: "dated by the date the report printed on itself",
    };
    const how = newest?.datedBy ? said[newest.datedBy] ?? `dated by ${newest.datedBy}` : null;
    return {
      numerator: onHand.length,
      denominator: onHand.length,
      gaps:
        counts.length > 1
          ? [`${counts.length} counts held; this row measures the shelf as it stands across all of them.`]
          : [],
      note:
        onHand.length === 0
          ? "No on-hand count has ever been received. Nothing can value the shelf until one is."
          : newest
            ? `Counted on ${newest.countedOn}` +
              (how ? `, ${how}.` : ". Where the date came from was not recorded — the count predates that being kept.")
            : null,
    };
  });

  await timed("onhand-catalogue", async () => ({
    numerator: onHand.filter((r) => r.codeKind === "ndc11" && catalogueNdcSet.has(r.code)).length,
    denominator: onHand.length,
    note: onHand.length === 0 ? "Nothing to match: no on-hand count has been received." : null,
  }));

  // ── Contracts ────────────────────────────────────────────────────
  const docs = await db
    .select({ id: schema.contractDocs.id, extractionState: schema.contractDocs.extractionState, triage: schema.contractDocs.triage })
    .from(schema.contractDocs);
  await timed("contracts", async () => {
    const done = docs.filter((d) => d.extractionState === "done").length;
    const untriaged = docs.filter((d) => !d.triage).length;
    const gaps: string[] = [];
    if (untriaged > 0) gaps.push(`${untriaged} document${untriaged === 1 ? " has" : "s have"} never been sorted, so the expensive reader has no list to work from`);
    const failed = docs.filter((d) => d.extractionState === "failed").length;
    if (failed > 0) gaps.push(`${failed} read${failed === 1 ? "" : "s"} failed and the stored error is shown with its date`);
    return { numerator: done, denominator: docs.length, gaps };
  });

  // ── Money that actually arrived ──────────────────────────────────
  const payments = await db
    .select({ rxNumber: schema.claimPayments.rxNumber, fillNumber: schema.claimPayments.fillNumber, dateFilled: schema.claimPayments.dateFilled, source: schema.claimPayments.source })
    .from(schema.claimPayments);
  const bank = await db.select({ id: schema.bankLines.id }).from(schema.bankLines);

  const facilitator = payments.filter((p) => (p.source ?? "").trim().toLowerCase() === "mtf").length;
  await timed("remits", async () => ({
    numerator: payments.length,
    denominator: payments.length,
    gaps:
      payments.length > 0 && facilitator === payments.length
        ? [`All ${payments.length} are facilitator payments. Not one 835 remittance has been received, so no plan has yet said what it actually paid on a claim.`]
        : [],
    note:
      payments.length === 0
        ? "No later payment has been loaded, so nothing says what a plan actually paid."
        : null,
  }));

  await timed("bank", async () => ({
    numerator: bank.length,
    denominator: bank.length,
    /*
     * A zero here is a waiting task and not a fault, and the note has to say so.
     *
     * The reader, the importer and the page all exist and work — bank-statement.ts parses the CSV,
     * /money places every line. Nothing has been uploaded, which is a thing somebody does rather
     * than something to fix, and "0" with no explanation reads as broken software.
     */
    note:
      bank.length === 0
        ? "Nothing is wrong here: no bank statement has been uploaded yet. Export the month-end CSV from the bank and load it on the Money page, and this fills in."
        : null,
  }));

  await timed("claim-remit-deposit", async () => {
    // Deliberately strict: a fill counts only where a payment row names it AND that payment could
    // be tied to a bank line. Anything looser would report money as received on the strength of a
    // promise, which is the distinction this row exists to draw.
    const paid = new Set(payments.map((p) => [p.rxNumber, p.fillNumber ?? "", p.dateFilled ?? ""].join("|")));
    const traced = bank.length === 0 ? 0 : [...fills.values()].filter((f) => paid.has([f.rxNumber, f.fillNumber ?? "", f.dateFilled].join("|"))).length;
    return {
      numerator: traced,
      denominator: fillCount,
      note:
        bank.length === 0
          ? `No bank statement has been uploaded, so no fill can be traced to cash actually received. ${payments.length} later payment${payments.length === 1 ? " is" : "s are"} on file waiting to be tied to a deposit${facilitator === payments.length && payments.length > 0 ? ", all of them facilitator money rather than 835 remittances" : ""}.`
          : null,
    };
  });

  // ── The links from a dispensed NDC ───────────────────────────────
  await timed("claim-fda", async () => ({
    numerator: [...dispensedNdcs].filter((n) => directoryNdcs.has(n)).length,
    denominator: dispensedNdcs.size,
  }));

  await timed("claim-nadac", async () => {
    const withCurrent = [...dispensedNdcs].filter((n) => {
      const d = newestNadac.get(n);
      return d !== undefined && monthsBetween(d, today) <= 3;
    }).length;
    const none = [...dispensedNdcs].filter((n) => !newestNadac.has(n));
    return {
      numerator: withCurrent,
      denominator: dispensedNdcs.size,
      gaps: none.length === 0 ? [] : [`${none.length} dispensed NDC${none.length === 1 ? " has" : "s have"} no NADAC row at all — CMS does not price hospital injectables, devices, supplements or repackager labels`],
    };
  });

  await timed("claim-catalogue", async () => {
    const withPack = new Set(catalogue.filter((r) => (r.packSize ?? "").trim() !== "").map((r) => r.ndc11).filter(isNdc));
    const missing = [...dispensedNdcs].filter((n) => !withPack.has(n));
    return {
      numerator: [...dispensedNdcs].filter((n) => withPack.has(n)).length,
      denominator: dispensedNdcs.size,
      gaps: missing.length === 0 ? [] : [`${missing.length} dispensed NDC${missing.length === 1 ? " is" : "s are"} in no catalogue with a pack size, so no per-unit cost can be worked out for ${missing.length === 1 ? "it" : "them"}`],
      note: "Without a pack size there is no margin on the fill, only a pack price.",
    };
  });

  // ── Claim → payer → plan class ───────────────────────────────────
  const plans = await db
    .select({
      bin: schema.planGroups.bin,
      pcn: schema.planGroups.pcn,
      groupNumber: schema.planGroups.groupNumber,
      classification: schema.planGroups.classification,
    })
    .from(schema.planGroups);
  const classed = new Set(
    plans
      .filter((p) => p.classification && p.classification !== "unknown")
      .map((p) => [p.bin ?? "", p.pcn ?? "", p.groupNumber ?? ""].join("|").toUpperCase()),
  );
  await timed("claim-plan", async () => {
    const tripleOf = (f: { bin: string | null; pcn: string | null; groupNumber: string | null }) =>
      [f.bin ?? "", f.pcn ?? "", f.groupNumber ?? ""].join("|").toUpperCase();
    const hit = [...fills.values()].filter((f) => classed.has(tripleOf(f))).length;

    /*
     * The unclassified plans, biggest first, so the work can start where the money is.
     *
     * This row came back 6 of 1,054 on the live database, which means the law-first rung in
     * drug-profit — Medicaid pays NADAC plus a fee, and the Kansas floor binds or does not — never
     * fires on 99% of fills. Classifying plans is the owner's work and it is a plan at a time, so a
     * bare percentage is not actionable and a list is: three or four triples cover most of it.
     */
    const byTriple = new Map<string, { n: number; label: string }>();
    for (const f of fills.values()) {
      const key = tripleOf(f);
      if (classed.has(key)) continue;
      const label = [f.bin ?? "no BIN", f.pcn ?? "no PCN", f.groupNumber ?? "no group"].join(" / ");
      const seen = byTriple.get(key);
      if (seen) seen.n += 1;
      else byTriple.set(key, { n: 1, label });
    }
    const worst = [...byTriple.values()].sort((a, b) => b.n - a.n).slice(0, 5);

    return {
      numerator: hit,
      denominator: fillCount,
      gaps:
        worst.length === 0
          ? []
          : [
              `${byTriple.size} plan${byTriple.size === 1 ? " has" : "s have"} no class on the register. The biggest by fills: ${worst.map((w) => `${w.label} (${w.n})`).join("; ")}`,
            ],
      note:
        hit === 0 || hit / Math.max(fillCount, 1) < 0.5
          ? "Which law applies — and so whether the Kansas floor binds at all — is decided by the plan's class. Until a plan is classified, the law-first rung in the profit engine cannot fire for its fills."
          : "Which law applies — and so whether the Kansas floor applies at all — is decided by the plan's class.",
    };
  });

  /*
   * ── Claim → contract ─────────────────────────────────────────────
   *
   * Measured through the payer links, which is where a document actually reaches a claim: a link
   * carries the BIN, PCN and group it was confirmed on, and `contract_doc_id` when the document
   * that governs it is known. A link naming only a BIN stands for every fill on that BIN, which is
   * how the register is written; a link naming more must match all of it.
   *
   * The note is as important as the number and is written whatever the number turns out to be. The
   * contracts name networks and chain codes, and the claims carry network reimbursement ids; until
   * that mapping exists, only a plan a document names by BIN, PCN or group can match at all. A bare
   * percentage here would send somebody off to file more contracts, which is not the work.
   */
  const links = await db
    .select({
      bin: schema.payerLinks.bin,
      pcn: schema.payerLinks.pcn,
      groupNumber: schema.payerLinks.groupNumber,
      contractDocId: schema.payerLinks.contractDocId,
      contractFileName: schema.payerLinks.contractFileName,
    })
    .from(schema.payerLinks);

  await timed("claim-contract", async () => {
    const toContract = links.filter((l) => (l.contractDocId ?? l.contractFileName) !== null);
    const up = (s: string | null) => (s ?? "").trim().toUpperCase();
    const governed = (f: { bin: string | null; pcn: string | null; groupNumber: string | null }) =>
      toContract.some((l) => {
        if (up(l.bin) !== "" && up(l.bin) !== up(f.bin)) return false;
        if (up(l.pcn) !== "" && up(l.pcn) !== up(f.pcn)) return false;
        if (up(l.groupNumber) !== "" && up(l.groupNumber) !== up(f.groupNumber)) return false;
        // A link naming nothing routable governs nothing; it is a note, not a match.
        return up(l.bin) !== "" || up(l.pcn) !== "" || up(l.groupNumber) !== "";
      });
    const matched = [...fills.values()].filter(governed).length;
    const linked = links.length;
    return {
      numerator: matched,
      denominator: fillCount,
      gaps:
        linked === 0
          ? []
          : [
              `${linked} payer link${linked === 1 ? "" : "s"} on the register, ${toContract.length} of them naming a contract document`,
            ],
      note:
        "Contracts name networks; claims carry network reimbursement ids. The mapping between them is being built; until then only a fill whose BIN, PCN or group a document names can match at all.",
    };
  });

  /*
   * ── Catalogue row → FDA package size ─────────────────────────────
   *
   * The row that finds cross-unit errors, so it must not manufacture any. `comparePack` returns
   * "cannot compare" wherever either side fails to reach a dispensing unit — chiefly an FDA
   * description that stops at a container ("3 BLISTER PACK in 1 CARTON" and never says what is in
   * the blister pack). Those are excluded from the denominator and reported as their own line,
   * because scoring them as disagreements would bury the real ones among false alarms.
   *
   * A whole multiple is called out separately because it is the expensive kind and the commonest
   * real fault: "30 EA" against an FDA 180 is thirty blister packs of six, and a per-unit cost
   * taken from the catalogue is six times wrong in a figure the buy list acts on.
   */
  await timed("catalogue-package", async () => {
    const placed = catalogue.filter((r) => isNdc(r.ndc11) && packageOf.has(r.ndc11));
    let agree = 0;
    let unreadable = 0;
    const multiples: string[] = [];
    let unitDiffers = 0;
    let differs = 0;

    let multipleCount = 0;
    for (const row of placed) {
      const v = comparePack(row.packSize, packageOf.get(row.ndc11!));
      if (v.verdict === "agree") agree++;
      else if (v.verdict === "cannot-compare") unreadable++;
      else if (v.verdict === "unit-differs") unitDiffers++;
      else if (v.verdict === "multiple") {
        multipleCount++;
        if (multiples.length < 3) multiples.push(`${row.supplier} "${row.packSize}" against the FDA's ${v.fda} ${v.uom} — ${v.factor}× out`);
      } else differs++;
    }

    const comparable = placed.length - unreadable;
    const gaps: string[] = [];
    /*
     * The count first, then the examples.
     *
     * Three worked examples with no total behind them is an anecdote: it says these exist without
     * saying whether they are three rows or three thousand, and the answer decides whether this is
     * an afternoon's work or a footnote. The multiples are the expensive kind — a pack size wrong
     * by a whole factor is a per-unit cost wrong by that factor, in a figure the buy list acts on —
     * so they are counted apart from the rows that merely disagree.
     */
    if (multipleCount > 0) {
      gaps.push(
        `${multipleCount.toLocaleString("en-US")} row${multipleCount === 1 ? " is" : "s are"} a whole multiple out, which is the expensive kind: the per-unit cost is wrong by that factor. For example ${multiples.join("; ")}`,
      );
    }
    if (differs > 0) {
      gaps.push(
        `${differs.toLocaleString("en-US")} row${differs === 1 ? "" : "s"} disagree by something other than a whole factor, which usually means one side is describing a different package rather than counting it differently`,
      );
    }
    if (unitDiffers > 0) {
      gaps.push(`${unitDiffers.toLocaleString("en-US")} rows are counted in a different unit from the FDA's — grams against tablets cannot be reconciled by any factor`);
    }
    if (unreadable > 0) {
      gaps.push(
        `${unreadable.toLocaleString("en-US")} rows could not be compared at all, most often because the FDA description stops at a container and never says what is inside. Not counted as disagreements.`,
      );
    }
    return {
      numerator: agree,
      denominator: comparable,
      gaps,
      note:
        "A pack size is a divisor: every per-unit cost is the pack cost over the units in the pack, so one wrong by a factor of six makes a drug look six times cheaper and the buy list recommends it.",
    };
  });

  const known = new Set(SPECS.map((s) => s.key));
  const rows = out.filter((m) => known.has(m.key));

  for (const m of rows) {
    await db
      .insert(schema.dataHealthCounts)
      .values({
        key: m.key,
        numerator: m.numerator,
        denominator: m.denominator,
        gaps: (m.gaps ?? []).join("\n"),
        note: m.note ?? null,
        measuredAt: m.measuredAt!,
        tookMs: m.tookMs,
      })
      .onConflictDoUpdate({
        target: schema.dataHealthCounts.key,
        set: {
          numerator: m.numerator,
          denominator: m.denominator,
          gaps: (m.gaps ?? []).join("\n"),
          note: m.note ?? null,
          measuredAt: m.measuredAt!,
          tookMs: m.tookMs,
        },
      });
  }

  return { measured: rows.length, skipped, tookMs: Date.now() - startedAll };
}

/** The stored counts, for the page. Reads one small table and nothing else. */
export async function storedHealth(): Promise<Measurement[]> {
  const rows = await db.select().from(schema.dataHealthCounts);
  return rows.map((r) => ({
    key: r.key,
    numerator: r.numerator,
    denominator: r.denominator,
    measuredAt: r.measuredAt,
    gaps: r.gaps ? r.gaps.split("\n").filter(Boolean) : [],
    note: r.note,
  }));
}

/** How long the last full measurement took, so the page can warn before somebody presses it again. */
export async function lastRun(): Promise<{ measuredAt: string | null; tookMs: number }> {
  const rows = await db.select().from(schema.dataHealthCounts);
  if (rows.length === 0) return { measuredAt: null, tookMs: 0 };
  return {
    measuredAt: rows.map((r) => r.measuredAt).sort().reverse()[0] ?? null,
    tookMs: rows.reduce((n, r) => n + (r.tookMs ?? 0), 0),
  };
}

/**
 * A name with everything but its letters and digits taken out, for comparing a file name to a
 * register name.
 *
 * "MCKCatalog_9_6_2026.txt" against "Mckesson" is not an equality question — the file name carries
 * a date, an extension and a spelling nobody controls. Squashed, one contains the other. This is
 * the only place in the module that matches loosely, and it decides nothing but which supplier a
 * date belongs to.
 */
const squashName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** "IPD 412, McKesson 88" — which supplier's rows are short of something, worst first. */
function gapsBySupplier(rows: { supplier: string | null }[], what: string): string[] {
  if (rows.length === 0) return [];
  const by = new Map<string, number>();
  for (const r of rows) {
    const k = (r.supplier ?? "").trim() || "(no supplier)";
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  const worst = [...by].sort((a, b) => b[1] - a[1]).slice(0, 4);
  return [`${rows.length.toLocaleString("en-US")} rows ${what} — ${worst.map(([k, n]) => `${k} ${n.toLocaleString("en-US")}`).join(", ")}`];
}
