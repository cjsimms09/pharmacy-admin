# Questions for each supplier rep

Goal: find the most automated *sanctioned* way to submit orders and receive confirmations. Never portal automation: McKesson's and Cardinal's terms explicitly prohibit bots/scrapers, and we assume the others do too.

## McKesson (account rep → E-Commerce Services / Third Party Interfaces)
1. Enable McKesson Connect **Data Exchange**: Purchase Order Import, Price/Product Export, Invoice/Receipt Export. Send the PO Import file spec (required columns, delimiters, limits) and confirm the "Save As" import-format template.
2. Can Price/Product Export and Invoice Export be **scheduled** and delivered to an SFTP we control, or only downloaded manually?
3. Direct **EDI** for a single store: 850/855/856/810/832 (and 846/852 if offered). Transport (AS2/SFTP/VAN), testing process, fees, timeline, ISA/GS identifiers.
4. If we send 850s from our own system, do 810 invoices still flow to PioneerRx unchanged? Any impact on the PioneerRx connection?
5. 12-month **invoice line history** export (for contract replay). Current PVA / OneStop rebate schedule in writing, measurement period, and which programs count in the numerator/denominator.

## Anda (1-800-331-2632; EDI provisioned by Anda IT)
1. EDI 850 + 997 (required) and 855/856/820/860 (optional): onboarding steps, transport, fees, timeline.
2. Any daily price/availability file (832/846 or CSV) a pharmacy can receive automatically.
3. Order-upload file format in Anda Online, if any (columns, limits).
4. Written terms of use for Anda Online regarding automated access.

## ParMed / Cardinal (Cardinal EDI: GMB-DUB-eCommerce@cardinalhealth.com, 800-326-6457 opt 3→3)
1. Does ParMed support Cardinal's **Automated Purchase Order Import (APOI)** or Order Express EDI 850/855/856/810/832? File spec for APOI.
2. Any price/availability file delivered automatically.
3. Where ParMed's web terms live and whether they permit file import tooling.

## IPC (608-478-1099, member.services@ipcrx.com)
1. "EDI ordering through pharmacy management systems": what exactly is supported for IPC Warehouse (850/855/856/810/832), and can a pharmacy-owned system connect?
2. Price/availability file for IPC Warehouse items; order-upload format in order.ipcrx.com.
3. How Pharmacy Select (RTL2) purchases through McKesson are reported to us, and how IPC rebates are calculated and paid.
4. Whether IPC's SureCost arrangement is the intended data path, and its cost.

## IPD (1-877-690-0473, info@ipdpharma.com)
1. Any price list export or feed (CSV/832), any order upload format, any EDI.
2. Their terms say "personal and non-commercial" use of the site: confirm what tooling is acceptable for a customer.

## Alternatives for the contract replay (ask each for a proposal on our 12-month history)
- Cardinal Health (Order Express; EDI 850/855/856/810/832/852/867; APOI)
- Cencora / AmerisourceBergen (ABC Order; EDI 850/855/856/810; Customer Systems 1-888-711-5469)
- Smith Drug, Morris & Dickson (EDI via provider partners; ask for direct terms)
