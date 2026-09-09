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

type Feed = "on-hand" | "claims" | "invoices" | "suppliers" | "catalogue";
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
        // Monday, or never pulled. 238,952 catalogue rows is the heavy one and the owner said weekly
        // is enough unless it turns out to be free.
        ...(new Date().getDay() === 1 || !s.pioneer_pull_catalogue_on ? (["suppliers", "catalogue"] as Feed[]) : []),
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
      } else if (feed === "suppliers") {
        const r = await pullSuppliers();
        await setSetting("pioneer_pull_suppliers_result", `${new Date().toISOString()}: ${r}`);
        console.log(`suppliers: ${r} (${Date.now() - started}ms)`);
      } else if (feed === "catalogue") {
        const r = await pullCatalogue();
        await setSetting("pioneer_pull_catalogue_on", today);
        await setSetting("pioneer_pull_catalogue_result", `${new Date().toISOString()}: ${r}`);
        console.log(`catalogue: ${r} (${Date.now() - started}ms)`);
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await setSetting(feed === "on-hand" ? "pioneer_pull_on_hand_result" : feed === "claims" ? "pioneer_pull_claims_result" : feed === "invoices" ? "pioneer_pull_invoices_result" : feed === "suppliers" ? "pioneer_pull_suppliers_result" : "pioneer_pull_catalogue_result", `${new Date().toISOString()}: failed: ${why}`);
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
            c.IngredientCostPaid as ingredient_paid,
            c.DispensingFeePaid as dispensing_fee,
            c.PatientPayAmountPaid as copay,
            c.GrossAmountPaid as gross_paid,
            c.OtherPayerAmountPaid as other_payer,
            c.EvoucherAmountPaid as evoucher,
            c.DirFeeTotal as dir_fee,
            c.AcquisitionCost as acquisition,
            p.IsPrimaryThirdParty as is_primary
       from Prescription.Claim c
       join ThirdParty.ClaimRemittancePricingByRxTransactionID p on p.ClaimID = c.ClaimID
       join Prescription.Transmission t on t.TransmissionID = c.TransmissionID
       join Prescription.RxTransaction rx on rx.RxTransactionID = c.RxTransactionID
       join Item.Item i on i.ItemID = rx.DispensedItemID
      where rx.DateFilled >= '2026-09-01'
        and p.IsLatestClaimRecord = 1
        and isnull(p.IsDuplicateClaim, 0) = 0
        and c.GrossAmountPaid is not null`,
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

  /*
   * One row per fill, with the two payer sides on it, because that is the shape the enrichment
   * takes. PioneerRx gives one row per claim and flags which side it is, so the fill is rebuilt by
   * grouping on prescription and refill.
   */
  const byFill = new Map<string, DispensedRow>();
  for (const row of r.rows) {
    const rxNumber = text(row.rx_number);
    if (!rxNumber) continue;
    const fillNumber = Number(row.fill_number ?? 0) || 0;
    const key = `${rxNumber}|${fillNumber}`;
    const side: PayerSide = {
      bin: text(row.bin),
      pcn: text(row.pcn),
      groupNumber: text(row.group_number),
      networkId: text(row.network_id),
      planId: text(row.plan_id),
      planCode: null,
      contractId: text(row.contract_id),
      remitCents: cents(row.gross_paid),
      copayCents: cents(row.copay),
      otherPayerAmountCents: cents(row.other_payer),
    };
    const held = byFill.get(key);
    const base: DispensedRow = held ?? {
      rxNumber,
      fillNumber,
      itemName: text(row.item_name),
      ndc11: ndc11(row.ndc),
      quantityThousandths: row.quantity === null || row.quantity === undefined ? null : Math.round(Number(row.quantity) * 1000),
      daysSupply: row.days_supply === null || row.days_supply === undefined ? null : Number(row.days_supply),
      daw: null,
      primary: side,
      secondary: null,
      awpCents: null,
      wacCents: null,
      nadacDispensedCents: null,
      acquisitionCents: cents(row.acquisition),
      dispensingFeeCents: cents(row.dispensing_fee),
      dirFeeCents: cents(row.dir_fee),
      evoucherCents: cents(row.evoucher),
      gcn: text(row.gcn),
      basisOfReimbursement: text(row.basis),
      basisOfCostDetermination: text(row.basis_of_cost),
      filledOn: text(row.date_filled),
      completedOn: null,
      netProfitCents: null,
    };
    if (!held) byFill.set(key, base);
    else if (Number(row.is_primary) === 1) base.primary = side;
    else base.secondary = side;
    if (held && Number(row.is_primary) === 1 && held.primary !== side) {
      // The primary row carries the fill's own facts; a secondary row must not overwrite them.
      base.basisOfReimbursement = text(row.basis) ?? base.basisOfReimbursement;
      base.dirFeeCents = cents(row.dir_fee) ?? base.dirFeeCents;
      base.evoucherCents = cents(row.evoucher) ?? base.evoucherCents;
    }
  }

  const { enrichClaimsFrom } = await import("../src/lib/dispensed-export");
  const stamp = `PioneerRx SQL @ ${new Date().toISOString().slice(0, 10)}`;
  const e = await enrichClaimsFrom([...byFill.values()], stamp);
  return `${e.rowsRead.toLocaleString("en-US")} fills read; ${e.primaryEnriched} primary and ${e.secondaryEnriched} secondary claims filled in, ${e.notOnFile} not on file${e.remitDiffers ? `, ${e.remitDiffers} where the remit disagrees` : ""}`;
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
  const { storeRawText } = await import("../src/lib/files");
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
    const existing = heldBy.get(inv.number.trim());
    if (existing) {
      alreadyHeld++;
      // The site's total is the amount due; goods plus shipping is that same figure from this side.
      if (existing.totalCents !== null && Math.abs(existing.totalCents - (goodsCents + inv.shippingCents)) > 2) {
        differ++;
        if (notes.length < 8) notes.push(`${inv.supplier} ${inv.number}: the site holds ${(existing.totalCents / 100).toFixed(2)}, PioneerRx has ${((goodsCents + inv.shippingCents) / 100).toFixed(2)}`);
      } else agree++;
      continue;
    }
    const two = inv.lines.some((l) => l.dea === "2");
    const lower = inv.lines.some((l) => l.dea === "3" || l.dea === "4" || l.dea === "5");
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
    const rendered = [
      `${inv.supplier} invoice ${inv.number}`,
      `Invoice date: ${inv.date}`,
      "",
      "Read from PioneerRx's receiving records, not from the supplier's own document.",
      "",
      ["NDC", "Description", "Qty", "Pack", "Unit cost", "Extended", "DEA"].join("\t"),
      ...inv.lines.map((l) =>
        [l.ndc11 ?? "", l.description ?? "", l.quantity, l.packSize ?? "", (l.unitCostCents / 100).toFixed(4), (l.extendedCents / 100).toFixed(2), l.dea && l.dea !== "0" ? `C-${l.dea}` : ""].join("\t"),
      ),
      "",
      `Goods: ${(goodsCents / 100).toFixed(2)}`,
      `Shipping: ${(inv.shippingCents / 100).toFixed(2)}`,
      `Total: ${((goodsCents + inv.shippingCents) / 100).toFixed(2)}`,
    ].join("\n");
    const stored = await storeRawText(rendered);
    const documentId = newId();
    const invoiceId = newId();
    await db.insert(schema.documents).values({
      id: documentId,
      category: two ? "invoice_schedule_2" : lower ? "invoice_schedule_3_5" : "invoice",
      title: `${inv.supplier} invoice ${inv.number} (from PioneerRx)`,
      fileName: `${inv.supplier} ${inv.number}.txt`,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      notes: "Rendered from PioneerRx's own receiving records on the morning pull.",
      uploadedBy: "pioneer-pull",
    });
    await db.insert(schema.supplierInvoices).values({
      id: invoiceId,
      documentId,
      supplier: inv.supplier,
      supplierId: supplierId.get(fold(inv.supplier)) ?? null,
      invoiceNumber: inv.number,
      invoiceDate: inv.date,
      schedule: two ? "schedule_2" : lower ? "schedule_3_5" : "none",
      basis: two || lower ? "PioneerRx records a controlled item on this invoice." : "PioneerRx records no controlled item on this invoice.",
      controlledItems: JSON.stringify(inv.lines.filter((l) => l.dea && l.dea !== "0").map((l) => `${l.description ?? l.ndc11 ?? "?"} (C-${l.dea})`)),
      receivedFrom: "PioneerRx (SQL)",
      totalCents: goodsCents + inv.shippingCents,
      linesRead: inv.lines.length,
      linesUnread: 0,
      receiptNote: "Read from PioneerRx's own receiving records rather than from the supplier's document. The supplier's invoice is the record; this is the purchase.",
    });
    const rows = inv.lines
      .map((l) => ({
        id: newId(),
        invoiceId,
        supplier: inv.supplier,
        supplierId: supplierId.get(fold(inv.supplier)) ?? null,
        invoiceDate: inv.date,
        ndc11: l.ndc11 ?? "",
        description: l.description,
        itemNumber: null,
        quantity: l.quantity,
        unitOfMeasure: l.packSize,
        unitCostCents: l.unitCostCents,
        extendedCents: l.extendedCents,
        awpCents: null,
        itemClass: l.dea && l.dea !== "0" ? `C-${l.dea}` : null,
        rebated: null,
        controlled: l.dea === "2" ? true : l.dea && l.dea !== "0" ? false : null,
      }))
      .filter((x) => x.ndc11 !== "");
    for (let i = 0; i < rows.length; i += 200) await db.insert(schema.invoiceLines).values(rows.slice(i, i + 200));
    created++;
  }
  const { setSetting } = await import("../src/lib/settings");
  await setSetting("pioneer_invoice_compare", JSON.stringify({ readAt: new Date().toISOString(), invoices: invoices.size, created, alreadyHeld, agree, differ, notes }));
  return `${invoices.size} September invoices in PioneerRx: ${created} brought in, ${alreadyHeld} the site already held (${agree} agreeing on the total, ${differ} differing)`;
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

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
