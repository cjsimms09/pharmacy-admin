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

type Feed = "on-hand" | "claims" | "catalogue";
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
        // Monday, or never pulled. 238,952 catalogue rows is the heavy one and the owner said weekly
        // is enough unless it turns out to be free.
        ...(new Date().getDay() === 1 || !s.pioneer_pull_catalogue_on ? (["catalogue"] as Feed[]) : []),
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
      } else if (feed === "catalogue") {
        const r = await pullCatalogue();
        await setSetting("pioneer_pull_catalogue_on", today);
        await setSetting("pioneer_pull_catalogue_result", `${new Date().toISOString()}: ${r}`);
        console.log(`catalogue: ${r} (${Date.now() - started}ms)`);
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await setSetting(feed === "on-hand" ? "pioneer_pull_on_hand_result" : feed === "claims" ? "pioneer_pull_claims_result" : "pioneer_pull_catalogue_result", `${new Date().toISOString()}: failed: ${why}`);
      console.error(`${feed}: failed: ${why}`);
    }
  }
}

/**
 * What is on the shelf this morning, from `Item.InventoryGroup` joined to the drug file.
 *
 * `OnHandQuantity` is PioneerRx's own running count in dispensing units — the same number the
 * balance-on-hand report prints, without waiting for somebody to run and email the report. Items
 * with no NDC are kept: the report carries them too, and three of them are real products.
 */
async function pullOnHand(): Promise<string> {
  const { query } = await import("../src/lib/pioneer-sql");
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
  const today = new Date().toISOString().slice(0, 10);
  const filed = await fileOnHand(buf, `PioneerRx on hand ${today}.txt`, { userId: "pioneer-pull" }, { countedOn: today });
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

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
