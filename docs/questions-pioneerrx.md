# Questions for PioneerRx support and Data Programs

Contact for API/data access: PioneerRxDataPrograms@PioneerRx.com. Ask support for the rest.
Record answers inline; they drive the ordering and ingestion design.

## Ordering and receiving
1. Which wholesalers support electronic ordering (850) and electronic receiving (855/856/810) natively in our version? Specifically: McKesson, Cardinal, Cencora, Smith Drug, Morris & Dickson, Anda, ParMed, IPC, IPD, BluPax, Integral Rx.
2. What is the Supplier/Wholesaler setup screen and its fields (account number, EDI IDs, transport)? Is EDI brokered through PioneerRx's gateway or configured per pharmacy?
3. Does an 832 price/catalog update apply wholesaler cost to items? Which cost fields (last cost, acquisition cost) update on 810 receipt?
4. Is there ANY way to import a purchase order (CSV/XLSX/API/mobile app), or to paste NDC + quantity into a PO? Can a PO be created from a saved item list or Inventory Worksheet?
5. If we order outside PioneerRx (wholesaler portal, EDI from our own system, RxMarket, SureCost), will the wholesaler's 856/810 create and receive a PO automatically? How are unmatched invoices handled?
6. RxMarket: when does PioneerRx integration ship; will orders create POs and receiving records; is there a pharmacy-facing price/availability file or API; supplier fees?

## Data out
7. Scheduled Reports: delivery channels (email, network folder, SFTP), formats (CSV/XLSX/PDF), frequencies, and the permission required.
8. Report Designer: list of data sources/tables; can a custom tabular report export CSV/XLSX and be scheduled?
9. Is read-only SQL Server (or ODBC/Power BI) access granted to pharmacies or their contractors? On what terms?
10. Enterprise API: full method list. Are there methods for items/inventory on-hand, purchase orders, receiving, third-party claims, 835/reconciliation? Data Programs agreement cost, timeline, per-pharmacy provisioning.
11. Rx Event API: list of event types and payload fields; can it point at a pharmacy-owned endpoint?

## Reconciliation and returns
12. Third Party Reconciliation: which switches/PSAOs auto-deliver 835s; is there a manual 835 import; can unreconciled/aged claims, remittance detail, and fee detail be exported; Reconciliation Service Plan pricing.
13. Recommended Returns: exact criteria fields and export; supplier-return (RMA) workflow and credit tracking.

## Security and administration
14. Can we create a reports-only user role? Is there an exportable user-activity/audit log?
15. Interface fees for connecting a third-party app; can a pharmacy-built app be a "Connected Vendor"?

## Also confirm from inside PioneerRx (no call needed)
- System ▸ Report Design: which reports can be made tabular with our column lists (see PLAN.md section 5).
- Any search grid: Menu ▸ Export to Excel with a saved Expanded layout works as a manual fallback for every feed.
