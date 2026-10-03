# PioneerRx over SQL: the tables that matter

Read from `PIONEERSERVER\NEWTECH`, database `PioneerPharmacySystem_DayOld`, on 9 September 2026.
2,570 tables, 22,795 columns, SQL Server 2019. The full catalogue is on the pharmacy computer at
`data/pioneer-schema.json` — names, types and row counts only, no value from any row. This file is
the part worth knowing, so a query can be written from the cloud without guessing a table name.

**The database is a day-old copy.** Nothing written here reaches the live system, and the site only
ever reads: read-only intent, `READ UNCOMMITTED`, one SELECT at a time (`src/lib/pioneer-sql.ts`).

## The rule about patient data

Every table under `Person.` holds patients, and several elsewhere carry a name or an address. **No
feed selects from `Person.`, and no query returns a name, address, date of birth, phone number or
prescriber identifier.** Where fills have to be tied together across time, the patient is a hashed
key computed in the query and never the id itself. The pharmacy has no business associate agreement
covering this session, so the rule is absolute rather than a preference: the reports read drugs,
money, plans and stock.

`Prescription.Claim` and `Prescription.RxTransaction` carry pharmacist names (`PharmacistLastName`,
`PharmacistFirstName`, `FilledBy`) as well. Staff are not patients, but they are people, and nothing
the site needs is answered by knowing which technician typed a claim. Leave them out.

## Claims and fills

| Table | Rows | What it is |
|---|---|---|
| `Prescription.Claim` | 739,209 | One row per adjudication attempt, 194 columns |
| `Prescription.RxTransaction` | 379,219 | One row per fill, 173 columns |
| `Prescription.Transmission` | 739,215 | The transmission each claim went out on |
| `ThirdParty.ClaimRemittancePricingByRxTransactionID` | 698,473 | What each claim was actually paid, by fill |
| `Prescription.RxTransactionFinancial` | 379,249 | The fill's money in eight columns |

`Prescription.Claim` carries everything the daily export does and a good deal it does not:

- Money: `IngredientCostSubmitted`, `IngredientCostPaid`, `DispensingFeeSubmitted`,
  `DispensingFeePaid`, `GrossAmountPaid`, `PatientPayAmountPaid`, `IncentiveAmountPaid`,
  `OtherAmountPaid`, `NetToPharmacyCalc`, `AcquisitionCost`, `UsualAndCustomaryFeeSubmitted`
- **`BasisOfReimbursementDetermination`** — NCPDP 522-FM, how the plan actually priced the claim.
  The single most useful field in the whole database for the backtest: without it, MAC-priced claims
  are measured against AWP formulas and reported as breaches that never happened.
- `BasisOfCost`, `DirFeeTotal`, `ContractNumber`, `AuthorizationNumber`
- Vouchers: `EvoucherPresent`, `EvoucherAmountPaid`, `EvoucherMessage`, `EvoucherAmountFromMessage`
- Secondary: `OtherPayerAmountPaid`, `OtherPayerAmountPaidQualifier`, `OtherPayerDate`,
  `OtherPayerAmountPaidResponseXml`
- Identity: `RxNumber`, `NumberOfRefillsFilled`, `NDC`, `DispensedQuantity`, `DaysSupply`,
  `DawCodeID`, `TransactionResponseStatus`, `RxTransactionStatusTypeEnum`

`ThirdParty.ClaimRemittancePricingByRxTransactionID` is where a claim meets its money and its plan:
`Bin`, `ThirdPartyID`, `NetAmountPaid`, `IngredientCostPaid`, `DispensingFeePaid`,
`PatientPayAmount`, `DateFilled`, `TransmittedDate`, and four flags that settle which row counts —
`IsLatestClaimRecord`, `IsLastValidClaimForPayMethod`, `IsDuplicateClaim`, `IsPrimaryThirdParty` —
plus `ReversalForClaimID` and `PreviousClaimID`, which are how a reversal finds what it reversed.

**Those flags matter more than they look.** A fill can have several claim rows: a rejection, a
retransmission, a reversal, a primary and a secondary. Counting them all double-counts the money.
`IsLatestClaimRecord` and `IsPrimaryThirdParty` are PioneerRx's own answer to which row is the one.

## Plans, BINs and networks

| Table | Rows | What it is |
|---|---|---|
| `ThirdParty.ThirdPartyPlan` | 1,851 | `PlanName`, `BIN`, `PCN`, `CcPCN`, `DefaultGroupNumber`, `CarrierCode`, `Processor`, `IsActive` |
| `ThirdParty.ThirdParty` | 286 | The payer: `ThirdPartyName`, `BIN`, `PCN`, `PlanGroupCode`, `BrandPricingMethodID`, `GenericPricingMethodID` |

This is the chain the owner asked for — payer to BIN to group to network to contract — held by
PioneerRx itself rather than deduced from claims. 1,851 plans against the 597 BINs the site learned
from the PBM listing, and each with the group number and processor beside it.

## The drug file

| Table | Rows | What it is |
|---|---|---|
| `Item.Item` | 12,049 | The pharmacy's own drug file, 126 columns |
| `Item.InventoryGroup` | 13,233 | What is on the shelf and what it cost, 70 columns |
| `Item.ItemSupplierCatalogItem` | 60,982 | Supplier catalogue lines against items |

`Item.Item` holds `NDC`, `UPC`, `ItemName`, `Manufacturer`, `DeaSchedule`, `GCN`, `HICL`,
`BrandEquivalentNDC`, `Strength`, `StockSize`, `DosageFormID`, `DispensingUnitID`, `UnitsPerLabel`,
and the prices: `AWP`, `AWPChangedDate`, `MAC`, `MACChangedDate`, `MSRP`, `LastCostPaid`.

**`BrandEquivalentNDC` and `GCN` are the equivalence keys the site currently derives from the FDA
directory.** Worth setting one against the other rather than replacing: they will disagree, and
where they disagree is exactly where a buying recommendation could be wrong.

`Item.InventoryGroup` is the shelf: `OnHandQuantity`, `OnHandQuantityChangedOn`, `OnOrderQuantity`,
`LastCostPaid`, `LastCostPaidDate`, `PreferredCost`, `AverageReceivedCost`, `WAC`, `Awp`,
`ReorderMethodID`, `PreferredSupplierID`, `ShelfStickerPrice`, `MinimumPrice`.

## Purchasing, and the invoices the site currently reads from PDFs

| Table | Rows | What it is |
|---|---|---|
| `Item.Invoice` | 17,096 | `InvoiceNumber`, `InvoiceDate`, `SupplierID`, `ShippingCost`, `ReceivedBy`, `ReceivedElectronically` |
| `Item.InvoiceDetail` | 121,159 | `ItemID`, `InvoiceQuantity`, `InvoiceCostPerUnit`, `InvoiceTotalCost`, `ReceivedQuantity`, pack size as it was |
| `Item.PurchaseOrderDetail` | 121,553 | What was ordered |
| `Item.InventoryGroupOnHandHistory` | 195,518 | On-hand over time |

This is the same purchase history the site is reading out of emailed PDFs, already parsed, with the
shipping cost separated from the goods and the pack size recorded as it stood on the day. It does
not replace reading the PDFs — the paper invoice is the record the DEA asks for, and IPD's
Schedule II half has to stay separable — but it is the check on them, and it reaches back further
than the pharmacy's email does.

## Remittances

| Table | Rows | What it is |
|---|---|---|
| `Reconciliation.RemittanceAdviceTransactionDetail` | 45,883 | `RxNumber`, `PayerClaimControlNumber`, `ClaimStatusCode`, `TotalSubmitted`, `TotalPaid`, `Copay`, `ServiceDate` |
| `Reconciliation.RemittanceAdviceTransactionDetailAdjustment` | 174,728 | The adjustment lines |

PioneerRx has been receiving and storing 835s all along. `ClaimStatusCode` is the same CLP02 the
site's own reader uses, so a payment already recorded here can be set against one the site read from
a file — which is the cheapest possible proof that the 835 path is reading them correctly.

## The order the feeds should be written in

1. **Claims.** `Prescription.Claim` joined to `ThirdParty.ClaimRemittancePricingByRxTransactionID`
   on the latest, primary, non-duplicate row, from 1 September 2026. Proved against the daily text
   report for the same day, on the same day, before it replaces anything.
2. **Plans.** `ThirdParty.ThirdPartyPlan` and `ThirdParty.ThirdParty` — the linking chain, once.
3. **The drug file.** `Item.Item` and `Item.InventoryGroup` — AWP, MAC, WAC and the equivalence
   keys, set against the FDA directory rather than replacing it.
4. **On hand and order points.** Nightly, replacing the balance-on-hand report.
5. **Purchase invoices.** As the check on the PDF readings, not as a replacement for them.

Each lands beside the reader it replaces and proves itself the same way (SESSION-RULES §1c). None of
them is written until the one before it is proved, because a feed that silently disagrees with the
file it replaced is worse than no feed at all.
