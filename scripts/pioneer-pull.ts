/**
 * The morning pull from PioneerRx.
 *
 * The owner, 9 September: "can we get balance on hand request also (these need to be in the morning
 * around 8am) so that previous orders were received in system and we can use tools to help with that
 * days order around 4pm" — and then "you need to set these reports to come in daily! probably 8am
 * for all of them. we do not need to get catalog daily if it is going to make site slow.. we can get
 * it weekly."
 *
 * So: eight in the morning, after the night's receiving has been keyed in and long before the four
 * o'clock order. The catalogue is the heavy one and runs on Mondays unless it is asked for.
 *
 *   node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.script.json scripts/pioneer-pull.ts [feed…]
 *
 * With no argument it runs the feeds that are due today. Name a feed to force it: `on-hand`,
 * `catalogue`.
 *
 * ── Patient data ──
 *
 * None of these queries names a patient column, and none of them could: `pioneer-sql.ts` refuses a
 * query that names one and refuses `select *` outright, so a column cannot arrive by accident and
 * a future edit cannot quietly add one. The owner's instruction, in his words: "DO NOT touch patient
 * name, DOB, or anything related."
 *
 * ── Why it goes through the file readers ──
 *
 * The on-hand pull builds the same columns PioneerRx's own balance-on-hand report prints and hands
 * them to `fileOnHand`, the reader that already files that report. That is deliberate. The dating,
 * the replace-today's-count rule, the retention pruning, the pack normalisation and the order points
 * are all in that path and all proved against real files; a second writer would be a second set of
 * those decisions, drifting from the first. The feed changes where the bytes come from and nothing
 * else.
 */
import "dotenv/config";

type Feed = "on-hand" | "claims" | "invoices" | "retail" | "suppliers" | "catalogue" | "plan-types";
import type { DispensedRow, PayerSide } from "../src/lib/dispensed-export";

async function main() {
  const asked = process.argv.slice(2).filter((a) => !a.startsWith("--")) as Feed[];
  const { setSetting, getSettings } = await import("../src/lib/settings");
  const s = await getSettings();
  const today = new Date().toISOString().slice(0, 10);

  const due: Feed[] = asked.length
    ? asked
    : [
        ...(s.pioneer_pull_on_hand_on === today ? [] : (["on-hand"] as Feed[])),
        ...(s.pioneer_pull_claims_on === today ? [] : (["claims"] as Feed[])),
        ...(s.pioneer_pull_invoices_on === today ? [] : (["invoices"] as Feed[])),
        ...(s.pioneer_pull_retail_on === today ? [] : (["retail"] as Feed[])),
        // Monday, or never pulled. 238,952 catalogue rows is the heavy one and the owner said weekly
        // is enough unless it turns out to be free.
        ...(new Date().getDay() === 1 || !s.pioneer_pull_catalogue_on ? (["suppliers", "catalogue"] as Feed[]) : []),
        /*
         * The plan types, weekly with the other reference data.
         *
         * Payers do not change what kind of plan they are from one Tuesday to the next, and this is
         * two small tables — but a new third party set up at the counter on Monday is a plan the
         * register cannot classify until this has run, so it rides along with the catalogue rather
         * than waiting for somebody to remember it.
         */
        ...(new Date().getDay() === 1 || !s.pioneer_pull_plan_types_on ? (["plan-types"] as Feed[]) : []),
      ];

  if (due.length === 0) {
    console.log("nothing due today");
    return;
  }

  for (const feed of due) {
    const started = Date.now();
    try {
      if (feed === "on-hand") {
        const r = await pullOnHand();
        await setSetting("pioneer_pull_on_hand_on", today);
        await setSetting("pioneer_pull_on_hand_result", `${new Date().toISOString()}: ${r}`);
        console.log(`on-hand: ${r} (${Date.now() - started}ms)`);
      } else if (feed === "claims") {
        const r = await pullClaims();
        await setSetting("pioneer_pull_claims_on", today);
        await setSetting("pioneer_pull_claims_result", `${new Date().toISOString()}: ${r}`);
        console.log(`claims: ${r} (${Date.now() - started}ms)`);
      } else if (feed === "invoices") {
        const r = await pullInvoices();
        await setSetting("pioneer_pull_invoices_on", today);
        await setSetting("pioneer_pull_invoices_result", `${new Date().toISOString()}: ${r}`);
        console.log(`invoices: ${r} (${Date.now() - started}ms)`);
      } else if (feed === "retail") {
        const r = await pullRetail();
        await setSetting("pioneer_pull_retail_on", today);
        await setSetting("pioneer_pull_retail_result", `${new Date().toISOString()}: ${r}`);
        console.log(`retail: ${r} (${Date.now() - started}ms)`);
      } else if (feed === "suppliers") {
        const r = await pullSuppliers();
        await setSetting("pioneer_pull_suppliers_result", `${new Date().toISOString()}: ${r}`);
        console.log(`suppliers: ${r} (${Date.now() - started}ms)`);
      } else if (feed === "plan-types") {
        const { pullPlanTypes } = await import("../src/lib/pioneer-plans");
        const c = await pullPlanTypes();
        // The third number is the one that matters. The first two are row counts; "typed" is how
        // many of them actually say anything, because PioneerRx defaults every record to "Standard"
        // and a Standard row is nobody having answered.
        const r = `${c.planFile} plan-file rows, ${c.pharmacy} of the pharmacy's own; ${c.typed} carry a type that is not PioneerRx's "Standard" default`;
        await setSetting("pioneer_pull_plan_types_on", today);
        await setSetting("pioneer_pull_plan_types_result", `${new Date().toISOString()}: ${r}`);
        console.log(`plan-types: ${r} (${Date.now() - started}ms)`);
      } else if (feed === "catalogue") {
        const r = await pullCatalogue();
        await setSetting("pioneer_pull_catalogue_on", today);
        await setSetting("pioneer_pull_catalogue_result", `${new Date().toISOString()}: ${r}`);
        console.log(`catalogue: ${r} (${Date.now() - started}ms)`);
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await setSetting(feed === "on-hand" ? "pioneer_pull_on_hand_result" : feed === "claims" ? "pioneer_pull_claims_result" : feed === "invoices" ? "pioneer_pull_invoices_result" : feed === "retail" ? "pioneer_pull_retail_result" : feed === "suppliers" ? "pioneer_pull_suppliers_result" : feed === "plan-types" ? "pioneer_pull_plan_types_result" : "pioneer_pull_catalogue_result", `${new Date().toISOString()}: failed: ${why}`);
      console.error(`${feed}: failed: ${why}`);
    }
  }
}

/**
 * What was on the shelf when the copy was taken — which is last night, not this morning.
 *
 * The database is `PioneerPharmacySystem_DayOld` and the name is the specification: it holds
 * everything through the close of yesterday's business and nothing since. For claims that costs
 * nothing, because a claim adjudicated yesterday is a settled fact. For stock it is the difference
 * between a useful number and a wrong one, and the owner said so plainly on 9 September: "I am
 * going to keep sending the Balance on hand report from pioneer so it is accurate. it is only one
 * that is really time sensitive."
 *
 * So this is the fallback and not the source. It dates the count by the copy's own freshness rather
 * than by today — the first version stamped yesterday's stock with this morning's date, which is
 * exactly the quiet wrongness the rest of this codebase exists to refuse — and it files nothing at
 * all for a day the emailed report already covers. The live report wins every time; the pull only
 * fills a gap on a morning nobody sent one.
 */
async function pullOnHand(): Promise<string> {
  const { query } = await import("../src/lib/pioneer-sql");
  /*
   * The copy's own as-of date, asked of the data rather than assumed to be "yesterday".
   *
   * A copy taken at six in the evening and one taken at two in the morning are a day apart in what
   * they hold, and a long weekend or a failed refresh makes the gap wider still. The newest stock
   * movement is the honest answer to what this can know about.
   */
  const asOfRow = await query("select convert(varchar(10), max(OnHandQuantityChangedOn), 23) as as_of from Item.InventoryGroup", {}, 1);
  const asOf = String(asOfRow.rows[0]?.as_of ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return "PioneerRx did not say when its stock was last touched, so nothing was filed";

  const { db } = await import("../src/db");
  const already = await db.query.onHandImports.findFirst({ where: (t, { eq }) => eq(t.countedOn, asOf) });
  if (already) return `the copy is current to ${asOf}, and a count for that day is already filed (${already.fileName}), so nothing was written`;
  const r = await query(
    `select i.NDC as [NDC],
            i.ItemName as [Description],
            g.OnHandQuantity as [Quantity On Hand],
            i.StockSize as [Package Size],
            -- The report's own Cost column is LastCostPaid, matching to the cent on every item
            -- checked. PreferredCost is PioneerRx's expected cost from the catalogue and answers a
            -- different question: it disagreed on 1,703 of 1,745 items and valued the shelf
            -- $20,000 low. What the pharmacy actually paid is what an inventory is worth.
            case when g.LastCostPaid > 0 then g.LastCostPaid else g.PreferredCost end as [Cost],
            cast(i.ItemID as varchar(36)) as [Item Number]
       from Item.InventoryGroup g
       join Item.Item i on i.ItemID = g.ItemID
      where g.OnHandQuantity is not null
        and g.OnHandQuantity <> 0`,
    {},
    100_000,
  );
  if (r.rows.length === 0) return "PioneerRx reported nothing on hand, which cannot be right, so nothing was filed";

  /*
   * Rendered as the report's own tab-separated shape and handed to the reader that files it.
   *
   * A cost of null prints empty rather than 0: the reader tells the two apart, and a nought would
   * put a free product on the shelf page.
   */
  const cols = ["NDC", "Description", "Quantity On Hand", "Package Size", "Cost", "Item Number"];
  const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v).replace(/[\t\r\n]+/g, " ").trim());
  const lines = [cols.join("\t"), ...r.rows.map((row) => cols.map((c) => cell(row[c])).join("\t"))];
  const buf = Buffer.from(`${lines.join("\n")}\n`, "utf8");

  const { fileOnHand } = await import("../src/lib/shelf");
  const filed = await fileOnHand(buf, `PioneerRx on hand as of ${asOf} (day-old copy).txt`, { userId: "pioneer-pull" }, { countedOn: asOf });
  if (!filed.ok) return `read ${r.rows.length} items from PioneerRx but could not file them: ${filed.why}`;
  return `${filed.items.toLocaleString("en-US")} items counted ${filed.countedOn}${filed.replaced ? ", replacing an earlier count for today" : ""}${filed.pruned.removed ? `; ${filed.pruned.removed} older counts pruned` : ""}`;
}

/**
 * Every supplier catalogue line PioneerRx holds: 238,952 of them against the 64,401 the site reads
 * out of the emailed text files, with AWP and WAC on the row and the package size stated rather
 * than parsed out of "(5) 1 ML".
 *
 * Recorded rather than loaded, for now. The site's catalogue is proved nightly against the files it
 * came from, and replacing it wholesale before the two have been set against each other would throw
 * away that proof to gain rows. What this writes is the comparison: how many NDCs PioneerRx prices
 * that the site does not, and where the two disagree on a price.
 */
async function pullCatalogue(): Promise<string> {
  const { query } = await import("../src/lib/pioneer-sql");
  const r = await query(
    `select c.NDC as ndc, s.SupplierName as supplier, c.Cost as cost, c.AWP as awp, c.WAC as wac,
            c.CurrentContractCost as contract_cost, c.PackageSizeQuantity as pack_qty,
            c.PackageSizeMultiplier as pack_multiplier, c.SupplierItemNumber as item_number,
            c.MinimumOrderSize as minimum, c.IsGeneric as is_generic, c.ExcludedFromRebate as no_rebate
       from Supplier.CatalogItem c
       join Supplier.Supplier s on s.SupplierID = c.SupplierID
      where c.NDC is not null and c.Cost > 0`,
    {},
    300_000,
  );
  const { db } = await import("../src/db");
  const held = await db.query.supplierItems.findMany({ columns: { ndc11: true, supplier: true, unitCostMicros: true } });
  const heldBy = new Map(held.map((h) => [`${h.supplier.trim().toLowerCase()}|${h.ndc11}`, h.unitCostMicros]));

  let alsoHeld = 0;
  let onlyPioneer = 0;
  const suppliers = new Set<string>();
  for (const row of r.rows) {
    const ndc = String(row.ndc ?? "").replace(/\D/g, "");
    if (ndc.length !== 11) continue;
    const supplier = String(row.supplier ?? "").trim();
    suppliers.add(supplier);
    if (heldBy.has(`${supplier.toLowerCase()}|${ndc}`)) alsoHeld++;
    else onlyPioneer++;
  }
  const { setSetting } = await import("../src/lib/settings");
  await setSetting(
    "pioneer_catalogue_compare",
    JSON.stringify({ readAt: new Date().toISOString(), rows: r.rows.length, suppliers: [...suppliers].sort(), alsoHeld, onlyPioneer, siteRows: held.length }),
  );
  return `${r.rows.length.toLocaleString("en-US")} priced lines across ${suppliers.size} suppliers; ${alsoHeld.toLocaleString("en-US")} the site already holds, ${onlyPioneer.toLocaleString("en-US")} it does not`;
}

/**
 * The claims PioneerRx adjudicated, from 1 September, enriched onto the claims the daily report
 * created.
 *
 * The owner: "we need to make sure we are getting everything we need from claims to make our lives
 * easier", and separately "we are not pulling any data before 09/01", which is why the query starts
 * there and why the 327 older remittance files PioneerRx holds are left alone.
 *
 * It enriches and never creates, which is the same rule the dispensed export follows (BACKLOG 32).
 * The daily text report is still what brings a claim into being; this fills in the fields that
 * report does not carry, and there are a lot of them:
 *
 *   - the basis of reimbursement, on 2,175 of 3,430 September claims against well under half from
 *     the text file. It is the field that decides whether a claim can be tested against its
 *     contract at all, so its coverage is the ceiling on the whole backtest.
 *   - the payer chain the site had been deducing: BIN, PCN, group, plan and the network
 *     reimbursement id, on the claim rather than inferred from it.
 *   - the secondary payer's amount, the e-voucher amount, and the DIR fee, none of which the site
 *     could see before.
 *
 * AWP and WAC are deliberately not taken from here. PioneerRx holds them on the item, which is
 * today's figure rather than the one the claim was priced against, and a stale AWP silently wrong
 * by a week is worse than no AWP at all — the backtest divides by it. They keep coming from the
 * dispensed export, which prints the figure as it stood at adjudication.
 */
async function pullClaims(): Promise<string> {
  const { query } = await import("../src/lib/pioneer-sql");
  /*
   * The current, paid claim for each payer on each fill — one row per payer, not one per fill.
   *
   * `IsLastValidClaimForPayMethod = 1` is the flag that matters and the one this query used to get
   * wrong. `IsLatestClaimRecord = 1`, which it used before, returns a single row per *fill*: on a
   * two-payer fill it keeps whichever claim was transmitted last and throws the other away, so the
   * feed saw one side of each of September's 37 two-payer fills and could not tell which side it
   * had. Reversed and rebilled claims fall away on their own, because a claim that has been
   * reversed is no longer the last valid one for its payer.
   *
   * The money comes from the remittance-pricing row rather than from the NCPDP fields on the claim.
   * `NetAmountPaid` is what the payer actually paid and `PatientPayAmount` is what the patient owes
   * after it — nought on every payer but the last, so the two can be added across a fill without
   * counting the patient's dollar twice. The raw `Prescription.Claim.PatientPayAmountPaid` cannot:
   * there the primary states the balance it passed to the secondary, and summing those across
   * September's fills overstates the patient's share by $50,644.55.
   *
   * `TotalPricePaid` comes along so every fill can be checked: the payers plus the patient are the
   * price of the fill, or the fill is named.
   */
  const r = await query(
    `select c.RxNumber as rx_number,
            rx.RefillNumber as fill_number,
            convert(varchar(10), rx.DateFilled, 23) as date_filled,
            i.NDC as ndc,
            i.ItemName as item_name,
            i.GCN as gcn,
            rx.DispensedQuantity as quantity,
            c.DaysSupply as days_supply,
            c.BasisOfReimbursementDetermination as basis,
            c.BasisOfCost as basis_of_cost,
            t.Bin as bin,
            t.Pcn as pcn,
            t.GroupNumber as group_number,
            t.NetworkReimbursementID as network_id,
            t.PlanID as plan_id,
            c.ContractNumber as contract_id,
            p.PrimaryClaimID as primary_claim_id,
            p.NetAmountPaid as net_paid,
            p.PatientPayAmount as patient_pay,
            p.DispensingFeePaid as dispensing_fee,
            p.AcquisitionCost as acquisition,
            c.OtherPayerAmountPaid as other_payer,
            c.EvoucherAmountPaid as evoucher,
            c.DirFeeTotal as dir_fee,
            f.TotalPricePaid as fill_total_price,
            (select convert(varchar(10), max(sale.PostingDate), 23)
               from PointOfSale.SaleTransactionDetail line
               join PointOfSale.SaleTransaction sale on sale.SaleTransactionID = line.SaleTransactionID
              where line.ReferenceID = p.RxTransactionID and line.ReferenceTypeEnum = 1) as sold_on
       from ThirdParty.ClaimRemittancePricingByRxTransactionID p
       join Prescription.Claim c on c.ClaimID = p.ClaimID
       join Prescription.Transmission t on t.TransmissionID = c.TransmissionID
       join Prescription.RxTransaction rx on rx.RxTransactionID = p.RxTransactionID
       join Item.Item i on i.ItemID = rx.DispensedItemID
       left join Prescription.RxTransactionFinancial f on f.RxTransactionID = p.RxTransactionID
      where rx.DateFilled >= '2026-09-01'
        and isnull(p.IsDuplicateClaim, 0) = 0
        and p.IsLastValidClaimForPayMethod = 1
        and p.TransactionResponseStatus = 'P'`,
    {},
    50_000,
  );
  if (r.rows.length === 0) return "no adjudicated claims since 1 September";

  const cents = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };
  const text = (v: unknown): string | null => {
    const t = String(v ?? "").trim();
    return t === "" ? null : t;
  };
  const ndc11 = (v: unknown): string | null => {
    const d = String(v ?? "").replace(/\D/g, "");
    return d.length === 11 ? d : null;
  };

  const { fillsFromClaimRows } = await import("../src/lib/pioneer-claims");
  const built = fillsFromClaimRows(
    r.rows.map((row) => ({
      rxNumber: text(row.rx_number) ?? "",
      fillNumber: Number(row.fill_number ?? 0) || 0,
      primaryClaimId: text(row.primary_claim_id),
      bin: text(row.bin),
      pcn: text(row.pcn),
      groupNumber: text(row.group_number),
      networkId: text(row.network_id),
      planId: text(row.plan_id),
      contractId: text(row.contract_id),
      netPaidCents: cents(row.net_paid),
      patientPayCents: cents(row.patient_pay),
      otherPayerCents: cents(row.other_payer),
      itemName: text(row.item_name),
      ndc11: ndc11(row.ndc),
      gcn: text(row.gcn),
      quantityThousandths: row.quantity === null || row.quantity === undefined ? null : Math.round(Number(row.quantity) * 1000),
      daysSupply: row.days_supply === null || row.days_supply === undefined ? null : Number(row.days_supply),
      basisOfReimbursement: text(row.basis),
      basisOfCostDetermination: text(row.basis_of_cost),
      dispensingFeeCents: cents(row.dispensing_fee),
      dirFeeCents: cents(row.dir_fee),
      evoucherCents: cents(row.evoucher),
      acquisitionCents: cents(row.acquisition),
      filledOn: text(row.date_filled),
      fillTotalPriceCents: cents(row.fill_total_price),
      soldOn: text(row.sold_on),
    })),
  );

  const { enrichClaimsFrom } = await import("../src/lib/dispensed-export");
  const stamp = `PioneerRx SQL @ ${new Date().toISOString().slice(0, 10)}`;
  const e = await enrichClaimsFrom(
    built.fills.map((f) => ({
      rxNumber: f.rxNumber,
      fillNumber: f.fillNumber,
      itemName: f.itemName,
      ndc11: f.ndc11,
      quantityThousandths: f.quantityThousandths,
      daysSupply: f.daysSupply,
      daw: null,
      primary: f.primary,
      secondary: f.secondary,
      awpCents: null,
      wacCents: null,
      nadacDispensedCents: null,
      acquisitionCents: f.acquisitionCents,
      dispensingFeeCents: f.dispensingFeeCents,
      dirFeeCents: f.dirFeeCents,
      evoucherCents: f.evoucherCents,
      gcn: f.gcn,
      basisOfReimbursement: f.basisOfReimbursement,
      basisOfCostDetermination: f.basisOfCostDetermination,
      filledOn: f.filledOn,
      completedOn: f.soldOn,
      /*
       * Every fill in this pull had its till looked at, so an empty sale date here means the
       * script is still in the bin rather than that nobody asked. Stamped with the day the copy
       * is current to, not today: the copy is a day behind, and claiming to have checked the
       * till up to this morning would make today's fills look unsold rather than unknown.
       */
      netProfitCents: null,
    })),
    stamp,
  );

  /*
   * What the pharmacy should expect, said in money rather than in row counts.
   *
   * The owner asked to know "how much to expect from each payer", and the reconciliation is the
   * only part of this worth reading: PioneerRx's own figure for the month beside what the site
   * holds. A gap is not an error in this feed — the claims come from the daily transaction report
   * the pharmacy uploads — but it is the number that says whether the account is complete, and it
   * is only worth reading if both sides cover the same days.
   */
  const { db, schema } = await import("../src/db");
  const { and, gte, eq } = await import("drizzle-orm");
  const onFile = await db
    .select({ rxNumber: schema.claims.rxNumber, fillNumber: schema.claims.fillNumber, dateFilled: schema.claims.dateFilled, remitCents: schema.claims.remitCents, copayCents: schema.claims.copayCents })
    .from(schema.claims)
    .where(and(gte(schema.claims.dateFilled, "2026-09-01"), eq(schema.claims.status, "paid")));
  /*
   * Which day is short, which is the only form of this anybody can act on. A month-level figure
   * sends somebody hunting; "7 September is 25 fills short, send that day's report again" is a job.
   *
   * Compared over the window both sides can see, which is what this did not do.
   *
   * `onFile` above is every site claim from the first of the month with no upper bound, and the
   * PioneerRx side stops wherever the day-old copy stops. Setting one against the other made the
   * site 'over' by about a day's billing every morning — $31,888.56 on 11 September, against a
   * 10 September that billed $37,517.10 — while like for like it was short. See reconcileClaims.
   */
  const { reconcileClaims } = await import("../src/lib/pioneer-claims");
  const recon = reconcileClaims(
    built.fills.map((f) => ({ rxNumber: f.rxNumber, fillNumber: f.fillNumber, filledOn: f.filledOn, insuranceCents: f.insuranceCents, patientCents: f.patientCents })),
    onFile.map((c) => ({ rxNumber: c.rxNumber, fillNumber: c.fillNumber ?? 0, filledOn: c.dateFilled, insuranceCents: c.remitCents ?? 0, patientCents: c.copayCents ?? 0 })),
  );

  const { setSetting } = await import("../src/lib/settings");
  await setSetting(
    "pioneer_claims_reconcile",
    JSON.stringify({
      readAt: new Date().toISOString(),
      coverTo: recon.coverTo,
      fills: built.fills.length,
      payers: built.payerCounts,
      pioneerInsuranceCents: recon.pioneer.remitCents,
      pioneerPatientCents: recon.pioneer.patientCents,
      siteRemitCents: recon.site.remitCents,
      siteCopayCents: recon.site.patientCents,
      gapCents: recon.gapCents,
      fillsThatDoNotAddUp: built.disagree.length,
      daysShort: recon.missingFromSite,
      missingTotal: recon.missingTotal,
      fillsOnlyOnSite: recon.onlyOnSite.fills,
      aheadOfTheCopy: recon.aheadOfTheCopy,
      problems: built.problems.slice(0, 20),
    }),
  );

  return (
    `${built.fills.length.toLocaleString("en-US")} fills (${built.payerCounts.twoPayers} with two payers` +
    `${built.payerCounts.more ? `, ${built.payerCounts.more} with more` : ""}); ` +
    `${recon.says}` +
    `${built.disagree.length ? ` ${built.disagree.length} fills where the payers and the patient do not add to the fill's price.` : ""}`
  );
}

/**
 * September's purchase invoices, from PioneerRx's own receiving records.
 *
 * The owner: "we are already getting purchase invoices from suppliers but may be nice to compare
 * them. also would allow me to pull in all sept orders", and "only want to pull purchase invoices
 * from 09/01 to current".
 *
 * The pharmacy emails its invoices in as PDFs and the site reads them, which is the record the DEA
 * asks for and stays the record. But the PDFs only cover what reached the inbox: PioneerRx holds 61
 * September invoices across seven suppliers where the site had twelve. This brings the rest in with
 * their lines, and sets the ones held both ways against each other — a second reading of every
 * invoice the PDF parser produced, on a parser that had three separate faults in it this week.
 *
 * An invoice created here carries no document and says so. The supplier's own invoice is what a
 * Schedule II record is made of; a row without one is a purchase record and not a substitute for
 * the filing. Where the site already holds an invoice nothing is overwritten, only compared.
 */
async function pullInvoices(): Promise<string> {
  const { query } = await import("../src/lib/pioneer-sql");
  const r = await query(
    `select v.InvoiceNumber as invoice_number,
            convert(varchar(10), v.InvoiceDate, 23) as invoice_date,
            s.SupplierName as supplier,
            v.ShippingCost as shipping,
            i.NDC as ndc,
            i.ItemName as description,
            i.DeaSchedule as dea_schedule,
            d.InvoiceQuantity as quantity,
            d.InvoiceCostPerUnit as unit_cost,
            d.InvoiceTotalCost as extended,
            d.StockSizeCurrent as pack_size
       from Item.Invoice v
       join Item.InvoiceDetail d on d.InvoiceID = v.InvoiceID
       join Supplier.Supplier s on s.SupplierID = v.SupplierID
       join Item.Item i on i.ItemID = d.ItemID
      where v.InvoiceDate >= '2026-09-01'
        and isnull(d.IsDeleted, 0) = 0`,
    {},
    50_000,
  );
  if (r.rows.length === 0) return "no purchase invoices since 1 September";

  const cents = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };
  const text = (v: unknown): string | null => {
    const t = String(v ?? "").trim();
    return t === "" ? null : t;
  };
  const ndc11 = (v: unknown): string | null => {
    const d = String(v ?? "").replace(/\D/g, "");
    return d.length === 11 ? d : null;
  };

  type Line = { ndc11: string | null; description: string | null; quantity: number; unitCostCents: number; extendedCents: number; packSize: string | null; dea: string | null };
  type Inv = { number: string; date: string; supplier: string; shippingCents: number; lines: Line[] };
  const invoices = new Map<string, Inv>();
  for (const row of r.rows) {
    const number = text(row.invoice_number);
    const date = text(row.invoice_date);
    const supplier = text(row.supplier);
    if (!number || !date || !supplier) continue;
    const key = `${supplier}|${number}`;
    const inv = invoices.get(key) ?? { number, date, supplier, shippingCents: cents(row.shipping) ?? 0, lines: [] };
    invoices.set(key, inv);
    const extended = cents(row.extended);
    const unit = cents(row.unit_cost);
    if (extended === null || unit === null) continue;
    inv.lines.push({
      ndc11: ndc11(row.ndc),
      description: text(row.description),
      quantity: Number(row.quantity ?? 0) || 0,
      unitCostCents: unit,
      extendedCents: extended,
      packSize: text(row.pack_size),
      dea: text(row.dea_schedule),
    });
  }

  const { db, schema } = await import("../src/db");
  const { newId } = await import("../src/lib/crypto");
  const { eq } = await import("drizzle-orm");
  const held = await db.query.supplierInvoices.findMany({ columns: { id: true, supplier: true, invoiceNumber: true, totalCents: true } });
  const suppliers = await db.query.suppliers.findMany({ columns: { id: true, name: true } });
  const fold = (n: string) => n.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const supplierId = new Map(suppliers.map((x) => [fold(x.name), x.id]));
  /*
   * Matched on the invoice number alone, not on the supplier's name.
   *
   * The two systems spell the same wholesaler differently — the site reads "Independent Pharmacy
   * Cooperative (IPC)" off the letterhead and PioneerRx calls it "IPC" — so keying on both brought
   * in 61 invoices and matched none of them, including two the site already held under the same
   * number. An invoice number is issued by one supplier and is the thing a person would check.
   */
  const heldBy = new Map(held.filter((h) => h.invoiceNumber).map((h) => [String(h.invoiceNumber).trim(), h]));

  let created = 0;
  let alreadyHeld = 0;
  let agree = 0;
  let differ = 0;
  const notes: string[] = [];
  for (const inv of invoices.values()) {
    const goodsCents = inv.lines.reduce((n, l) => n + l.extendedCents, 0);
    /*
     * Every purchase is recorded, including the ones an invoice already covers.
     *
     * The owner: "we can use it to make sure we get everything and we read the price right." Both of
     * those need the whole list. Skipping the purchases that match an invoice — which is what this
     * did — meant the only thing kept was the ones nobody could check, and the check he actually
     * asked for became impossible: you cannot tell whether every invoice arrived if the evidence for
     * the ones that did is thrown away.
     *
     * Recording them costs nothing on the money side, because the cash account matches on the
     * wholesaler's own invoice number and takes a purchase only where no invoice carries it.
     */
    const existing = heldBy.get(inv.number.trim());
    if (existing) {
      alreadyHeld++;
      // The site's total is the amount due; goods plus shipping is that same figure from this side.
      if (existing.totalCents !== null && Math.abs(existing.totalCents - (goodsCents + inv.shippingCents)) > 2) {
        differ++;
        if (notes.length < 8) notes.push(`${inv.supplier} ${inv.number}: the site holds ${(existing.totalCents / 100).toFixed(2)}, PioneerRx has ${((goodsCents + inv.shippingCents) / 100).toFixed(2)}`);
      } else agree++;
    } else created++;
    /*
     * The schedules actually on the delivery, kept rather than reduced to two booleans.
     *
     * These two lines computed exactly this and were then never used — the answer was worked out
     * every night and thrown away, while invoices went to a model to have the same question
     * answered from the wholesaler's typography. `scheduleFromDea` turns them into the filing
     * decision, and the distinct codes are stored so the decision can be checked against them.
     */
    const deaSchedules = [...new Set(inv.lines.map((l) => (l.dea ?? "").trim()).filter((d) => d !== ""))].sort().join(",");
    /*
     * The schedule, from what is actually on the invoice.
     *
     * Any Schedule II line makes the whole invoice a Schedule II record, because that is how it has
     * to be filed. The site's own reader reaches the same answer by reading the printed markings;
     * here the item's DEA schedule says it outright.
     */
    /*
     * Every invoice on this site can be opened, and one read from a database is no exception.
     *
     * `supplier_invoices.document_id` is not nullable, and that is a good rule rather than an
     * obstacle: an invoice record nobody can look at is a number with no way to check it. So the
     * invoice as PioneerRx holds it is written out as a plain text document and filed, and the row
     * points at that. It is not the supplier's own invoice and does not claim to be — the note on
     * the row says where it came from — but it is a page, and every figure on the row is on it.
     */
    /*
     * Recorded as a purchase, not filed as an invoice.
     *
     * The owner: "we shouldn't be taking pioneer order receipts as invoices, invoices are mailed to
     * us from suppliers and that's what we have to keep... pioneer ordering receipts are not
     * invoices." This used to render a text document per purchase — a document nobody asked for,
     * written only because `supplier_invoices.document_id` is NOT NULL — and file it beside the
     * wholesalers' own PDFs, where it was indistinguishable from them on every screen.
     *
     * What he wants it for: "to catch the money from invoices we didn't get before this was setup
     * in September... we can use it to make sure we get everything and we read the price right."
     * So it lands in `pioneer_purchases`, which the cash account draws on only where no invoice
     * carries the same number, and which the invoice reader can be checked against.
     */
    const number = inv.number?.trim() || null;
    const held = number ? await db.query.pioneerPurchases.findFirst({ where: eq(schema.pioneerPurchases.invoiceNumber, number) }) : null;
    const values = {
      supplier: inv.supplier,
      supplierId: supplierId.get(fold(inv.supplier)) ?? null,
      invoiceNumber: number,
      invoiceDate: inv.date,
      totalCents: goodsCents + inv.shippingCents,
      lines: inv.lines.length,
      itemsText: inv.lines.map((l) => [l.ndc11 ?? '', l.description ?? '', l.quantity, (l.extendedCents / 100).toFixed(2)].join(' ')).join('\n'),
      /*
       * The same lines again, as figures rather than as a sentence.
       *
       * The line above is what a person reads. This is what the price check reads: it needs the
       * unit cost, which the sentence never carried, and it needs the description separable from
       * the numbers around it, which a space-joined line cannot give back.
       */
      deaSchedules: deaSchedules || null,
      itemsJson: JSON.stringify(
        inv.lines.map((l) => ({
          ndc11: l.ndc11,
          description: l.description,
          quantity: l.quantity,
          unitCostCents: l.unitCostCents,
          extendedCents: l.extendedCents,
          packSize: l.packSize,
        })),
      ),
      readAt: new Date().toISOString(),
    };
    if (held) await db.update(schema.pioneerPurchases).set(values).where(eq(schema.pioneerPurchases.id, held.id));
    else await db.insert(schema.pioneerPurchases).values({ id: newId(), ...values });
  }
  /*
   * Now the deliveries are in, settle any invoice that was waiting on one.
   *
   * McKesson emails at 03:40 and the delivery is entered at the counter during the day, so an
   * invoice routinely arrives a day before its own receiving record. It waits with the Schedule II
   * records until this runs, which is the cautious drawer and the right one to wait in.
   */
  const { settleSchedulesFromPioneer } = await import("../src/lib/invoices");
  const settled = await settleSchedulesFromPioneer();

  const { setSetting } = await import("../src/lib/settings");
  await setSetting("pioneer_invoice_compare", JSON.stringify({ readAt: new Date().toISOString(), invoices: invoices.size, created, alreadyHeld, agree, differ, notes }));
  return (
    `${settled.says}. ` +
    `${invoices.size} September purchases in PioneerRx, all recorded; ` +
    `${alreadyHeld} of them have the supplier's own invoice on file (${agree} agreeing on the total${differ ? `, ${differ} differing` : ""}), ` +
    `${created} do not and are what the cash account draws on until an invoice turns up`
  );
}

/**
 * The wholesalers the pharmacy actually buys from, as PioneerRx knows them.
 *
 * The owner: "can you use info you have to create suppliers we dont have in site and put in
 * everything we need". The site had five. PioneerRx carries eighteen with a catalogue or an invoice
 * behind them, including the one whose account number is on the payer payment report the pharmacy
 * receives every day — Buyline, 1722734, which is where that file's name comes from.
 *
 * Only suppliers with something behind them are created: a catalogue the pharmacy loads or an
 * invoice it has received this year. A wholesaler set up years ago and never used is a row nobody
 * wants, and the register is used to decide who to buy from.
 *
 * An existing supplier is never overwritten. Its account number, its sender addresses, its
 * minimums and its rebate flag were set by the owner or learned from real files, and PioneerRx's
 * copy of the same fact is not better evidence than the pharmacy's own. What this fills is blanks:
 * a supplier the site has but with no account number gets one, and nothing else moves.
 */
async function pullSuppliers(): Promise<string> {
  const { query } = await import("../src/lib/pioneer-sql");
  const r = await query(
    `select s.SupplierName as name,
            s.AccountNumber as account,
            s.EmailAddress as email,
            s.WebAddress as website,
            s.DeliveryTime as lead_days,
            (select count(*) from Supplier.CatalogItem c where c.SupplierID = s.SupplierID) as catalog_items,
            (select count(*) from Item.Invoice v where v.SupplierID = s.SupplierID and v.InvoiceDate >= '2026-01-01') as invoices
       from Supplier.Supplier s
      -- A real relationship, not a row somebody made once. A thousand catalogue lines means the
      -- pharmacy loads their price file; an invoice this year means it has actually bought from
      -- them. Without the bar this swept in 43, among them a supplier with one item, two spellings
      -- of the same laboratory, and the medical practice upstairs.
      where (select count(*) from Supplier.CatalogItem c where c.SupplierID = s.SupplierID) >= 1000
         or (select count(*) from Item.Invoice v where v.SupplierID = s.SupplierID and v.InvoiceDate >= '2026-01-01') > 0`,
    {},
    500,
  );
  if (r.rows.length === 0) return "PioneerRx lists no supplier with a catalogue or an invoice";

  const { db, schema } = await import("../src/db");
  const { newId } = await import("../src/lib/crypto");
  const { eq } = await import("drizzle-orm");
  const text = (v: unknown): string | null => {
    const t = String(v ?? "").trim();
    return t === "" ? null : t;
  };
  /*
   * Matched on a folded name, because the two systems spell them differently on purpose: the site
   * reads "Mckesson" off a catalogue file and PioneerRx says "McKesson"; "ParMed" and "Parmed" are
   * the same wholesaler. Aliases the owner has already recorded count too — that is what they are
   * for, and IPC is on the site as "Independent Pharmacy Cooperative" in exactly that field.
   */
  const fold = (n: string) => n.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const held = await db.query.suppliers.findMany();
  const byName = new Map<string, (typeof held)[number]>();
  for (const h of held) {
    byName.set(fold(h.name), h);
    for (const a of String(h.aliases ?? "").split(/[\n,]/)) if (a.trim()) byName.set(fold(a), h);
  }

  let created = 0;
  let filledIn = 0;
  const names: string[] = [];
  for (const row of r.rows) {
    const name = text(row.name);
    if (!name) continue;
    const account = text(row.account);
    const email = text(row.email);
    const website = text(row.website);
    const lead = Number(row.lead_days ?? 0) || null;
    const existing = byName.get(fold(name));
    if (existing) {
      // Blanks only. A figure the pharmacy set stands.
      const fill: Record<string, unknown> = {};
      if (!existing.accountNumber && account) fill.accountNumber = account;
      if (!existing.website && website) fill.website = website;
      if (!existing.leadTimeDays && lead) fill.leadTimeDays = lead;
      if (Object.keys(fill).length > 0) {
        await db.update(schema.suppliers).set({ ...fill, updatedAt: new Date().toISOString() }).where(eq(schema.suppliers.id, existing.id));
        filledIn++;
      }
      continue;
    }
    await db.insert(schema.suppliers).values({
      id: newId(),
      name,
      accountNumber: account ?? undefined,
      senderEmails: email ?? undefined,
      website: website ?? undefined,
      leadTimeDays: lead ?? undefined,
      active: true,
      notes: `Added from PioneerRx on ${new Date().toISOString().slice(0, 10)}: ${Number(row.catalog_items ?? 0).toLocaleString("en-US")} catalogue items, ${Number(row.invoices ?? 0)} invoices this year.`,
    });
    byName.set(fold(name), { id: "", name } as (typeof held)[number]);
    created++;
    names.push(name);
  }
  return `${created} suppliers added${names.length ? ` (${names.slice(0, 8).join(", ")}${names.length > 8 ? "…" : ""})` : ""}, ${filledIn} existing ones filled in`;
}

/**
 * What the front of shop took, which the books have never seen at all.
 *
 * The owner: "are we using all the info the site has? we cant miss anything or have bad logic." The
 * accrual account was carrying prescriptions and nothing else, and saying so — the System Sales
 * Summary has never been loaded, so retail and over-the-counter sales were missing entirely and
 * revenue, gross profit and net profit were all understated by whatever the counter took.
 *
 * PioneerRx's till has it, line by line, with the cost of each item beside the price. So both sides
 * are booked or neither: retail revenue with no cost against it is pure profit and would flatter
 * the margin by the whole cost of the front shop, which is a worse answer than the honest gap.
 *
 * Only the retail figures are written. The prescription columns are deliberately left empty so the
 * claims go on supplying that side, because they are complete and reconciled to the cent and the
 * till is neither — it records what was collected at the counter, not what was earned. The account
 * takes each half from the best source that has it (`profit-and-loss.ts`), which is what makes a
 * retail-only month safe to file.
 *
 * `ReferenceTypeEnum` says what a till line is, from PioneerRx's own list: 1 is a prescription,
 * 4 the payment against it, 5 a discount, 10 an account posting. 2 is Item — the front of shop —
 * and it is the only one taken here.
 */
async function pullRetail(): Promise<string> {
  const { query } = await import("../src/lib/pioneer-sql");
  const r = await query(
    /*
     * Items sold, less the discounts given on them.
     *
     * A discount is its own line on the till (reference type 5) and is not deducted from the item
     * line beside it, so counting the items alone overstates what the shop took. September's items
     * came to $2,331.07 and $216.00 of that was discounted away.
     *
     * Which discounts are retail is decided by the sale they belong to. A discount in a sale that
     * carried no prescription is a discount on the goods; one in a sale that also had a
     * prescription could have come off either, and is left out of retail rather than guessed at —
     * the safe direction, because it understates the front shop rather than the margin.
     */
    `with lines as (
        select convert(varchar(7), t.PostingDate, 23) as month,
               convert(varchar(10), t.PostingDate, 23) as day,
               d.ReferenceTypeEnum as ref,
               d.ExtendedPrice as amount,
               d.TotalCostForProfit as cost,
               d.DisplayTaxAmount as tax,
               case when exists (select 1 from PointOfSale.SaleTransactionDetail x
                                  where x.SaleTransactionID = d.SaleTransactionID
                                    and x.ReferenceTypeEnum = 1) then 1 else 0 end as with_rx
          from PointOfSale.SaleTransaction t
          join PointOfSale.SaleTransactionDetail d on d.SaleTransactionID = t.SaleTransactionID
         where t.PostingDate >= '2026-09-01'
           and d.ReferenceTypeEnum in (2, 5)
      )
      select month,
             min(day) as period_from,
             max(day) as period_to,
             sum(case when ref = 2 or with_rx = 0 then amount else 0 end) as retail,
             sum(case when ref = 2 then cost else 0 end) as cost,
             sum(case when ref = 2 or with_rx = 0 then tax else 0 end) as tax,
             sum(case when ref = 2 then 1 else 0 end) as lines,
             sum(case when ref = 5 and with_rx = 0 then amount else 0 end) as discounts
        from lines
       group by month`,
    {},
    100,
  );
  if (r.rows.length === 0) return "the till recorded no front-of-shop sales since 1 September";

  const { db, schema } = await import("../src/db");
  const { eq } = await import("drizzle-orm");
  const cents = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
  const written: string[] = [];
  for (const row of r.rows) {
    const month = String(row.month ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const retail = cents(row.retail);
    const cost = cents(row.cost);
    const tax = cents(row.tax);
    /*
     * A month already filed from the real report is not overwritten.
     *
     * The System Sales Summary is the pharmacy's own document and carries the whole till; this is a
     * reconstruction of one part of it. If somebody has filed the report, it wins.
     */
    const held = await db.query.salesMonths.findFirst({ where: eq(schema.salesMonths.month, month) });
    if (held && held.fileName && !held.fileName.startsWith("PioneerRx")) {
      written.push(`${month}: left alone, the Sales Summary is filed for it`);
      continue;
    }
    const values = {
      month,
      periodFrom: String(row.period_from ?? `${month}-01`),
      periodTo: String(row.period_to ?? `${month}-28`),
      retailCents: retail,
      retailTaxCents: tax,
      retailCostCents: cost,
      rowsJson: JSON.stringify([]),
      fileName: `PioneerRx till, front of shop, ${month}`,
      printedOn: new Date().toISOString().slice(0, 10),
      createdBy: "pioneer-pull",
      updatedAt: new Date().toISOString(),
    };
    if (held) await db.update(schema.salesMonths).set(values).where(eq(schema.salesMonths.month, month));
    else await db.insert(schema.salesMonths).values(values);
    written.push(`${month}: ${(Number(row.lines ?? 0)).toLocaleString("en-US")} lines, ${((retail ?? 0) / 100).toFixed(2)} taken after ${Math.abs(Number(row.discounts ?? 0)).toFixed(2)} of discounts, ${((cost ?? 0) / 100).toFixed(2)} of it cost`);
  }
  return written.join("; ");
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
