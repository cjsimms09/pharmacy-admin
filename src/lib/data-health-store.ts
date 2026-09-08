import "server-only";
import { db, schema } from "@/db";
import { todayIso } from "./dates";
import { SPECS, type Measurement } from "./data-health";

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

  const timed = async (key: string, run: () => Promise<Omit<Measurement, "key" | "measuredAt">>) => {
    const t = Date.now();
    const m = await run();
    out.push({ key, measuredAt: today, tookMs: Date.now() - t, ...m });
  };

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
  const directory = await db.select({ ndc11: schema.drugDirectory.ndc11 }).from(schema.drugDirectory);
  const directoryNdcs = new Set(directory.map((r) => r.ndc11));
  await timed("fda-directory", async () => ({
    numerator: directoryNdcs.size,
    denominator: directoryNdcs.size,
    note: directoryNdcs.size === 0 ? "The FDA NDC directory has never been loaded." : null,
  }));

  // ── Invoices ─────────────────────────────────────────────────────
  const invoiceRows = await db
    .select({ id: schema.supplierInvoices.id, supplier: schema.supplierInvoices.supplier, totalCents: schema.supplierInvoices.totalCents })
    .from(schema.supplierInvoices);
  const lineRows = await db
    .select({
      invoiceId: schema.invoiceLines.invoiceId,
      supplierId: schema.invoiceLines.supplierId,
      supplier: schema.invoiceLines.supplier,
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

  // ── Invoice line → supplier → rebate ladder ──────────────────────
  const suppliers = await db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers);
  const programs = await db.select({ supplierId: schema.supplierRebatePrograms.supplierId }).from(schema.supplierRebatePrograms);
  const withLadder = new Set(programs.map((p) => p.supplierId));
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));

  await timed("invoice-supplier-ladder", async () => {
    const placed = lineRows.filter((l) => l.supplierId && withLadder.has(l.supplierId)).length;
    const unplaced = lineRows.filter((l) => !l.supplierId);
    const noLadder = lineRows.filter((l) => l.supplierId && !withLadder.has(l.supplierId));
    const gaps: string[] = [];
    if (unplaced.length > 0) {
      const names = [...new Set(unplaced.map((l) => (l.supplier ?? "").trim() || "(no supplier printed)"))];
      gaps.push(`${unplaced.length} line${unplaced.length === 1 ? "" : "s"} resolve to no supplier on the register — printed as ${names.slice(0, 3).join(", ")}`);
    }
    if (noLadder.length > 0) {
      const names = [...new Set(noLadder.map((l) => supplierName.get(l.supplierId!) ?? "?"))];
      gaps.push(`${noLadder.length} line${noLadder.length === 1 ? "" : "s"} belong to a supplier with no rebate ladder on file — ${names.slice(0, 3).join(", ")}`);
    }
    return {
      numerator: placed,
      denominator: lineRows.length,
      gaps,
      note: "A line resolving to no supplier leaves the rebate arithmetic without a word, which is how eight lines and $78.50 went missing.",
    };
  });

  // ── On-hand ──────────────────────────────────────────────────────
  const onHand = await db.select({ code: schema.onHand.code, codeKind: schema.onHand.codeKind }).from(schema.onHand);
  await timed("on-hand", async () => ({
    numerator: onHand.length,
    denominator: onHand.length,
    note: onHand.length === 0 ? "No on-hand count has ever been received. Nothing can value the shelf until one is." : null,
  }));

  const catalogueNdcs = new Set(catalogue.map((r) => r.ndc11).filter(isNdc));
  await timed("onhand-catalogue", async () => ({
    numerator: onHand.filter((r) => r.codeKind === "ndc11" && catalogueNdcs.has(r.code)).length,
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
    .select({ rxNumber: schema.claimPayments.rxNumber, fillNumber: schema.claimPayments.fillNumber, dateFilled: schema.claimPayments.dateFilled })
    .from(schema.claimPayments);
  const bank = await db.select({ id: schema.bankLines.id }).from(schema.bankLines);

  await timed("remits", async () => ({
    numerator: payments.length,
    denominator: payments.length,
    note: payments.length === 0 ? "No 835 remittance line has been loaded, so nothing says what a plan actually paid." : null,
  }));

  await timed("bank", async () => ({
    numerator: bank.length,
    denominator: bank.length,
    note: bank.length === 0 ? "No bank line has been loaded, so no payment can be traced to cash in the account." : null,
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
          ? "No bank line has been loaded, so no fill can be traced to cash actually received, whatever the remittances say."
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
    const hit = [...fills.values()].filter((f) =>
      classed.has([f.bin ?? "", f.pcn ?? "", f.groupNumber ?? ""].join("|").toUpperCase()),
    ).length;
    return {
      numerator: hit,
      denominator: fillCount,
      note: "Which law applies — and so whether the Kansas floor applies at all — is decided by the plan's class.",
    };
  });

  /*
   * ── Two rows this cannot measure soundly, and so does not ──
   *
   * "claim → contract" needs the contract matcher run against every fill, which means parsing every
   * stored extraction. That is session 1's module and the answer is currently 0 of 1,081 for a
   * reason no count would explain: governs() reads BIN, PCN and group, and the contracts on file
   * name networks and chain codes. Measuring it here would print a zero without the sentence that
   * makes it actionable, and the sentence is the point.
   *
   * "catalogue row → FDA package size" needs pack sizes and FDA package descriptions compared as
   * quantities — "6 x 1 ML" against "PACKAGE OF 6 SYRINGES" — and a wrong reading of that produces
   * exactly the cross-unit error the row exists to catch. A guess here would be worse than nothing.
   *
   * Both show as "not measured" on the page, which is honest and visible, rather than as a number
   * somebody would act on.
   */
  skipped.push("claim-contract", "catalogue-package");

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
